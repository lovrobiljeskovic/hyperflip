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

/** l2Book: levels[0] = bids, levels[1] = asks, best first. VWAP across asks until depth >=
 * minDepthWad (a lone 1-lot must not price a big parlay); never below best ask; too thin
 * -> null, which also denies a spoofed 1-lot the "confirmed live" freshness stamp
 * (spotPx.ts). minDepthWad = 0 prices off the first level alone. */
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

/** POST {type:"l2Book", coin}: depth-covering ask as WAD (see bestAskWad), or null on an
 * empty/too-thin book. Timeout: a stalled fetch must fail the quote, not hang it. */
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
