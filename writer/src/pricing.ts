import { BPS, WAD } from "./pure.js";

export interface EdgeParts {
  baseBps: bigint;
  legBps: bigint;
  clusterBps: bigint;
}

/** Total edge charged on a ticket, split into the parts the UI displays.
 *
 * Base edge alone is flat in leg count — `prod(p)` cancels out of the house's
 * expected margin (stake * e/(1+e)), so a 5-leg ticket earned the same 4.76%
 * as a 2-leg one while risking ~20x more stake. legEdgeBps charges for that:
 * every leg past the first adds to the edge, mirroring how a book prices vig
 * into each leg before multiplying. Cluster edge is a separate axis — it
 * prices comovement between specific legs, not ticket length. */
export function edgeBreakdown(
  legCount: number,
  clusterPairs: bigint,
  edgeBps: bigint,
  legEdgeBps: bigint,
  clusterEdgeBps: bigint,
): EdgeParts {
  const extraLegs = BigInt(Math.max(0, legCount - 1));
  return {
    baseBps: edgeBps,
    legBps: legEdgeBps * extraLegs,
    clusterBps: clusterEdgeBps * clusterPairs,
  };
}

export function totalEdgeBps(p: EdgeParts): bigint {
  return p.baseBps + p.legBps + p.clusterBps;
}

export type PriceOutcome =
  | { ok: true; premium: bigint; maxPayout: bigint }
  | { ok: false; reason: string };

/** Naive product + margin (spec §3): premium = stake, maxPayout = stake / (prod(p) * (1+edge)).
 * maxPayout rounds down; capped so the contract's minPremiumBps floor can never reject a
 * quote we signed. Correlation between legs is deliberately ignored for beta (duplicate
 * vaults are rejected upstream in validation). */
export function priceParlay(
  legPricesWad: bigint[],
  stake: bigint,
  edgeBps: bigint,
  minPremiumBps: bigint,
): PriceOutcome {
  if (stake <= 0n) return { ok: false, reason: "bad-stake" };
  let probWad = WAD;
  for (const p of legPricesWad) {
    if (p <= 0n || p >= WAD) return { ok: false, reason: "bad-leg-price" };
    probWad = (probWad * p) / WAD;
  }
  if (probWad === 0n) return { ok: false, reason: "prob-underflow" };
  const priceWad = (probWad * (BPS + edgeBps)) / BPS;
  if (priceWad >= WAD) return { ok: false, reason: "no-payout" };
  let maxPayout = (stake * WAD) / priceWad;
  const floorCap = (stake * BPS) / minPremiumBps;
  if (maxPayout > floorCap) maxPayout = floorCap;
  if (maxPayout <= stake) return { ok: false, reason: "no-payout" };
  if (maxPayout >= 2n ** 96n) return { ok: false, reason: "uint96-overflow" };
  return { ok: true, premium: stake, maxPayout };
}
