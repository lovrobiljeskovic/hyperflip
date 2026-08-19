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
 * testnet-verified config, not code (spec §3, keeper FINDINGS pattern).
 * Empty book falls back to the allMids mid — testnet outcome books often carry
 * no resting orders while allMids still tracks the market; edgeBps covers the
 * mid-vs-ask gap. ponytail: mid is not executable depth; drop the fallback if
 * the writer ever hedges by taking the book. */
export async function fetchBestAskWad(infoApiUrl: string, coin: string): Promise<bigint> {
  const res = await fetch(infoApiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "l2Book", coin }),
  });
  if (!res.ok) throw new Error(`info API ${res.status}: ${await res.text()}`);
  const wad = bestAskWad(await res.json());
  if (wad !== null) return wad;
  const midsRes = await fetch(infoApiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "allMids" }),
  });
  if (!midsRes.ok) throw new Error(`info API ${midsRes.status}: ${await midsRes.text()}`);
  const mid = ((await midsRes.json()) as Record<string, string>)[coin];
  if (typeof mid !== "string") throw new Error(`empty book and no mid for ${coin}`);
  return parseDecimalToUnits(mid, 18);
}
