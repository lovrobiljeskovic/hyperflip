import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAddress, type Address } from "viem";

// .env lives at the worktree root, one level above keeper/, not at process.cwd() (which is
// keeper/ under `npm run start`) — dotenv's default auto-load would silently miss it.
const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../.env") });

export interface KeeperConfig {
  rpcUrl: string;
  keeperPrivateKey: `0x${string}`;
  vaultAddresses: Address[];
  infoApiUrl: string;
  /** How often the balance loop and settlement loop each tick. */
  pollIntervalMs: number;
  /** Keeper-side policy timeout for "no balance delta observed" — see keeper.ts balanceLoop. */
  balanceTimeoutMs: number;
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
  const vaultAddresses = parseVaultAddresses(requireEnv("VAULT_ADDRESSES"));

  return {
    rpcUrl,
    keeperPrivateKey: keeperPrivateKey as `0x${string}`,
    vaultAddresses,
    infoApiUrl: process.env.INFO_API_URL ?? "https://api.hyperliquid-testnet.xyz/info",
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5_000),
    balanceTimeoutMs: Number(process.env.BALANCE_TIMEOUT_MS ?? 60_000),
  };
}
