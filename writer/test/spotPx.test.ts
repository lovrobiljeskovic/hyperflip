import assert from "node:assert/strict";
import test from "node:test";
import { decodeAbiParameters, encodeAbiParameters } from "viem";
import { buildPriceFreshness, isSpotPxStale, makeLegPriceFetcher, readSpotPxWad, SPOT_PX_PRECOMPILE } from "../src/spotPx.js";

/** Fake viem client: records the call, returns a canned uint64 px encoding. */
function fakeClient(raw: bigint) {
  const calls: { to?: string; data?: `0x${string}` }[] = [];
  return {
    calls,
    call: async (args: { to?: string; data?: `0x${string}` }) => {
      calls.push(args);
      return { data: encodeAbiParameters([{ type: "uint64" }], [raw]) };
    },
  };
}

test("readSpotPxWad sends the encoded outcome asset id to 0x808 and scales 1e8 px to WAD", async () => {
  // Testnet-verified 2026-08-25: NVDA outcome coin 137340, l2Book mid 0.1319,
  // spotPx raw 13190000 — so the raw px is 1e8-scaled and WAD = raw * 1e10.
  const client = fakeClient(13_190_000n);
  const wad = await readSpotPxWad(client as never, 137340n);
  assert.equal(wad, 131_900_000_000_000_000n); // 0.1319e18
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].to, SPOT_PX_PRECOMPILE);
  const [index] = decodeAbiParameters([{ type: "uint32" }], client.calls[0].data!);
  assert.equal(index, 100_137_340); // 100000000 + coin id
});

test("readSpotPxWad throws on an empty response rather than inventing a zero price", async () => {
  const client = { call: async () => ({ data: undefined }) };
  await assert.rejects(() => readSpotPxWad(client as never, 137340n), /empty spotPx/);
});

test("isSpotPxStale: undefined lastFreshMs (never confirmed live) is stale", () => {
  assert.equal(isSpotPxStale(undefined, 1_000_000, 60_000), true);
});

test("isSpotPxStale: within the window is fresh, past it is stale", () => {
  assert.equal(isSpotPxStale(1_000_000, 1_050_000, 60_000), false); // 50s old, 60s window
  assert.equal(isSpotPxStale(1_000_000, 1_070_000, 60_000), true); // 70s old
});

test("makeLegPriceFetcher: book-empty + spotPx-stale (coin never confirmed live) refuses the leg", async () => {
  const fetcher = makeLegPriceFetcher({
    fetchBook: async () => null, // empty book
    readSpotPx: async () => 1n,
    staleMs: 60_000,
    now: () => 1_000_000,
  });
  await assert.rejects(() => fetcher.fetch("+1"), /stale/);
  assert.equal(fetcher.ageMs("+1"), null);
});

test("makeLegPriceFetcher: book-empty + spotPx-fresh (recent book fetch for this coin) prices the leg", async () => {
  let now = 1_000_000;
  const fetcher = makeLegPriceFetcher({
    // First call has a book price (stamps freshness), second call (30s later) has none.
    fetchBook: async () => (now === 1_000_000 ? 5n : null),
    readSpotPx: async () => 7n,
    staleMs: 60_000,
    now: () => now,
  });
  assert.equal(await fetcher.fetch("+1"), 5n); // stamps lastFreshMs for "+1"
  now = 1_030_000; // 30s later, still inside the 60s window
  assert.equal(await fetcher.fetch("+1"), 7n); // book empty, falls back to spotPx
  assert.equal(fetcher.ageMs("+1"), 30_000);
});

test("makeLegPriceFetcher: a book fetch throwing does not stamp freshness and does not itself reject the leg", async () => {
  const fetcher = makeLegPriceFetcher({
    fetchBook: async () => {
      throw new Error("info API down");
    },
    readSpotPx: async () => 9n,
    staleMs: 60_000,
    now: () => 1_000_000,
  });
  // Never confirmed live -> spotPx is stale by definition -> refused, not a thrown book error.
  await assert.rejects(() => fetcher.fetch("+1"), /stale/);
});

test("makeLegPriceFetcher: freshness is tracked per coin, not globally", async () => {
  let now = 1_000_000;
  const bookedOnce = new Set<string>();
  const fetcher = makeLegPriceFetcher({
    // "+1" has a book price exactly once (its first fetch); every other call, and
    // every call for "+2", sees an empty book.
    fetchBook: async (coin) => {
      if (coin === "+1" && !bookedOnce.has(coin)) {
        bookedOnce.add(coin);
        return 5n;
      }
      return null;
    },
    readSpotPx: async () => 7n,
    staleMs: 60_000,
    now: () => now,
  });
  assert.equal(await fetcher.fetch("+1"), 5n); // "+1" confirmed live
  now = 1_010_000;
  // "+2" has never had a book price, so its spotPx fallback is refused even
  // though "+1" (a different coin on the same market) is fresh.
  await assert.rejects(() => fetcher.fetch("+2"), /stale/);
  assert.equal(await fetcher.fetch("+1"), 7n); // book now empty, falls back to still-fresh spotPx
});

test("buildPriceFreshness: /health per-coin age — fresh coin is a number, unconfirmed coin is null", async () => {
  const fetcher = makeLegPriceFetcher({
    fetchBook: async (coin) => (coin === "+1" ? 5n : null), // "+1" always books; "+2" never does
    readSpotPx: async () => 7n,
    staleMs: 60_000,
    now: () => 1_000_000,
  });
  await fetcher.fetch("+1"); // stamps "+1" fresh
  const markets = [{ coinYes: "+1", coinNo: "+2" }];
  const freshness = buildPriceFreshness(markets, (coin) => fetcher.ageMs(coin));
  assert.deepEqual(freshness, { "+1": 0, "+2": null });
});
