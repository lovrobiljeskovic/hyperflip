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

/** Multiplier as a number (premium and maxPayout are both 6-decimal USDC, so
 * the ratio is decimal-safe well below Number's precision limit). */
export function multiplierNum(premium: bigint, maxPayout: bigint): number {
  return premium === 0n ? 0 : Number(maxPayout) / Number(premium);
}

export const WAD = 10n ** 18n;

export interface PriceBreakdown {
  legOdds: number[]; // 1/p per leg, quote.legs order
  legProbs: number[]; // p per leg
  fairMultiplier: number; // 1 / prod(p)
  edgePct: number; // base house edge as a fraction (0.05 = 5%)
  legPct: number; // leg-count surcharge as a fraction
  corrPct: number; // correlation haircut as a fraction
  actualMultiplier: number; // maxPayout / premium — the signed truth
}

/** The multiplier after each edge component is applied in turn, so the UI can
 * show one row per deduction. Components are additive in bps (see the writer's
 * edgeBreakdown), hence the running sum in the denominator. */
export function edgeSteps(bd: PriceBreakdown): { afterEdge: number; afterLegs: number; modelled: number } {
  const at = (bps: number) => bd.fairMultiplier / (1 + bps);
  return {
    afterEdge: at(bd.edgePct),
    afterLegs: at(bd.edgePct + bd.legPct),
    modelled: at(bd.edgePct + bd.legPct + bd.corrPct),
  };
}

/** Rebuild the writer's pricing steps for display (writer/src/pricing.ts:
 * maxPayout = stake / (prod(p) * (1 + edge + corr))). Returns null when the
 * writer sent no breakdown or the leg count doesn't match. */
export function priceBreakdown(
  legPricesWad: readonly string[],
  edgeBps: string,
  legBps: string | undefined,
  corrBps: string,
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
    corrPct: Number(corrBps) / 10_000,
    actualMultiplier: multiplierNum(premium, maxPayout),
  };
}
