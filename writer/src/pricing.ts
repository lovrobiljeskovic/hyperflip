import { BPS, WAD } from "./pure.js";

export interface EdgeParts {
  baseBps: bigint;
  legBps: bigint;
}

/** Total edge charged on a ticket, split into the parts the UI displays.
 *
 * Base edge alone is flat in leg count — the joint probability cancels out of
 * the house's expected margin (stake * e/(1+e)), so a 5-leg ticket earned the
 * same 4.76% as a 2-leg one while risking ~20x more stake. legEdgeBps charges
 * for that: every leg past the first adds to the edge, mirroring how a book
 * prices vig into each leg before multiplying.
 *
 * There is deliberately no correlation component. Correlation has a sign, so a
 * flat per-pair fee cannot represent it; it belongs in the joint probability
 * (see correlation.ts), and charging it here as well would bill the same risk
 * twice. */
export function edgeBreakdown(legCount: number, edgeBps: bigint, legEdgeBps: bigint): EdgeParts {
  const extraLegs = BigInt(Math.max(0, legCount - 1));
  return { baseBps: edgeBps, legBps: legEdgeBps * extraLegs };
}

export function totalEdgeBps(p: EdgeParts): bigint {
  return p.baseBps + p.legBps;
}

/** Independence pricing: P(every leg wins) = product of the leg prices.
 * Sports mode only — legs from the same game or question are refused upstream
 * (`same-game`), so nothing here needs the copula's same-market collapse. */
export function independentJointProbWad(legPricesWad: bigint[]): bigint {
  return legPricesWad.reduce((acc, p) => (acc * p) / WAD, WAD);
}

export type PriceOutcome =
  | { ok: true; premium: bigint; maxPayout: bigint }
  | { ok: false; reason: string };

/** premium = stake, maxPayout = stake / (jointProb * (1+edge)).
 *
 * `jointProbWad` is P(every leg wins) from the copula, already at the
 * house-favorable end of the correlation band. maxPayout rounds down and is
 * capped so the contract's minPremiumBps floor can never reject a quote we
 * signed. */
export function priceParlay(
  jointProbWad: bigint,
  stake: bigint,
  edgeBps: bigint,
  minPremiumBps: bigint,
): PriceOutcome {
  if (stake <= 0n) return { ok: false, reason: "bad-stake" };
  if (jointProbWad <= 0n) return { ok: false, reason: "cannot-win" };
  if (jointProbWad >= WAD) return { ok: false, reason: "bad-joint-prob" };
  const priceWad = (jointProbWad * (BPS + edgeBps)) / BPS;
  if (priceWad >= WAD) return { ok: false, reason: "no-payout" };
  if (priceWad === 0n) return { ok: false, reason: "cannot-win" };
  let maxPayout = (stake * WAD) / priceWad;
  const floorCap = (stake * BPS) / minPremiumBps;
  if (maxPayout > floorCap) maxPayout = floorCap;
  if (maxPayout <= stake) return { ok: false, reason: "no-payout" };
  if (maxPayout >= 2n ** 96n) return { ok: false, reason: "uint96-overflow" };
  return { ok: true, premium: stake, maxPayout };
}

/** Index of a leg whose lone Core trade (payout stake/p, no edge) already pays
 * at least the whole parlay, or -1.
 *
 * The joint probability can never exceed the smallest leg probability, for any
 * correlation — so the fair parlay payout is always at least the best leg's
 * Core fair. When house-favorable correlation collapses the joint onto that
 * bound, edge pushes the quote below it, and the ticket is strictly dominated:
 * fewer ways to win AND a lower payout than one Core trade the taker can see
 * on screen. No correlation table makes such a quote sensible, on any future
 * market pair; the writer refuses instead of signing it. */
export function dominatingLeg(legPricesWad: bigint[], stake: bigint, maxPayout: bigint): number {
  for (let i = 0; i < legPricesWad.length; i++) {
    const p = legPricesWad[i];
    if (p > 0n && maxPayout <= (stake * WAD) / p) return i;
  }
  return -1;
}
