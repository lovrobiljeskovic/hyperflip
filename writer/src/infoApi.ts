import { parseDecimalToUnits } from "./pure.js";

interface L2Level {
  px: string;
  sz: string;
  n: number;
}

/** l2Book response: levels[0] = bids, levels[1] = asks, best first. */
export function bestAskWad(book: unknown): bigint | null {
  const levels = (book as { levels?: L2Level[][] })?.levels;
  const ask = levels?.[1]?.[0];
  if (!ask) return null;
  return parseDecimalToUnits(ask.px, 18);
}

/** POST {type:"l2Book", coin} — best ask for the coin, as WAD probability/price.
 * Coin strings come from the config market map; exact outcome-coin naming is
 * testnet-verified config, not code (spec §3, keeper FINDINGS pattern). */
export async function fetchBestAskWad(infoApiUrl: string, coin: string): Promise<bigint> {
  const res = await fetch(infoApiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "l2Book", coin }),
  });
  if (!res.ok) throw new Error(`info API ${res.status}: ${await res.text()}`);
  const wad = bestAskWad(await res.json());
  if (wad === null) throw new Error(`empty book for ${coin}`);
  return wad;
}
