import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAddress, type Address } from "viem";

// .env lives at the repo root, one level above writer/ — same pattern as keeper/config.ts.
const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../.env") });

export interface MarketInfo {
  vault: Address;
  /** Core l2Book coin string for the YES side (e.g. "+123850"). */
  coinYes: string;
  /** Core l2Book coin string for the NO side (e.g. "+123851"). */
  coinNo: string;
  /** Optional market expiry (ms epoch); legs inside the lockout window are refused. */
  expiryMs?: number;
}

export interface WriterConfig {
  rpcUrl: string;
  parlayVault: Address;
  /** The bankroll wallet granting the ERC-20 allowance. Read-only here; this service never spends from it. */
  writerAddress: Address;
  quoteSignerKey: `0x${string}`;
  pokerKey: `0x${string}`;
  infoApiUrl: string;
  port: number;
  edgeBps: bigint;
  minPremiumBps: bigint;
  minLegs: number;
  maxStake: bigint;
  perMarketCap: bigint;
  quoteTtlMs: number;
  lockoutMs: number;
  pokerIntervalMs: number;
  /** Block ParlayVault was deployed at — startup event scan starts here. */
  deployBlock: bigint;
  /** Keyed by lowercase vault address. */
  markets: Map<string, MarketInfo>;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

function requireKey(name: string): `0x${string}` {
  const v = requireEnv(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
    // Never log the value itself — only that it's malformed.
    throw new Error(`${name} must be a 0x-prefixed 32-byte hex string`);
  }
  return v as `0x${string}`;
}

function requireAddress(name: string): Address {
  const v = requireEnv(name);
  if (!isAddress(v)) throw new Error(`${name} is not a valid address`);
  return v;
}

/** MARKETS env: JSON array of { vault, coinYes, coinNo, expiryMs? }. */
export function parseMarkets(raw: string): Map<string, MarketInfo> {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("MARKETS must be a JSON array");
  const map = new Map<string, MarketInfo>();
  for (const m of parsed) {
    if (!isAddress(m.vault)) throw new Error(`invalid market vault: ${m.vault}`);
    if (typeof m.coinYes !== "string" || typeof m.coinNo !== "string") {
      throw new Error(`market ${m.vault} missing coinYes/coinNo`);
    }
    map.set(m.vault.toLowerCase(), {
      vault: m.vault as Address,
      coinYes: m.coinYes,
      coinNo: m.coinNo,
      expiryMs: typeof m.expiryMs === "number" ? m.expiryMs : undefined,
    });
  }
  return map;
}

export function loadConfig(): WriterConfig {
  return {
    rpcUrl: requireEnv("TESTNET_RPC"),
    parlayVault: requireAddress("PARLAY_VAULT_ADDRESS"),
    writerAddress: requireAddress("WRITER_ADDRESS"),
    quoteSignerKey: requireKey("QUOTE_SIGNER_PRIVATE_KEY"),
    pokerKey: requireKey("POKER_PRIVATE_KEY"),
    infoApiUrl: process.env.INFO_API_URL ?? "https://api.hyperliquid-testnet.xyz/info",
    port: Number(process.env.WRITER_PORT ?? 8787),
    edgeBps: BigInt(process.env.EDGE_BPS ?? 500),
    minPremiumBps: BigInt(process.env.MIN_PREMIUM_BPS ?? 100),
    minLegs: Number(process.env.MIN_LEGS ?? 2),
    maxStake: BigInt(requireEnv("MAX_STAKE")),
    perMarketCap: BigInt(requireEnv("PER_MARKET_CAP")),
    quoteTtlMs: Number(process.env.QUOTE_TTL_MS ?? 30_000),
    lockoutMs: Number(process.env.LOCKOUT_MS ?? 600_000),
    pokerIntervalMs: Number(process.env.POKER_INTERVAL_MS ?? 15_000),
    deployBlock: BigInt(process.env.PARLAY_DEPLOY_BLOCK ?? 0),
    markets: parseMarkets(requireEnv("MARKETS")),
  };
}
