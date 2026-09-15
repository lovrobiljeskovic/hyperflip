import { loadDeployment } from "../../registry/deployment.mjs";
import { config as loadDotenv } from "dotenv";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAddress, type Address } from "viem";
import { parseMarkets, type MarketInfo } from "./markets.js";
import { BPS, parseDecimalToUnits } from "./pure.js";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../.env") });

export { parseMarkets } from "./markets.js";
export type { MarketInfo } from "./markets.js";

export interface WriterConfig {
  chainId: number;
  rpcUrl: string;
  parlayVault: Address;
  writerAddress: Address;
  quoteSignerKey: `0x${string}`;
  pokerKey: `0x${string}`;
  infoApiUrl: string;
  quoteJournalFile: string;
  port: number;
  edgeBps: bigint;
  minPremiumBps: bigint;
  minLegs: number;
  maxStake: bigint;
  perMarketCap: bigint;
  perClusterCap: bigint;
  // Invite codes share a reservation budget; wallet rotation cannot reset it.
  perCodeReservedCap: bigint;
  legEdgeBps: bigint;
  quoteTtlMs: number;
  spotPxStaleMs: number;
  minBookDepthWad: bigint;
  lockoutMs: number;
  pokerIntervalMs: number;
  deployBlock: bigint;
  markets: Map<string, MarketInfo>;
  registryJson: string;
  inviteCodes: Set<string>;
  resendApiKey?: string;
  waitlistFile: string;
  parlayIndexFile?: string;
  parlayIndexFromBlock?: bigint;
  corsOrigins: string[];
}


function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

function requireKey(name: string): `0x${string}` {
  const v = requireEnv(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte hex string`);
  }
  return v as `0x${string}`;
}

function requireAddress(name: string): Address {
  const v = requireEnv(name);
  if (!isAddress(v)) throw new Error(`${name} is not a valid address`);
  return v;
}

export function parseInviteCodes(raw: string): Set<string> {
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

export const DEFAULT_CORS_ORIGINS =
  "https://hyperflip.xyz,https://www.hyperflip.xyz,https://app.hyperflip.xyz,https://overround.xyz,https://overround-wine.vercel.app";

export function parseCorsOrigins(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function defaultPerCodeReservedCap(maxStake: bigint, minPremiumBps: bigint): bigint {
  // Allow three maximum-risk quotes while the mint watcher catches up.
  return maxStake * (BPS / minPremiumBps - 1n) * 3n;
}

export function syncedPerCodeReservedCap(
  envWasSet: boolean,
  current: bigint,
  maxStake: bigint,
  chainMinPremiumBps: bigint,
): bigint {
  return envWasSet ? current : defaultPerCodeReservedCap(maxStake, chainMinPremiumBps);
}

export function loadConfig(): WriterConfig {
  if (process.env.PRICING_MODE && process.env.PRICING_MODE !== "independent") {
    throw new Error("PRICING_MODE must be independent or unset for sports pricing");
  }
  const registry = JSON.parse(readFileSync(path.resolve(here, "../..", requireEnv("MARKETS_FILE")), "utf8"));
  const markets = parseMarkets(JSON.stringify(registry));
  // Keep historical settlement metadata on disk; expose only sports to the app.
  const registryJson = JSON.stringify(Array.isArray(registry) ? registry : {
    ...registry, archived: (registry.archived ?? []).filter((market: { category?: string }) => market.category === "sports"),
  });
  const maxStake = BigInt(requireEnv("MAX_STAKE"));
  const minPremiumBps = BigInt(process.env.MIN_PREMIUM_BPS ?? 100);
  const spotPxStaleMsRaw = Number(process.env.SPOT_PX_STALE_MS ?? 60_000);
  if (!Number.isFinite(spotPxStaleMsRaw)) {
    throw new Error("SPOT_PX_STALE_MS must be a finite number");
  }
  // Zero explicitly disables freshness checks on testnet.
  const spotPxStaleMs = spotPxStaleMsRaw === 0 ? Infinity : spotPxStaleMsRaw;
  const pokerIntervalMs = Number(process.env.POKER_INTERVAL_MS ?? 15_000);
  if (!Number.isFinite(pokerIntervalMs) || pokerIntervalMs <= 0) throw new Error("POKER_INTERVAL_MS must be positive");
  return {
    ...loadDeployment(),
    markets,
    registryJson,
    infoApiUrl: process.env.INFO_API_URL ?? "https://api.hyperliquid-testnet.xyz/info",
    quoteJournalFile: path.resolve(here, "../..", process.env.QUOTE_JOURNAL_FILE ?? "writer/quotes.jsonl"),
    rpcUrl: process.env.WRITER_RPC || requireEnv("TESTNET_RPC"),
    writerAddress: requireAddress("WRITER_ADDRESS"),
    quoteSignerKey: requireKey("QUOTE_SIGNER_PRIVATE_KEY"),
    pokerKey: requireKey("POKER_PRIVATE_KEY"),
    port: Number(process.env.WRITER_PORT ?? 8787),
    edgeBps: BigInt(process.env.EDGE_BPS ?? 500),
    minPremiumBps,
    minLegs: Number(process.env.MIN_LEGS ?? 2),
    maxStake,
    perMarketCap: BigInt(requireEnv("PER_MARKET_CAP")),
    perClusterCap: BigInt(requireEnv("PER_CLUSTER_CAP")),
    perCodeReservedCap: process.env.PER_CODE_RESERVED_CAP
      ? BigInt(process.env.PER_CODE_RESERVED_CAP)
      : defaultPerCodeReservedCap(maxStake, minPremiumBps),
    legEdgeBps: BigInt(process.env.LEG_EDGE_BPS ?? 300),
    quoteTtlMs: Number(process.env.QUOTE_TTL_MS ?? 30_000),
    spotPxStaleMs,
    // ponytail: testnet depth floor; measure liquidity before a real-money launch.
    minBookDepthWad: parseDecimalToUnits(process.env.MIN_BOOK_DEPTH ?? "50", 18),
    lockoutMs: Number(process.env.LOCKOUT_MS ?? 600_000),
    pokerIntervalMs,
    inviteCodes: parseInviteCodes(requireEnv("INVITE_CODES")),
    resendApiKey: process.env.RESEND_API_KEY,
    waitlistFile: path.resolve(here, "../..", process.env.WAITLIST_FILE ?? "writer/waitlist.json"),
    parlayIndexFile: path.resolve(here, "../..", process.env.PARLAY_INDEX_FILE ?? "writer/parlays.json"),
    parlayIndexFromBlock: process.env.PARLAY_INDEX_FROM_BLOCK ? BigInt(process.env.PARLAY_INDEX_FROM_BLOCK) : undefined,
    corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS ?? DEFAULT_CORS_ORIGINS),
  };
}
