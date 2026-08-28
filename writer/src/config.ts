import { config as loadDotenv } from "dotenv";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAddress, type Address } from "viem";
import type { CorrelationTable } from "./correlation.js";
import { parseMarkets, type MarketInfo } from "./markets.js";
import { BPS, parseDecimalToUnits } from "./pure.js";
import { parseCorrelationArtifact, type ArtifactModelMetadata } from "./research/artifacts.js";
import { parseSourceRegistry } from "./research/types.js";

// .env lives at the repo root, one level above writer/ — same pattern as keeper/config.ts.
const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../.env") });

export { parseMarkets } from "./markets.js";
export type { MarketInfo } from "./markets.js";

export interface WriterConfig {
  rpcUrl: string;
  parlayVault: Address;
  /** The bankroll wallet granting the ERC-20 allowance. Read-only here; this service never spends from it. */
  writerAddress: Address;
  quoteSignerKey: `0x${string}`;
  pokerKey: `0x${string}`;
  infoApiUrl: string;
  researchRoot: string;
  port: number;
  edgeBps: bigint;
  minPremiumBps: bigint;
  minLegs: number;
  maxStake: bigint;
  perMarketCap: bigint;
  perClusterCap: bigint;
  /** Cap on one invite code's reserved-but-unminted risk (sum of live /quote
   * reservations keyed by `inviteCode`), independent of the per-IP request-rate
   * limiter. Mitigates a caller who quotes repeatedly and never mints from
   * pinning quotable headroom for everyone else (mainnet-hardening P0-4) — a
   * liveness refinement, not a solvency cap; the allowance stays that.
   * Keyed on the code, not the taker address: addresses rotate for free
   * (defeating the cap) and an attacker could spam a victim's address to lock
   * them out; codes are limited-supply, revocable, and burn the sender's own
   * budget. People sharing one code share one budget — deliberate.
   * Default derivation: priceParlay's floorCap caps a single quote's risk at
   * (BPS/minPremiumBps - 1) * stake — computed from minPremiumBps, not a
   * hardcoded multiple, so a deployment that changes MIN_PREMIUM_BPS without
   * setting PER_CODE_RESERVED_CAP still gets a default that matches its own
   * floorCap (~99x maxStake at the default 100bps). minPremiumBps is
   * owner-settable on-chain and the chain value always wins over env at
   * startup (index.ts) — when PER_CODE_RESERVED_CAP was left unset, index.ts
   * recomputes this default off the synced chain value so it still tracks
   * the live floorCap, not the stale env one. poker's polling lag
   * (pokerIntervalMs, default 15s) means a
   * just-minted reservation can still count as "reserved" for a beat after the
   * taker already minted, so honest sequential minting can briefly hold 2-3
   * near-max reservations at once — hence the further *3 below, giving room
   * for ~3 such reservations while still bounding a single code to a small
   * slice of a real bankroll's allowance/perMarketCap. */
  perCodeReservedCap: bigint;
  /** Multiplicative half-width of the correlation uncertainty band. The pricer
   * evaluates the joint probability at (1 - x) and (1 + x) times every pairwise
   * rho and quotes the house-favorable end, so the house is paid for the fact
   * that the loadings table is hand-set rather than measured. */
  rhoBandPct: number;
  /** Factor loadings, loaded from CORRELATION_ARTIFACT_FILE. Writer-only — deliberately
   * not part of markets.json, which GET /markets serves verbatim. */
  correlations: CorrelationTable;
  /** Validated champion metadata and source/pair admission state. */
  model: ArtifactModelMetadata;
  /** Extra edge (bps) per leg past the first. Base edge is flat in leg count,
   * so without this a long ticket earns the same margin as a short one while
   * carrying far more risk. Set to 0 to restore flat pricing. */
  legEdgeBps: bigint;
  quoteTtlMs: number;
  /** A leg priced off spotPx (book empty/failed) is refused once its coin's last
   * confirmed-live timestamp is older than this. spotPx has no on-chain timestamp
   * (see writer/src/spotPx.ts), so freshness is tracked writer-side off book fetches. */
  spotPxStaleMs: number;
  /** Minimum cumulative ask-side `sz` (same units as l2Book's `sz`, WAD-scaled) a
   * book must cover before its price is trusted; below this it's treated as empty
   * and falls through to spotPx (mainnet-hardening P0-3 — a 1-lot spoofed top
   * can't move a quote). See writer/src/infoApi.ts `bestAskWad`. */
  minBookDepthWad: bigint;
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
  /** Browser-origin allowlist for CORS on sensitive routes (/quote, /waitlist,
   * /limits, /health, /metrics). Browser-enforcement only — a non-browser
   * caller (curl, the poker script) ignores CORS entirely, so this is not an
   * auth boundary; the invite gate and exposure caps remain that. /markets is
   * deliberately left `*` — it's public registry data the UI may fetch from
   * anywhere. */
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

export function parseInviteCodes(raw: string): Set<string> {
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/** CORS_ORIGINS default: the two known deployed frontends (project deploy state,
 * mainnet-hardening handoff). Override via env for other environments. */
export const DEFAULT_CORS_ORIGINS = "https://overround.xyz,https://overround-wine.vercel.app";

export function parseCorsOrigins(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Default PER_CODE_RESERVED_CAP when unset — see WriterConfig.perCodeReservedCap
 * for the reasoning. Pulled out as a pure function so the derivation is
 * unit-testable without going through loadConfig's env/file plumbing. */
export function defaultPerCodeReservedCap(maxStake: bigint, minPremiumBps: bigint): bigint {
  return maxStake * (BPS / minPremiumBps - 1n) * 3n;
}

/** Refresh perCodeReservedCap after index.ts syncs minPremiumBps from chain
 * (chain always wins — see WriterConfig.minPremiumBps). Only recomputes when
 * PER_CODE_RESERVED_CAP was left unset at load time, so an explicit env
 * override is never silently clobbered by the chain sync. */
export function syncedPerCodeReservedCap(
  envWasSet: boolean,
  current: bigint,
  maxStake: bigint,
  chainMinPremiumBps: bigint,
): bigint {
  return envWasSet ? current : defaultPerCodeReservedCap(maxStake, chainMinPremiumBps);
}

export function loadConfig(nowMs = Date.now()): WriterConfig {
  const registryJson = readFileSync(path.resolve(here, "../..", requireEnv("MARKETS_FILE")), "utf8");
  const markets = parseMarkets(registryJson);
  const sources = parseSourceRegistry(readFileSync(path.resolve(here, "../..", process.env.CORRELATION_SOURCES_FILE ?? "registry/correlation-sources.json"), "utf8"));
  const champion = parseCorrelationArtifact(readFileSync(path.resolve(here, "../..", requireEnv("CORRELATION_ARTIFACT_FILE")), "utf8"), nowMs, sources, markets);
  const { table: correlations, model } = champion;
  // Boot-time signal, not per-request noise: the shipped table's shrunk
  // clusters don't change quote to quote, so this fires once here rather than
  // from the pure parse function on every call.
  if (correlations.shrunkClusters.length > 0) {
    console.warn(JSON.stringify({ event: "correlation-fallback-shrunk", clusters: correlations.shrunkClusters }));
  }
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
  const maxStake = BigInt(requireEnv("MAX_STAKE"));
  const minPremiumBps = BigInt(process.env.MIN_PREMIUM_BPS ?? 100);
  const spotPxStaleMsRaw = Number(process.env.SPOT_PX_STALE_MS ?? 60_000);
  // isSpotPxStale is `now - lastFreshMs > staleMs`; a NaN staleMs makes every
  // comparison false, silently disabling the P0-1 freshness gate instead of
  // refusing quotes. Same "refuse to boot on malformed input" posture as the
  // correlation table check above.
  if (!Number.isFinite(spotPxStaleMsRaw)) {
    throw new Error("SPOT_PX_STALE_MS must be a finite number");
  }
  // 0 = gate explicitly OFF (mapped to Infinity for isSpotPxStale). Testnet
  // outcome books are empty, so no coin ever earns a book-ask freshness stamp
  // and a finite window 503s every quote (stale-book). Play-money deployments
  // opt out; mainnet keeps the finite default.
  const spotPxStaleMs = spotPxStaleMsRaw === 0 ? Infinity : spotPxStaleMsRaw;
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
    researchRoot: path.resolve(here, "../..", requireEnv("RESEARCH_ROOT")),
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
    rhoBandPct: Number(process.env.RHO_BAND_PCT ?? 0.2),
    correlations,
    model,
    legEdgeBps: BigInt(process.env.LEG_EDGE_BPS ?? 300),
    quoteTtlMs: Number(process.env.QUOTE_TTL_MS ?? 30_000),
    spotPxStaleMs,
    // ponytail: 50 is a placeholder floor, not a measured mainnet depth figure —
    // recalibrate against real outcome-book liquidity before mainnet launch.
    minBookDepthWad: parseDecimalToUnits(process.env.MIN_BOOK_DEPTH ?? "50", 18),
    lockoutMs: Number(process.env.LOCKOUT_MS ?? 600_000),
    pokerIntervalMs: Number(process.env.POKER_INTERVAL_MS ?? 15_000),
    deployBlock: BigInt(process.env.PARLAY_DEPLOY_BLOCK ?? 0),
    markets,
    registryJson,
    inviteCodes: parseInviteCodes(requireEnv("INVITE_CODES")),
    resendApiKey: process.env.RESEND_API_KEY,
    waitlistFile: path.resolve(here, "../..", process.env.WAITLIST_FILE ?? "writer/waitlist.json"),
    corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS ?? DEFAULT_CORS_ORIGINS),
  };
}
