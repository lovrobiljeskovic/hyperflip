import type { LegPriceObservation } from "./infoApi.js";

/** Pure staleness predicate for a coin's spotPx fallback. `lastFreshMs` is the last
 * time we confirmed this coin's market was live — a book fetch that returned a real
 * ask, never a bare spotPx read: 0x808 carries no timestamp, so successfully reading
 * it says nothing about when the last trade happened (docs/mainnet-hardening-facts.md
 * "Core / precompile semantics"). `undefined` (never confirmed live — cold start, or a
 * coin the book has never had liquidity for) counts as infinitely stale so a fresh
 * restart fails safe, not open. */
export function isSpotPxStale(lastFreshMs: number | undefined, now: number, staleMs: number): boolean {
  // Infinity = gate disabled (SPOT_PX_STALE_MS=0): testnet books are empty, so no coin
  // ever earns a freshness stamp and the gate would 503 every quote. Never disable with real bankroll.
  if (staleMs === Infinity) return false;
  return lastFreshMs === undefined || now - lastFreshMs > staleMs;
}

/** Per-coin leg pricer: best ask first, falling back to spotPx only while that coin's
 * last confirmed-live timestamp is within `staleMs`. Book fetch failures/empty books
 * don't touch freshness; only a real ask does. Throws when the only price available is
 * spotPx past the staleness window — the caller (server.ts) turns that into the
 * existing `stale-book` 503, same as an empty book with no spotPx source at all. */
export function makeLegPriceFetcher(opts: {
  fetchBook: (coin: string) => Promise<LegPriceObservation | null>;
  readSpotPx: (coin: string) => Promise<bigint>;
  /** House prior for a coin (registry `priorYes`), or undefined. Wins over spotPx and
   * is never stale-gated: it is our own number, not a Core placeholder. */
  prior?: (coin: string) => bigint | undefined;
  staleMs: number;
  now: () => number;
  onBookError?: (coin: string, err: unknown) => void;
}) {
  const lastFreshMs = new Map<string, number>();
  return {
    async fetch(coin: string): Promise<LegPriceObservation> {
      let ask: LegPriceObservation | null = null;
      try {
        ask = await opts.fetchBook(coin);
        if (ask !== null) lastFreshMs.set(coin, opts.now());
      } catch (err) {
        opts.onBookError?.(coin, err);
      }
      if (ask !== null) return ask;
      const prior = opts.prior?.(coin);
      if (prior !== undefined) {
        return { priceWad: prior, source: "prior", observedAtMs: opts.now(), depthWad: null, vwapWad: null, freshnessMs: null };
      }
      if (isSpotPxStale(lastFreshMs.get(coin), opts.now(), opts.staleMs)) {
        throw new Error(`spotPx stale for coin ${coin}`);
      }
      const observedAtMs = opts.now();
      const lastFresh = lastFreshMs.get(coin);
      return {
        priceWad: await opts.readSpotPx(coin),
        source: "spotPx",
        observedAtMs,
        depthWad: null,
        vwapWad: null,
        freshnessMs: lastFresh === undefined ? null : observedAtMs - lastFresh,
      };
    },
    /** ms since this coin was last confirmed live, or null if never confirmed. */
    ageMs(coin: string): number | null {
      const t = lastFreshMs.get(coin);
      return t === undefined ? null : opts.now() - t;
    },
  };
}

/** /health per-coin freshness map: every coinYes/coinNo in the registry -> its age. */
export function buildPriceFreshness(
  markets: Iterable<{ coinYes: string; coinNo: string }>,
  ageMs: (coin: string) => number | null,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const m of markets) {
    out[m.coinYes] = ageMs(m.coinYes);
    out[m.coinNo] = ageMs(m.coinNo);
  }
  return out;
}
