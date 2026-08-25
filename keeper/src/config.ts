import { config as loadDotenv } from "dotenv";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAddress, type Address } from "viem";
import { parseRegistryMarkets } from "./pure.js";

// .env lives at the worktree root, one level above keeper/, not at process.cwd() (which is
// keeper/ under `npm run start`) — dotenv's default auto-load would silently miss it.
const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../.env") });

export interface KeeperConfig {
  rpcUrl: string;
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

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
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
  const keeperPrivateKey = requireEnv("KEEPER_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(keeperPrivateKey)) {
    // Never log the value itself — only that it's malformed.
    throw new Error("KEEPER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string");
  }
  // Single source of truth: the registry the writer quotes from is the list the keeper must
  // settle. VAULT_ADDRESSES stays supported as an explicit override (a vault retired from the
  // registry still needs settling, and tests pin a list directly), but MARKETS_FILE is the
  // default so a new market cannot be quotable-but-unsettleable.
  const registryMarkets = process.env.VAULT_ADDRESSES
    ? null
    : parseRegistryMarkets(readFileSync(path.resolve(here, "../..", requireEnv("MARKETS_FILE")), "utf8"));
  const vaultAddresses = registryMarkets
    ? registryMarkets.map((m) => m.vault)
    : parseVaultAddresses(process.env.VAULT_ADDRESSES!);
  const marketExpiries = new Map(
    (registryMarkets ?? [])
      .filter((m) => m.expiryMs !== undefined)
      .map((m) => [m.vault.toLowerCase(), m.expiryMs!] as const),
  );

  return {
    rpcUrl,
    keeperPrivateKey: keeperPrivateKey as `0x${string}`,
    vaultAddresses,
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5_000),
    balanceTimeoutMs: Number(process.env.BALANCE_TIMEOUT_MS ?? 60_000),
    settlementCachePath: process.env.SETTLEMENT_CACHE_PATH ?? path.resolve(here, "../settlement-cache.json"),
    marketExpiries,
  };
}
