import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeBreakdown, priceParlay, totalEdgeBps } from "../src/pricing.js";
import { WAD } from "../src/pure.js";

const HALF = WAD / 2n; // leg price 0.50

test("two 0.50 legs, zero edge: 4x payout", () => {
  const r = priceParlay([HALF, HALF], 1_000_000n, 0n, 100n);
  assert.ok(r.ok);
  assert.equal(r.premium, 1_000_000n);
  assert.equal(r.maxPayout, 4_000_000n);
});

test("edge shrinks payout, rounds down (house-favorable)", () => {
  // price = 0.25 * 1.05 = 0.2625; payout = 1_000_000 / 0.2625 = 3_809_523.8... -> 3_809_523
  const r = priceParlay([HALF, HALF], 1_000_000n, 500n, 100n);
  assert.ok(r.ok);
  assert.equal(r.maxPayout, 3_809_523n);
});

test("minPremiumBps floor caps payout", () => {
  // ten longshot legs would exceed stake*10000/100 = 100x cap
  const longshot = WAD / 10n; // 0.10
  const r = priceParlay([longshot, longshot, longshot], 1_000_000n, 0n, 100n);
  assert.ok(r.ok);
  assert.equal(r.maxPayout, 100_000_000n); // capped at 100x, not 1000x
});

test("rejects leg price out of (0,1)", () => {
  assert.equal(priceParlay([WAD], 1_000_000n, 0n, 100n).ok, false);
  assert.equal(priceParlay([0n], 1_000_000n, 0n, 100n).ok, false);
});

test("rejects when edge pushes price to >= 1 (payout <= stake)", () => {
  const high = (WAD * 99n) / 100n; // 0.99
  const r = priceParlay([high], 1_000_000n, 200n, 100n); // 0.99 * 1.02 > 1
  assert.equal(r.ok, false);
});

test("rejects non-positive stake", () => {
  assert.equal(priceParlay([HALF], 0n, 0n, 100n).ok, false);
});

test("edge scales with leg count: every leg past the first adds legEdgeBps", () => {
  const two = edgeBreakdown(2, 0n, 500n, 300n, 300n);
  const five = edgeBreakdown(5, 0n, 500n, 300n, 300n);
  assert.equal(totalEdgeBps(two), 800n); // 500 + 300*1
  assert.equal(totalEdgeBps(five), 1700n); // 500 + 300*4
});

test("cluster pairs and leg count are separate axes", () => {
  const e = edgeBreakdown(3, 1n, 500n, 300n, 300n);
  assert.equal(e.baseBps, 500n);
  assert.equal(e.legBps, 600n); // 2 legs past the first
  assert.equal(e.clusterBps, 300n); // 1 same-cluster pair
  assert.equal(totalEdgeBps(e), 1400n);
});

test("legEdgeBps=0 restores flat pricing regardless of leg count", () => {
  assert.equal(totalEdgeBps(edgeBreakdown(5, 0n, 500n, 0n, 300n)), 500n);
});

test("a longer ticket really does hold more of the stake", () => {
  // Same 0.50 legs either side; only leg count differs. House margin per ticket
  // is stake - prod(p)*maxPayout, so a bigger edge must leave a smaller payout.
  const legs2 = [HALF, HALF];
  const legs4 = [HALF, HALF, HALF, HALF];
  const p2 = priceParlay(legs2, 1_000_000n, totalEdgeBps(edgeBreakdown(2, 0n, 500n, 300n, 300n)), 100n);
  const p4 = priceParlay(legs4, 1_000_000n, totalEdgeBps(edgeBreakdown(4, 0n, 500n, 300n, 300n)), 100n);
  assert.ok(p2.ok && p4.ok);
  // fair 2-leg = 4x, fair 4-leg = 16x; hold = 1 - fair/actual expressed on payout
  const hold2 = 1 - Number(p2.maxPayout) / 4_000_000;
  const hold4 = 1 - Number(p4.maxPayout) / 16_000_000;
  assert.ok(hold4 > hold2, `expected 4-leg hold ${hold4} > 2-leg hold ${hold2}`);
});
