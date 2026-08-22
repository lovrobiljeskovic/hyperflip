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
