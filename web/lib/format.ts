import { formatUnits } from "viem";

export const USDC_DECIMALS = 6;

export function formatUsdc(v: bigint): string {
  return Number(formatUnits(v, USDC_DECIMALS)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatVolume(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value === 0) return "$0";
  const [divisor, suffix] =
    value >= 999_950_000 ? [1_000_000_000, "B"] :
    value >= 999_950 ? [1_000_000, "M"] :
    value >= 1_000 ? [1_000, "K"] : [1, ""];
  const rounded = Math.round((value / divisor) * 10) / 10;
  return `$${suffix ? rounded : Math.round(rounded)}${suffix}`;
}

export function multiplier(premium: bigint, maxPayout: bigint): string {
  if (premium === 0n) return "—";
  return `${(Number(maxPayout) / Number(premium)).toFixed(2)}x`;
}

export function impliedPct(mid: number): string {
  return `${Math.round(mid * 100)}%`;
}

export function secondsLeft(deadlineSec: bigint, nowMs: number): number {
  return Math.floor(Math.max(0, Number(deadlineSec) * 1000 - nowMs) / 1000);
}

export function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function multiplierNum(premium: bigint, maxPayout: bigint): number {
  return premium === 0n ? 0 : Number(maxPayout) / Number(premium);
}

export const WAD = 10n ** 18n;

export interface PriceBreakdown {
  legOdds: number[]; // 1/p per leg, quote.legs order
  legProbs: number[]; // p per leg
  fairMultiplier: number; // 1 / prod(p) — what the legs multiply to, verifiable by hand
  edgePct: number; // base house edge as a fraction (0.05 = 5%)
  legPct: number; // leg-count surcharge as a fraction
  actualMultiplier: number; // maxPayout / premium — the signed truth
}

export function edgeSteps(bd: PriceBreakdown): {
  afterEdge: number;
  afterLegs: number;
  modelled: number;
} {
  const at = (bps: number) => bd.fairMultiplier / (1 + bps);
  return {
    afterEdge: at(bd.edgePct),
    afterLegs: at(bd.edgePct + bd.legPct),
    modelled: at(bd.edgePct + bd.legPct),
  };
}

// Display arithmetic; the signed payout remains authoritative.
export function priceBreakdown(
  legPricesWad: readonly string[],
  edgeBps: string,
  legBps: string | undefined,
  premium: bigint,
  maxPayout: bigint,
): PriceBreakdown | null {
  if (legPricesWad.length === 0) return null;
  const legProbs = legPricesWad.map((w) => Number(BigInt(w)) / Number(WAD));
  if (legProbs.some((p) => !(p > 0) || p >= 1)) return null;
  const prod = legProbs.reduce((a, p) => a * p, 1);
  return {
    legProbs,
    legOdds: legProbs.map((p) => 1 / p),
    fairMultiplier: 1 / prod,
    edgePct: Number(edgeBps) / 10_000,
    legPct: Number(legBps ?? 0) / 10_000,
    actualMultiplier: multiplierNum(premium, maxPayout),
  };
}

export function until(ms: number): string {
  const s = (ms - Date.now()) / 1000;
  if (s <= 0) return "expired";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

export function pct1(mid: number): string {
  return `${(mid * 100).toFixed(1)}%`;
}

export function oddsLabel(mid: number | null): string {
  return mid === null ? "—" : `${(1 / mid).toFixed(2)}x`;
}

export function quotedOverround(bd: PriceBreakdown): number {
  if (bd.actualMultiplier <= 0) return 0;
  return bd.fairMultiplier / bd.actualMultiplier - 1;
}

export function shortError(err: unknown): string {
  const raw = String((err as Error)?.message ?? err);
  const firstLine = raw.split("\n")[0] ?? raw;
  return firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine;
}

/** Kickoff countdown, "live" once the game has started. Falls back to the resolution
 * deadline for markets that carry no start time. */
export function kickoff(m: { startMs?: number; expiryMs?: number }): string {
  if (m.startMs) return m.startMs > Date.now() ? until(m.startMs) : "live";
  return m.expiryMs ? until(m.expiryMs) : "-";
}
