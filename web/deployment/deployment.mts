import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface Deployment {
  chainId: number;
  chainName: string;
  /** Chain holding the OutcomeVaults (HyperCore accounts): 998 on testnet. Equals chainId when
   * the ParlayVault is on HyperEVM; differs when it is on Elysium. */
  coreChainId: number;
  parlayVault: `0x${string}`;
  deployBlock: bigint;
  /** HyperEVM SettlementRelay and Orbit Inbox; present only when chainId !== coreChainId. */
  settlementRelay?: `0x${string}`;
  inbox?: `0x${string}`;
}

const CHAINS: Record<number, string> = { 998: "HyperEVM Testnet", 99801: "Elysium Testnet" };
const CORE_CHAIN_ID = 998;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const isAddress = (v: unknown): v is string => typeof v === "string" && ADDRESS.test(v) && !/^0x0{40}$/.test(v);

export function loadDeployment(env: Record<string, string | undefined> = process.env, frontend = false): Deployment {
  if (env.DEPLOYMENT_FILE && !isAbsolute(env.DEPLOYMENT_FILE)) {
    throw new Error("DEPLOYMENT_FILE must be an absolute path");
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(env.DEPLOYMENT_FILE || new URL("./deployment.testnet.json", import.meta.url), "utf8"));
  } catch {
    throw new Error("Cannot read deployment manifest; check DEPLOYMENT_FILE and file permissions");
  }
  if (!manifest || manifest.schemaVersion !== 1 || manifest.network !== "testnet" || !CHAINS[manifest.evmChainId]) {
    throw new Error("Deployment manifest must select HyperEVM testnet (998) or Elysium testnet (99801), schemaVersion 1");
  }
  if (!isAddress(manifest.parlayVault)) {
    throw new Error("Deployment manifest has an invalid parlayVault");
  }
  if (typeof manifest.parlayDeployBlock !== "string" || !/^[1-9][0-9]*$/.test(manifest.parlayDeployBlock)) {
    throw new Error("Deployment manifest requires a positive decimal parlayDeployBlock");
  }
  const coreChainId = manifest.coreChainId ?? manifest.evmChainId;
  if (coreChainId !== CORE_CHAIN_ID) throw new Error("Deployment manifest coreChainId must be HyperEVM testnet (998)");
  const bridged = manifest.evmChainId !== coreChainId;
  if (bridged && (!isAddress(manifest.settlementRelay) || !isAddress(manifest.inbox))) {
    throw new Error("Deployment manifest on Elysium requires settlementRelay and inbox addresses on HyperEVM");
  }
  const settings = frontend
    ? { NEXT_PUBLIC_CHAIN_ID: String(manifest.evmChainId), NEXT_PUBLIC_PARLAY_VAULT: manifest.parlayVault, NEXT_PUBLIC_PARLAY_DEPLOY_BLOCK: manifest.parlayDeployBlock }
    : { EVM_CHAIN_ID: String(manifest.evmChainId), PARLAY_VAULT_ADDRESS: manifest.parlayVault, PARLAY_DEPLOY_BLOCK: manifest.parlayDeployBlock };
  for (const [name, value] of Object.entries(settings)) {
    if (env[name] && env[name].toLowerCase() !== value.toLowerCase()) {
      throw new Error(`${name} disagrees with deployment manifest; select an explicit DEPLOYMENT_FILE for another deployment`);
    }
  }
  return {
    chainId: manifest.evmChainId,
    chainName: CHAINS[manifest.evmChainId],
    coreChainId,
    parlayVault: manifest.parlayVault.toLowerCase() as `0x${string}`,
    deployBlock: BigInt(manifest.parlayDeployBlock),
    ...(bridged ? {
      settlementRelay: manifest.settlementRelay.toLowerCase() as `0x${string}`,
      inbox: manifest.inbox.toLowerCase() as `0x${string}`,
    } : {}),
  };
}

export async function verifyDeploymentRpc(client: {
  getChainId(): Promise<number>;
  getCode(args: { address: `0x${string}`; blockNumber?: bigint }): Promise<`0x${string}` | undefined>;
}, deployment: Deployment): Promise<void> {
  let chainId;
  try { chainId = await client.getChainId(); }
  catch { throw new Error("Cannot verify deployment RPC chain"); }
  if (chainId !== deployment.chainId) throw new Error("RPC chain disagrees with deployment manifest");
  let codes;
  try {
    codes = await Promise.all([undefined, deployment.deployBlock, deployment.deployBlock - 1n].map((blockNumber) =>
      client.getCode({ address: deployment.parlayVault, blockNumber })));
  } catch { throw new Error("Cannot verify deployment RPC history; an archive-capable endpoint is required"); }
  const [current, deployed, previous] = codes.map((code) => !!code && code !== "0x");
  if (!current || !deployed || previous) throw new Error("RPC vault code disagrees with deployment address/block");
}
