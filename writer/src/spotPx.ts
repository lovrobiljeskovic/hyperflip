import { decodeAbiParameters, encodeAbiParameters, type PublicClient } from "viem";
import type { LegPriceObservation } from "./infoApi.js";

/** L1Read.sol SPOT_PX_PRECOMPILE_ADDRESS — accepts the encoded outcome asset id
 * 100000000 + coin id (= 10*outcome + side) since the 2026-08 testnet update. */
export const SPOT_PX_PRECOMPILE = "0x0000000000000000000000000000000000000808" as const;

/** Raw 0x808 read for an outcome coin, scaled to WAD. Core returns the px as a 1e8-scaled
 * uint64 (testnet-verified against l2Book mids 2026-08-25), so WAD = raw * 1e10. Latest state
 * only — pinned precompile eth_calls return live Core state (see keeper spec "Historical
 * reads"), which is fine here: a quote wants the freshest px there is. */
export async function readSpotPxWad(client: Pick<PublicClient, "call">, coinId: bigint): Promise<bigint> {
  const data = encodeAbiParameters([{ type: "uint32" }], [Number(100_000_000n + coinId)]);
  const { data: ret } = await client.call({ to: SPOT_PX_PRECOMPILE, data });
  if (!ret) throw new Error("empty spotPx response");
  const [raw] = decodeAbiParameters([{ type: "uint64" }], ret);
  return raw * 10n ** 10n;
}

/** Pure staleness predicate for a coin's spotPx fallback. `lastFreshMs` is the last
 * time we confirmed this coin's market was live — a book fetch that returned a real
 * ask, never a bare spotPx read: 0x808 carries no timestamp, so successfully reading
 * it says nothing about when the last trade happened (docs/mainnet-hardening-facts.md
 * "Core / precompile semantics"). `undefined` (never confirmed live — cold start, or a
 * coin the book has never had liquidity for) counts as infinitely stale so a fresh
 * restart fails safe, not open. */
export function isSpotPxStale(lastFreshMs: number | undefined, now: number, staleMs: number): boolean {
  // Infinity = gate disabled (SPOT_PX_STALE_MS=0). Testnet outcome books are
  // empty, so no coin ever earns a book-ask freshness stamp and the gate would
  // 503 every quote — the pickoff risk the gate closes is accepted there.
  // Mainnet keeps the finite default; never disable it with real bankroll.
  if (staleMs === Infinity) return false;
  return lastFreshMs === undefined || now - lastFreshMs > staleMs;
}

/** Per-coin leg pricer: best ask first, falling back to spotPx only while that coin's
 * last confirmed-live timestamp is within `staleMs`. Book fetch failures/empty books
 * don't touch freshness; only a real ask does. Throws when the only price available is
 * spotPx past the staleness window — the caller (maker.ts) turns that into the
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

/** Builds the /health per-coin freshness map: every coinYes/coinNo across the
 * registry, keyed to its age via the supplied lookup. Pulled out of index.ts's
 * health closure so it's unit-testable without booting main(). */
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
