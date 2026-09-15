import { parseDecimalToUnits } from "./pure.js";

export interface LegPriceObservation {
  priceWad: bigint;
  source: "l2Book" | "spotPx" | "prior";
  observedAtMs: number;
  depthWad: bigint | null;
  vwapWad: bigint | null;
  freshnessMs: number | null;
}

interface L2Level {
  px: string;
  sz: string;
  n: number;
}

/** l2Book response: levels[0] = bids, levels[1] = asks, best first. A single 1-lot
 * resting order at the top would otherwise set the price for an arbitrary-size
 * parlay (mainnet-hardening P0-3), so this walks ask levels until cumulative `sz`
 * covers `minDepthWad` (same units as the book's `sz` field — coin units, WAD-scaled
 * for arithmetic) and volume-weights the price across the levels consumed.
 *
 * A book that never reaches minDepthWad is too thin to trust: same null signal as
 * an empty book, so the caller (spotPx.ts's makeLegPriceFetcher) falls through to
 * the P0-1 freshness-gated spotPx path. That fallthrough is deliberate for
 * freshness too: only a depth-covering ask stamps a coin "confirmed live" — a
 * spoofed 1-lot must not be able to fake liveness and keep the staleness clock
 * from ever expiring.
 *
 * "Never sell below the book": the volume-weighted price across a normally-ordered
 * ask book is always >= the plain best ask, but the max() is explicit rather than
 * assumed, so a malformed/out-of-order book can't quote better than top-of-book.
 *
 * minDepthWad = 0 restores pre-P0-3 behavior (price off the first level alone). */
export function bestAskWad(book: unknown, minDepthWad: bigint): bigint | null {
  return bestAsk(book, minDepthWad)?.priceWad ?? null;
}

function bestAsk(book: unknown, minDepthWad: bigint): Pick<LegPriceObservation, "priceWad" | "depthWad" | "vwapWad"> | null {
  const levels = (book as { levels?: L2Level[][] })?.levels;
  const asks = levels?.[1];
  if (!asks || asks.length === 0) return null;
  const bestPxWad = parseDecimalToUnits(asks[0].px, 18);
  let cumSzWad = 0n;
  let cumNotionalWad = 0n; // sum(px*sz), WAD*WAD scale until divided by cumSzWad below
  for (const level of asks) {
    const pxWad = parseDecimalToUnits(level.px, 18);
    const szWad = parseDecimalToUnits(level.sz, 18);
    cumSzWad += szWad;
    cumNotionalWad += pxWad * szWad;
    if (cumSzWad > 0n && cumSzWad >= minDepthWad) {
      const vwapWad = cumNotionalWad / cumSzWad;
      return { priceWad: vwapWad > bestPxWad ? vwapWad : bestPxWad, depthWad: cumSzWad, vwapWad };
    }
  }
  return null; // depth never covered — too thin to trust, same signal as an empty book
}

/** POST {type:"l2Book", coin} — depth-covering ask for the coin as WAD (see
 * bestAskWad), or null on an empty/too-thin book.
 * Coin strings come from the config market map; exact outcome-coin naming is
 * testnet-verified config, not code (spec §3, keeper FINDINGS pattern).
 * The old allMids fallback is gone: allMids carries no outcome coins at all
 * (verified 2026-08-25), so it could never answer — null lets the caller fall
 * back to the 0x808 spotPx precompile instead. The timeout mirrors the keeper's
 * hard-learned rule (0x232a strand): a stalled fetch must fail the quote, not
 * hang the request. */
export async function fetchBestAskWad(
  infoApiUrl: string,
  coin: string,
  minDepthWad: bigint,
  now: () => number = Date.now,
): Promise<LegPriceObservation | null> {
  const res = await fetch(infoApiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "l2Book", coin }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`info API ${res.status}: ${await res.text()}`);
  const ask = bestAsk(await res.json(), minDepthWad);
  return ask && { ...ask, source: "l2Book", observedAtMs: now(), freshnessMs: null };
}
