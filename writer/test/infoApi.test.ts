import { test } from "node:test";
import assert from "node:assert/strict";
import { bestAsk, fetchBestAskWad } from "../src/infoApi.js";
import { parseUnits } from "viem";

const DEPTH_10 = parseUnits("10", 18);
const DEPTH_50 = parseUnits("50", 18);

test("fetchBestAskWad returns null on an empty book instead of consulting allMids", async (t) => {
  // allMids carries zero outcome coins (verified 2026-08-25), so the old
  // allMids fallback could never answer — empty book must surface as null so
  // the caller can fall back to the 0x808 spotPx precompile instead.
  const calls: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: { body?: string }) => {
    calls.push(JSON.parse(init?.body ?? "{}"));
    return new Response(JSON.stringify({ levels: [[], []] }), { status: 200 });
  });
  assert.equal(await fetchBestAskWad("https://info.example/info", "#137340", DEPTH_10), null);
  assert.equal(calls.length, 1); // one l2Book call, no second allMids request
});

test("bestAsk takes first ask level px as WAD when it alone covers minDepthWad", () => {
  const book = {
    levels: [
      [{ px: "0.60", sz: "100", n: 1 }],
      [{ px: "0.65", sz: "50", n: 1 }],
    ],
  };
  assert.equal(bestAsk(book, DEPTH_10)?.priceWad ?? null, 650_000_000_000_000_000n);
});

test("bestAsk returns null on empty ask side", () => {
  assert.equal(bestAsk({ levels: [[{ px: "0.6", sz: "1", n: 1 }], []] }, DEPTH_10)?.priceWad ?? null, null);
  assert.equal(bestAsk({}, DEPTH_10)?.priceWad ?? null, null);
});

test("bestAsk ignores a spoofed 1-lot top and volume-weights across the depth-covering level", () => {
  // 1-lot spoof at 0.50, fat second level at 0.70. minDepth 10 isn't covered by
  // the 1-lot alone, so the walk continues into the second level.
  const book = {
    levels: [
      [],
      [
        { px: "0.50", sz: "1", n: 1 },
        { px: "0.70", sz: "99", n: 1 },
      ],
    ],
  };
  // vwap = (0.50*1 + 0.70*99) / 100 = 69.8 / 100 = 0.698, which is worse (higher)
  // than the spoofed best ask of 0.50, so that's the price used.
  assert.equal(bestAsk(book, DEPTH_10)?.priceWad ?? null, 698_000_000_000_000_000n);
});

test("price metadata: a depth-covering book preserves cumulative depth, VWAP, source, and observation time", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    levels: [[], [{ px: "0.50", sz: "1", n: 1 }, { px: "0.70", sz: "99", n: 1 }]],
  }), { status: 200 }));
  assert.deepEqual(
    await fetchBestAskWad("https://info.example/info", "#137340", DEPTH_10, () => 123),
    {
      priceWad: 698_000_000_000_000_000n,
      source: "l2Book",
      observedAtMs: 123,
      depthWad: 100_000_000_000_000_000_000n,
      vwapWad: 698_000_000_000_000_000n,
      freshnessMs: null,
    },
  );
});

test("bestAsk returns null when the book never reaches minDepthWad — too thin, same signal as empty", () => {
  const book = {
    levels: [
      [],
      [
        { px: "0.50", sz: "1", n: 1 },
        { px: "0.60", sz: "2", n: 1 }, // cumulative sz 3, well short of a depth-50 requirement
      ],
    ],
  };
  assert.equal(bestAsk(book, DEPTH_50)?.priceWad ?? null, null);
});

test("bestAsk: minDepthWad 0 restores plain best-ask behavior", () => {
  const book = { levels: [[], [{ px: "0.65", sz: "1", n: 1 }]] };
  assert.equal(bestAsk(book, 0n)?.priceWad ?? null, 650_000_000_000_000_000n);
});

test("viem parseUnits matches the old truncating parser on every fixture", () => {
  const fixtures: [string, number, bigint][] = [
    ["10", 18, 10_000_000_000_000_000_000n],
    ["50", 18, 50_000_000_000_000_000_000n],
    ["0.60", 18, 600_000_000_000_000_000n],
    ["0.65", 18, 650_000_000_000_000_000n],
    ["0.6", 18, 600_000_000_000_000_000n],
    ["0.50", 18, 500_000_000_000_000_000n],
    ["0.70", 18, 700_000_000_000_000_000n],
    ["0.05", 18, 50_000_000_000_000_000n],
    ["0.10", 18, 100_000_000_000_000_000n],
    ["100", 18, 100_000_000_000_000_000_000n],
    ["99", 18, 99_000_000_000_000_000_000n],
    ["1", 18, 1_000_000_000_000_000_000n],
    ["2", 18, 2_000_000_000_000_000_000n],
    ["100", 6, 100_000_000n],
  ];
  for (const [value, decimals, expected] of fixtures) assert.equal(parseUnits(value, decimals), expected, value);
});
