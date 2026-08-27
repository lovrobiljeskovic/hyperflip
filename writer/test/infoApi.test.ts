import { test } from "node:test";
import assert from "node:assert/strict";
import { bestAskWad, fetchBestAskWad } from "../src/infoApi.js";
import { parseDecimalToUnits } from "../src/pure.js";

const DEPTH_10 = parseDecimalToUnits("10", 18);
const DEPTH_50 = parseDecimalToUnits("50", 18);

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

test("bestAskWad takes first ask level px as WAD when it alone covers minDepthWad", () => {
  const book = {
    levels: [
      [{ px: "0.60", sz: "100", n: 1 }],
      [{ px: "0.65", sz: "50", n: 1 }],
    ],
  };
  assert.equal(bestAskWad(book, DEPTH_10), 650_000_000_000_000_000n);
});

test("bestAskWad returns null on empty ask side", () => {
  assert.equal(bestAskWad({ levels: [[{ px: "0.6", sz: "1", n: 1 }], []] }, DEPTH_10), null);
  assert.equal(bestAskWad({}, DEPTH_10), null);
});

test("bestAskWad ignores a spoofed 1-lot top and volume-weights across the depth-covering level", () => {
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
  assert.equal(bestAskWad(book, DEPTH_10), 698_000_000_000_000_000n);
});

test("bestAskWad returns null when the book never reaches minDepthWad — too thin, same signal as empty", () => {
  const book = {
    levels: [
      [],
      [
        { px: "0.50", sz: "1", n: 1 },
        { px: "0.60", sz: "2", n: 1 }, // cumulative sz 3, well short of a depth-50 requirement
      ],
    ],
  };
  assert.equal(bestAskWad(book, DEPTH_50), null);
});

test("bestAskWad: minDepthWad 0 restores plain best-ask behavior", () => {
  const book = { levels: [[], [{ px: "0.65", sz: "1", n: 1 }]] };
  assert.equal(bestAskWad(book, 0n), 650_000_000_000_000_000n);
});
