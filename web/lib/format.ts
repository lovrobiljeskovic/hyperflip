import { formatUnits } from "viem";

export const USDC_DECIMALS = 6;

export function formatUsdc(v: bigint): string {
  return Number(formatUnits(v, USDC_DECIMALS)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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
  // Mirrors the writer: price = p + p(1-p) x edge, so the edge fades at both extremes.
  const p = 1 / bd.fairMultiplier;
  const at = (edge: number) => 1 / (p + p * (1 - p) * edge);
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

/** Time left as the two largest units, so a countdown visibly ticks. */
export function until(ms: number, now = Date.now()): string {
  const s = (ms - now) / 1000;
  if (s <= 0) return "expired";
  const m = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600) % 24;
  const d = Math.floor(s / 86_400);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(s % 60)}s`;
}

/** Exact calendar time, "Sep 20, 1:00 PM", in the viewer's zone unless told otherwise. */
export function whenLabel(ms: number, timeZone?: string): string {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone });
}

export function pct1(mid: number): string {
  return `${(mid * 100).toFixed(1)}%`;
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

