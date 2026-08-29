import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, win32 } from "node:path";
import { parseCorrelations } from "../correlation.js";
import { parseMarkets } from "../markets.js";
import { canonicalJson, sha256 } from "./store.js";
import { parseSourceRegistry, type ResearchNetwork, type SourceRegistry } from "./types.js";

export type { ResearchNetwork } from "./types.js";

export interface ResearchNetworkProfile {
  schemaVersion: 1;
  network: ResearchNetwork;
  infoApiUrl: string;
  evmChainId: number;
  sourceRegistryFile: string;
  marketRegistryFile: string;
  deploymentRegistryFile: string;
  baselineCorrelationFile: string;
}

export interface DeploymentRegistry {
  schemaVersion: 1;
  network: ResearchNetwork;
  evmChainId: number;
  parlayVault: `0x${string}`;
  parlayDeployBlock: string;
}

export interface LoadedResearchNetworkProfile {
  profile: ResearchNetworkProfile;
  profileSha256: string;
  sources: SourceRegistry;
  sourceRegistrySha256: string;
  marketRegistryRaw: string;
  marketRegistrySha256: string;
  deployment: DeploymentRegistry;
  deploymentRegistrySha256: string;
  baselineCorrelationRaw: string;
  baselineCorrelationSha256: string;
}

const ENABLED_RESEARCH_NETWORKS = new Set<ResearchNetwork>(["testnet"]);

const INFO_HOSTS: Record<ResearchNetwork, string> = {
  testnet: "api.hyperliquid-testnet.xyz",
  mainnet: "api.hyperliquid.xyz",
};

function parseJson(raw: string, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`${label} must be a JSON object`);
  }
}

function exactKeys(value: Record<string, unknown>, label: string, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) throw new Error(`${label} has invalid keys`);
}

function parseNetwork(value: unknown, label: string): ResearchNetwork {
  if (value !== "testnet" && value !== "mainnet") throw new Error(`${label} must be testnet or mainnet`);
  return value;
}

function readRegistry(profileFile: string, filename: string): string {
  if (!filename || isAbsolute(filename) || win32.isAbsolute(filename) || basename(filename) !== filename || filename.includes("..")) {
    throw new Error("registry path must be a relative filename");
  }
  return readFileSync(resolve(dirname(profileFile), filename), "utf8");
}

function parseProfile(raw: string): ResearchNetworkProfile {
  const profile = parseJson(raw, "research network profile");
  exactKeys(profile, "research network profile", ["schemaVersion", "network", "infoApiUrl", "evmChainId", "sourceRegistryFile", "marketRegistryFile", "deploymentRegistryFile", "baselineCorrelationFile"]);
  if (profile.schemaVersion !== 1) throw new Error("research network profile schemaVersion must be 1");
  const network = parseNetwork(profile.network, "research network profile network");
  if (!ENABLED_RESEARCH_NETWORKS.has(network)) throw new Error(`network ${network} is not enabled`);
  if (typeof profile.infoApiUrl !== "string") throw new Error("research network profile Info API URL must be a string");
  let infoUrl: URL;
  try {
    infoUrl = new URL(profile.infoApiUrl);
  } catch {
    throw new Error("research network profile Info API URL must be valid");
  }
  if (infoUrl.protocol !== "https:" || infoUrl.hostname !== INFO_HOSTS[network] || infoUrl.pathname !== "/info" || infoUrl.search || infoUrl.hash) {
    throw new Error(`${network} Info API hostname must be ${INFO_HOSTS[network]}`);
  }
  if (!Number.isSafeInteger(profile.evmChainId) || profile.evmChainId !== 998) throw new Error("testnet EVM chain ID must be 998");
  const filenames = ["sourceRegistryFile", "marketRegistryFile", "deploymentRegistryFile", "baselineCorrelationFile"] as const;
  for (const key of filenames) if (typeof profile[key] !== "string") throw new Error(`${key} must be a relative filename`);
  return { schemaVersion: 1, network, infoApiUrl: profile.infoApiUrl, evmChainId: profile.evmChainId, sourceRegistryFile: profile.sourceRegistryFile as string, marketRegistryFile: profile.marketRegistryFile as string, deploymentRegistryFile: profile.deploymentRegistryFile as string, baselineCorrelationFile: profile.baselineCorrelationFile as string };
}

function registryNetwork(raw: string, label: string, network: ResearchNetwork): Record<string, unknown> {
  const registry = parseJson(raw, label);
  if (registry.network !== network) throw new Error(`${label} network must be ${network}`);
  return registry;
}

function parseDeployment(raw: string, network: ResearchNetwork, evmChainId: number): DeploymentRegistry {
  const deployment = registryNetwork(raw, "deployment registry", network);
  exactKeys(deployment, "deployment registry", ["schemaVersion", "network", "evmChainId", "parlayVault", "parlayDeployBlock"]);
  if (deployment.schemaVersion !== 1) throw new Error("deployment registry schemaVersion must be 1");
  if (deployment.evmChainId !== evmChainId) throw new Error("deployment registry EVM chain ID must match profile");
  if (typeof deployment.parlayVault !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(deployment.parlayVault)) throw new Error("deployment registry parlayVault must be an address");
  if (typeof deployment.parlayDeployBlock !== "string" || !/^\d+$/.test(deployment.parlayDeployBlock)) throw new Error("deployment registry parlayDeployBlock must be a decimal block number");
  return { schemaVersion: 1, network, evmChainId, parlayVault: deployment.parlayVault as `0x${string}`, parlayDeployBlock: deployment.parlayDeployBlock };
}

export function loadResearchNetworkProfile(profileFile: string): LoadedResearchNetworkProfile {
  const profileRaw = readFileSync(profileFile, "utf8");
  const profile = parseProfile(profileRaw);
  const sourceRaw = readRegistry(profileFile, profile.sourceRegistryFile);
  const marketRaw = readRegistry(profileFile, profile.marketRegistryFile);
  const deploymentRaw = readRegistry(profileFile, profile.deploymentRegistryFile);
  const correlationRaw = readRegistry(profileFile, profile.baselineCorrelationFile);
  registryNetwork(sourceRaw, "source registry", profile.network);
  registryNetwork(marketRaw, "market registry", profile.network);
  const correlationRegistry = registryNetwork(correlationRaw, "correlation registry", profile.network);
  if (correlationRegistry.fallbackReason !== "operator-reviewed-testnet-bootstrap") {
    throw new Error("correlation registry fallbackReason must be operator-reviewed-testnet-bootstrap");
  }
  const sources = parseSourceRegistry(sourceRaw);
  parseMarkets(marketRaw);
  parseCorrelations(correlationRaw);
  const deployment = parseDeployment(deploymentRaw, profile.network, profile.evmChainId);
  const sourceCanonical = canonicalJson(JSON.parse(sourceRaw));
  const marketCanonical = canonicalJson(JSON.parse(marketRaw));
  const deploymentCanonical = canonicalJson(JSON.parse(deploymentRaw));
  const correlationCanonical = canonicalJson(JSON.parse(correlationRaw));
  return {
    profile,
    profileSha256: sha256(canonicalJson(JSON.parse(profileRaw))),
    sources,
    sourceRegistrySha256: sha256(sourceCanonical),
    marketRegistryRaw: marketCanonical,
    marketRegistrySha256: sha256(marketCanonical),
    deployment,
    deploymentRegistrySha256: sha256(deploymentCanonical),
    baselineCorrelationRaw: correlationCanonical,
    baselineCorrelationSha256: sha256(correlationCanonical),
  };
}
