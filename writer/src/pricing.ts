import { BPS, WAD } from "./pure.js";

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
