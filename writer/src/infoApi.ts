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

/** POST {type:"l2Book", coin} — best ask for the coin as WAD, or null on an empty book.
 * Coin strings come from the config market map; exact outcome-coin naming is
 * testnet-verified config, not code (spec §3, keeper FINDINGS pattern).
 * The old allMids fallback is gone: allMids carries no outcome coins at all
 * (verified 2026-08-25), so it could never answer — null lets the caller fall
 * back to the 0x808 spotPx precompile instead. The timeout mirrors the keeper's
 * hard-learned rule (0x232a strand): a stalled fetch must fail the quote, not
 * hang the request. */
export async function fetchBestAskWad(infoApiUrl: string, coin: string): Promise<bigint | null> {
  const res = await fetch(infoApiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "l2Book", coin }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`info API ${res.status}: ${await res.text()}`);
  return bestAskWad(await res.json());
}
