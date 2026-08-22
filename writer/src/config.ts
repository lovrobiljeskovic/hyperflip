import { config as loadDotenv } from "dotenv";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAddress, type Address } from "viem";
import { parseCorrelations, type CorrelationTable } from "./correlation.js";

// .env lives at the repo root, one level above writer/ — same pattern as keeper/config.ts.
const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../.env") });

export interface MarketInfo {
  vault: Address;
  /** Core l2Book coin string for the YES side (e.g. "+123850"). */
  coinYes: string;
  /** Core l2Book coin string for the NO side (e.g. "+123851"). */
  coinNo: string;
  /** Underlying asset (e.g. "BTC"). Feeds the correlation model in
   * correlation.ts: legs sharing an underlying are priced as near-certainly
   * (or, on opposite sides, impossibly) correlated by the copula, not refused. */
  underlying: string;
  /** Correlation cluster (e.g. "crypto"). Feeds the correlation model in
   * correlation.ts and scopes the perClusterCap exposure cap. */
  cluster: string;
  /** Which way YES bets the underlying: "up" (above-strike), "down" (below-strike),
   * "band" (between-strikes, direction-neutral). Combined with a leg's isYes, this
   * gives its bullish/bearish stance for the copula ("band" is non-directional —
   * bullish: null). */
  direction: "up" | "down" | "band";
  /** Optional market expiry (ms epoch); legs inside the lockout window are refused. */
  expiryMs?: number;
  /** Human-readable market question, shown by the frontend. */
  title: string;
  /** Display grouping (e.g. "crypto", "sports"). */
  category: string;
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
  perClusterCap: bigint;
  /** Multiplicative half-width of the correlation uncertainty band. The pricer
   * evaluates the joint probability at (1 - x) and (1 + x) times every pairwise
   * rho and quotes the house-favorable end, so the house is paid for the fact
   * that the loadings table is hand-set rather than measured. */
  rhoBandPct: number;
  /** Factor loadings, loaded from CORRELATIONS_FILE. Writer-only — deliberately
   * not part of markets.json, which GET /markets serves verbatim. */
  correlations: CorrelationTable;
  /** Extra edge (bps) per leg past the first. Base edge is flat in leg count,
   * so without this a long ticket earns the same margin as a short one while
   * carrying far more risk. Set to 0 to restore flat pricing. */
  legEdgeBps: bigint;
  quoteTtlMs: number;
  lockoutMs: number;
  pokerIntervalMs: number;
  /** Block ParlayVault was deployed at — startup event scan starts here. */
  deployBlock: bigint;
  /** Keyed by lowercase vault address. */
  markets: Map<string, MarketInfo>;
  /** Raw registry file contents, served verbatim by GET /markets. */
  registryJson: string;
  /** Valid invite codes; the only beta gate (spec §3). Waitlist-issued codes
   * (waitlist.ts) are accepted alongside these. */
  inviteCodes: Set<string>;
  /** Resend API key for waitlist invite emails; unset disables POST /waitlist. */
  resendApiKey?: string;
  /** Waitlist store path (absolute). */
  waitlistFile: string;
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

/** Registry: JSON array, or { markets: [...] }, of
 * { vault, coinYes, coinNo, underlying, cluster, direction, title, category, expiryMs? }. */
export function parseMarkets(raw: string): Map<string, MarketInfo> {
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed?.markets;
  if (!Array.isArray(list)) throw new Error("MARKETS must be a JSON array or { markets: [...] }");
  const map = new Map<string, MarketInfo>();
  for (const m of list) {
    if (!isAddress(m.vault)) throw new Error(`invalid market vault: ${m.vault}`);
    if (typeof m.coinYes !== "string" || typeof m.coinNo !== "string") {
      throw new Error(`market ${m.vault} missing coinYes/coinNo`);
    }
    if (typeof m.underlying !== "string" || m.underlying === "" || typeof m.cluster !== "string" || m.cluster === "") {
      throw new Error(`market ${m.vault} missing underlying/cluster`);
    }
    if (m.direction !== "up" && m.direction !== "down" && m.direction !== "band") {
      throw new Error(`market ${m.vault} direction must be "up", "down", or "band"`);
    }
    if (typeof m.title !== "string" || m.title === "" || typeof m.category !== "string" || m.category === "") {
      throw new Error(`market ${m.vault} missing title/category`);
    }
    map.set(m.vault.toLowerCase(), {
      vault: m.vault as Address,
      coinYes: m.coinYes,
      coinNo: m.coinNo,
      underlying: m.underlying,
      cluster: m.cluster,
      direction: m.direction,
      title: m.title,
      category: m.category,
      expiryMs: typeof m.expiryMs === "number" ? m.expiryMs : undefined,
    });
  }
  return map;
}

export function parseInviteCodes(raw: string): Set<string> {
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

export function loadConfig(): WriterConfig {
  const registryJson = readFileSync(path.resolve(here, "../..", requireEnv("MARKETS_FILE")), "utf8");
  const correlations = parseCorrelations(
    readFileSync(path.resolve(here, "../..", process.env.CORRELATIONS_FILE ?? "registry/correlations.json"), "utf8"),
  );
  // Boot-time signal, not per-request noise: the shipped table's shrunk
  // clusters don't change quote to quote, so this fires once here rather than
  // from the pure parse function on every call.
  if (correlations.shrunkClusters.length > 0) {
    console.warn(JSON.stringify({ event: "correlation-fallback-shrunk", clusters: correlations.shrunkClusters }));
  }
  const markets = parseMarkets(registryJson);
  // An empty table is not a degraded mode, it is silent mispricing: every leg
  // falls through to zero loadings and every parlay quotes as independent,
  // with nothing in the logs to say so. Refuse to boot.
  if (Object.keys(correlations.underlyings).length === 0) {
    throw new Error("correlations: no underlyings parsed — check the file's top-level `clusters` key");
  }
  // A market in a cluster the table has never heard of gets the blunt
  // whole-table fallback (see loadingsFor), which is an over-estimate rather
  // than an under-estimate — wrong, but not house-losing. Deliberately a warn
  // and not a throw: the registry is rewritten by the rotation job, so a throw
  // here would let that job brick the writer at startup.
  const unknown = [...markets.values()].filter((m) => correlations.fallback[m.cluster] === undefined);
  if (unknown.length > 0) {
    console.warn(
      JSON.stringify({
        event: "correlation-unknown-market-cluster",
        clusters: [...new Set(unknown.map((m) => m.cluster))],
        markets: unknown.map((m) => ({ vault: m.vault, underlying: m.underlying, cluster: m.cluster })),
      }),
    );
  }
  return {
    // The writer never touches the 0x814 precompile (keeper-only), which is the sole
    // reason TESTNET_RPC is pinned to the official endpoint — and that endpoint
    // rate-limits getLogs hard enough that the poker's catch-up scan cannot finish.
    // WRITER_RPC lets the writer run on a higher-throughput endpoint while the keeper
    // keeps the official one for the precompile.
    rpcUrl: process.env.WRITER_RPC ?? requireEnv("TESTNET_RPC"),
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
    perClusterCap: BigInt(requireEnv("PER_CLUSTER_CAP")),
    rhoBandPct: Number(process.env.RHO_BAND_PCT ?? 0.2),
    correlations,
    legEdgeBps: BigInt(process.env.LEG_EDGE_BPS ?? 300),
    quoteTtlMs: Number(process.env.QUOTE_TTL_MS ?? 30_000),
    lockoutMs: Number(process.env.LOCKOUT_MS ?? 600_000),
    pokerIntervalMs: Number(process.env.POKER_INTERVAL_MS ?? 15_000),
    deployBlock: BigInt(process.env.PARLAY_DEPLOY_BLOCK ?? 0),
    markets,
    registryJson,
    inviteCodes: parseInviteCodes(requireEnv("INVITE_CODES")),
    resendApiKey: process.env.RESEND_API_KEY,
    waitlistFile: path.resolve(here, "../..", process.env.WAITLIST_FILE ?? "writer/waitlist.json"),
  };
}
