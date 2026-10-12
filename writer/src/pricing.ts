import { BPS, WAD } from "./units.js";

export interface EdgeParts {
  baseBps: bigint;
  legBps: bigint;
}

export function edgeBreakdown(legCount: number, edgeBps: bigint, legEdgeBps: bigint): EdgeParts {
  const extraLegs = BigInt(Math.max(0, legCount - 1));
  return { baseBps: edgeBps, legBps: legEdgeBps * extraLegs };
}

export function totalEdgeBps(p: EdgeParts): bigint {
  return p.baseBps + p.legBps;
}

export function independentJointProbWad(legPricesWad: bigint[]): bigint {
  return legPricesWad.reduce((acc, p) => (acc * p) / WAD, WAD);
}

export type PriceOutcome =
  | { ok: true; premium: bigint; maxPayout: bigint }
  | { ok: false; reason: string };

export function priceParlay(
  jointProbWad: bigint,
  stake: bigint,
  edgeBps: bigint,
  minPremiumBps: bigint,
): PriceOutcome {
  if (stake <= 0n) return { ok: false, reason: "bad-stake" };
  if (jointProbWad <= 0n) return { ok: false, reason: "cannot-win" };
  if (jointProbWad >= WAD) return { ok: false, reason: "bad-joint-prob" };
  // Edge is charged on p(1-p), like an exchange taker fee: full at coin flips,
  // vanishing at both extremes so favourites still pay out and longshots
  // are not taxed twice. Takeout as a share of stake is edge x (1 - p).
  const priceWad = jointProbWad + (jointProbWad * (WAD - jointProbWad) * edgeBps) / (WAD * BPS);
  if (priceWad >= WAD) return { ok: false, reason: "no-payout" };
  if (priceWad === 0n) return { ok: false, reason: "cannot-win" };
  let maxPayout = (stake * WAD) / priceWad;
  // Round down and enforce the contract's minimum-premium floor.
  const floorCap = (stake * BPS) / minPremiumBps;
  if (maxPayout > floorCap) maxPayout = floorCap;
  if (maxPayout <= stake) return { ok: false, reason: "no-payout" };
  if (maxPayout >= 2n ** 96n) return { ok: false, reason: "uint96-overflow" };
  return { ok: true, premium: stake, maxPayout };
}

// Reject a parlay that pays no more than one of its legs alone.
export function dominatingLeg(legPricesWad: bigint[], stake: bigint, maxPayout: bigint): number {
  for (let i = 0; i < legPricesWad.length; i++) {
    const p = legPricesWad[i];
    if (p > 0n && maxPayout <= (stake * WAD) / p) return i;
  }
  return -1;
}
