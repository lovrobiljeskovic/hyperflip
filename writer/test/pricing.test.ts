import { test } from "node:test";
import assert from "node:assert/strict";
import { priceParlay } from "../src/pricing.js";
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
