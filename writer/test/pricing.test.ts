import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeBreakdown, priceParlay, totalEdgeBps } from "../src/pricing.js";
import { WAD } from "../src/pure.js";

const QUARTER = WAD / 4n; // joint probability 0.25 — e.g. two independent 0.50 legs

test("joint 0.25, zero edge: 4x payout", () => {
  const r = priceParlay(QUARTER, 1_000_000n, 0n, 100n);
  assert.ok(r.ok);
  assert.equal(r.premium, 1_000_000n);
  assert.equal(r.maxPayout, 4_000_000n);
});

test("edge shrinks payout, rounds down (house-favorable)", () => {
  // price = 0.25 * 1.05 = 0.2625; payout = 1_000_000 / 0.2625 = 3_809_523.8... -> 3_809_523
  const r = priceParlay(QUARTER, 1_000_000n, 500n, 100n);
  assert.ok(r.ok);
  assert.equal(r.maxPayout, 3_809_523n);
});

test("a higher joint probability pays less — the whole point of correlation", () => {
  const independent = priceParlay(QUARTER, 1_000_000n, 0n, 100n);
  const correlated = priceParlay(WAD / 2n, 1_000_000n, 0n, 100n);
  assert.ok(independent.ok && correlated.ok);
  assert.ok(correlated.maxPayout < independent.maxPayout);
});

test("minPremiumBps floor caps payout at 100x", () => {
  const r = priceParlay(WAD / 1000n, 1_000_000n, 0n, 100n);
  assert.ok(r.ok);
  assert.equal(r.maxPayout, 100_000_000n);
});

test("rejects a joint probability outside (0,1)", () => {
  assert.equal(priceParlay(WAD, 1_000_000n, 0n, 100n).ok, false);
  assert.equal(priceParlay(0n, 1_000_000n, 0n, 100n).ok, false);
});

test("rejects when edge pushes the price to >= 1", () => {
  const r = priceParlay((WAD * 99n) / 100n, 1_000_000n, 200n, 100n);
  assert.equal(r.ok, false);
});

test("rejects a non-positive stake", () => {
  assert.equal(priceParlay(QUARTER, 0n, 0n, 100n).ok, false);
});

test("edge is base plus per-extra-leg, with no correlation component", () => {
  const e = edgeBreakdown(3, 500n, 300n);
  assert.equal(e.baseBps, 500n);
  assert.equal(e.legBps, 600n);
  assert.equal(totalEdgeBps(e), 1100n);
});

test("a single leg carries base edge only", () => {
  assert.equal(totalEdgeBps(edgeBreakdown(1, 500n, 300n)), 500n);
});
