import { loadDeployment, type Deployment } from "../../registry/deployment.mjs";
import { config as loadDotenv } from "dotenv";
import { readFileSync } from "node:fs";
import { isAddress, type Address } from "viem";
import { requireEnv, requireKey, rootPath } from "../../services/env.mjs";
import { parseRegistryMarkets } from "./pure.js";

// .env lives at the worktree root, one level above keeper/, not at process.cwd() (which is
// keeper/ under `npm run start`) — dotenv's default auto-load would silently miss it.
loadDotenv({ path: rootPath(".env") });

export interface KeeperConfig extends Deployment {
  /** HyperEVM (coreChainId) RPC list: where OutcomeVaults settle. */
  rpcUrl: string;
  /** Elysium RPC list, required when the ParlayVault lives there (chainId !== coreChainId). */
  elysiumRpcUrl?: string;
  /** Elysium OutcomeLeg per lowercased HyperEVM vault, for rows that carry a sourceVault. */
  legs: Map<string, Address>;
  keeperPrivateKey: `0x${string}`;
  vaultAddresses: Address[];
  /** How often the balance loop and settlement loop each tick. */
  pollIntervalMs: number;
  /** Keeper-side policy timeout for "no balance delta observed" — see keeper.ts balanceLoop. */
  balanceTimeoutMs: number;
  /** Where settlement fractions observed pre-prune are persisted, so a restart inside Core's
   * ~10-minute settled->pruned window does not lose the only fraction that can still relay. */
  settlementCachePath: string;
  /** Registry expiry per lowercased vault, for the staleness alert. Empty when the vault list
   * came from the VAULT_ADDRESSES override, which carries no expiry data. */
  marketExpiries: Map<string, number>;
}

/** VAULT_ADDRESSES as a JSON array (`["0x..","0x.."]`) or a comma-separated list. */
function parseVaultAddresses(raw: string): Address[] {
  let items: string[];
  try {
    const parsed = JSON.parse(raw);
    items = Array.isArray(parsed) ? parsed : [raw];
  } catch {
    items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  for (const a of items) {
    if (!isAddress(a)) throw new Error(`invalid vault address: ${a}`);
  }
  return items as Address[];
}

export function loadConfig(): KeeperConfig {
  const rpcUrl = requireEnv("TESTNET_RPC");
  const keeperPrivateKey = requireKey("KEEPER_PRIVATE_KEY");
  // Single source of truth: the registry the writer quotes from is the list the keeper must
  // settle. VAULT_ADDRESSES stays supported as an explicit override (a vault retired from the
  // registry still needs settling, and tests pin a list directly), but MARKETS_FILE is the
  // default so a new market cannot be quotable-but-unsettleable.
  const registryMarkets = process.env.VAULT_ADDRESSES
    ? null
    : parseRegistryMarkets(readFileSync(rootPath(requireEnv("MARKETS_FILE")), "utf8"));
  const vaultAddresses = registryMarkets
    ? registryMarkets.map((m) => m.vault)
    : parseVaultAddresses(process.env.VAULT_ADDRESSES!);
  const marketExpiries = new Map(
    (registryMarkets ?? [])
      .filter((m) => m.expiryMs !== undefined)
      .map((m) => [m.vault.toLowerCase(), m.expiryMs!] as const),
  );

  const deployment = loadDeployment();
  const elysiumRpcUrl = process.env.ELYSIUM_RPC || undefined;
  if (deployment.chainId !== deployment.coreChainId && !elysiumRpcUrl) {
    throw new Error("ELYSIUM_RPC is required when the deployment manifest selects Elysium");
  }
  const legs = new Map(
    (registryMarkets ?? []).filter((m) => m.leg !== undefined).map((m) => [m.vault.toLowerCase(), m.leg!] as const),
  );

  return {
    ...deployment,
    rpcUrl,
    elysiumRpcUrl,
    legs,
    keeperPrivateKey,
    vaultAddresses,
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5_000),
    balanceTimeoutMs: Number(process.env.BALANCE_TIMEOUT_MS ?? 60_000),
    settlementCachePath: process.env.SETTLEMENT_CACHE_PATH ?? rootPath("keeper/settlement-cache.json"),
    marketExpiries,
  };
}
