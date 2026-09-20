/* Price history for one HIP-4 side coin, straight off the info API's
   candleSnapshot (CORS-open like allMids). A candle only exists once the coin
   has traded, so a fresh market comes back empty - the chart says so. */
import { INFO_API } from "./info";

export type Range = "1D" | "ALL";

export interface Point {
  /** Candle open time, ms. */
  t: number;
  /** Close price, 0..1. */
  c: number;
}

/** Candle rows -> close points, oldest first. Drops anything that is not a
 * finite probability so one malformed row cannot blank the chart. */
export function parseCandles(value: unknown): Point[] {
  if (!Array.isArray(value)) return [];
  const points: Point[] = [];
  for (const row of value) {
    const t = Number(row?.t);
    const c = Number(row?.c);
    if (Number.isFinite(t) && Number.isFinite(c) && c >= 0 && c <= 1) points.push({ t, c });
  }
  return points.sort((a, b) => a.t - b.t);
}

const DAY_MS = 86_400_000;

/** 1D: 15-minute closes over the last 24h. ALL: hourly closes since the first
 * trade. Never throws: no history just means an empty chart. */
// ponytail: ALL pulls hourly candles from epoch 0; switch to 1d candles past ~60 days if a market lives that long.
export async function fetchCloses(coin: string, range: Range, now = Date.now()): Promise<Point[]> {
  const req =
    range === "1D"
      ? { coin, interval: "15m", startTime: now - DAY_MS, endTime: now }
      : { coin, interval: "1h", startTime: 0, endTime: now };
  try {
    const r = await fetch(INFO_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req }),
    });
    return r.ok ? parseCandles(await r.json()) : [];
  } catch {
    return [];
  }
}

export interface Level {
  px: number;
  sz: number;
}
/** Top of the Core book for one side coin: bids and asks, best first. */
export interface Book {
  bids: Level[];
  asks: Level[];
}
export const EMPTY_BOOK: Book = { bids: [], asks: [] };

/** l2Book -> {bids, asks}, best first, junk rows dropped. `depth` caps each side. */
export function parseBook(value: unknown, depth = 5): Book {
  const levels = (value as { levels?: unknown })?.levels;
  if (!Array.isArray(levels) || levels.length < 2) return EMPTY_BOOK;
  const side = (rows: unknown): Level[] =>
    (Array.isArray(rows) ? rows : [])
      .map((r) => ({ px: Number(r?.px), sz: Number(r?.sz) }))
      .filter((l) => Number.isFinite(l.px) && Number.isFinite(l.sz) && l.sz > 0)
      .slice(0, depth);
  return { bids: side(levels[0]), asks: side(levels[1]) };
}

/** Never throws: an unreachable book shows as empty. */
export async function fetchBook(coin: string): Promise<Book> {
  try {
    const r = await fetch(INFO_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "l2Book", coin }),
    });
    return r.ok ? parseBook(await r.json()) : EMPTY_BOOK;
  } catch {
    return EMPTY_BOOK;
  }
}
