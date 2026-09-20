import { test } from "node:test";
import assert from "node:assert/strict";
import { dominatingLeg, independentJointProbWad, edgeBreakdown, priceParlay, totalEdgeBps } from "../src/pricing.js";
import { WAD } from "../src/pure.js";

const QUARTER = WAD / 4n; // joint probability 0.25 — e.g. two independent 0.50 legs

test("joint 0.25, zero edge: 4x payout", () => {
  const r = priceParlay(QUARTER, 1_000_000n, 0n, 100n);
  assert.ok(r.ok);
  assert.equal(r.premium, 1_000_000n);
  assert.equal(r.maxPayout, 4_000_000n);
});

test("edge shrinks payout, rounds down (house-favorable)", () => {
  // price = 0.25 + 0.25 * 0.75 * 0.05 = 0.259375; payout = 1_000_000 / 0.259375 = 3_855_421.6... -> 3_855_421
  const r = priceParlay(QUARTER, 1_000_000n, 500n, 100n);
  assert.ok(r.ok);
  assert.equal(r.maxPayout, 3_855_421n);
});

test("edge is p(1-p)-shaped: a heavy favourite still pays, takeout vanishes at the extremes", () => {
  // p = 0.95, edge 5%: price = 0.95 + 0.95 * 0.05 * 0.05 = 0.952375 -> 1.05x, not 1.0025x
  const fav = priceParlay((WAD * 95n) / 100n, 1_000_000n, 500n, 100n);
  assert.ok(fav.ok);
  assert.equal(fav.maxPayout, 1_050_006n);
  // takeout as a share of stake = edge * (1 - p): 2.5% at a coin flip, 4.75% at p = 0.05
  const flip = priceParlay(WAD / 2n, 1_000_000n, 500n, 100n);
  const dog = priceParlay(WAD / 20n, 1_000_000n, 500n, 100n);
  assert.ok(flip.ok && dog.ok);
  assert.equal(flip.maxPayout, 1_951_219n); // 1 / 0.5125
  assert.equal(dog.maxPayout, 19_093_078n); // 1 / 0.052375
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

test("edge can never push the price to >= 1; a 0.99 joint still pays over 1x", () => {
  const r = priceParlay((WAD * 99n) / 100n, 1_000_000n, 200n, 100n);
  assert.ok(r.ok);
  assert.ok(r.maxPayout > 1_000_000n);
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

// NVDA-above-230 (p=0.1318) Core fair is 7_587_253; a collapsed-correlation
// parlay quote of 7.03x pays less while needing BOTH legs to win.
test("dominatingLeg flags a quote at or below one leg's Core fair payout", () => {
  const prices = [(WAD * 1318n) / 10000n, (WAD * 4405n) / 10000n];
  assert.equal(dominatingLeg(prices, 1_000_000n, 7_030_000n), 0);
  assert.equal(dominatingLeg(prices, 1_000_000n, 7_587_253n), 0); // boundary: equal is still dominated
  assert.equal(dominatingLeg(prices, 1_000_000n, 7_600_000n), -1);
});

test("dominatingLeg ignores a zero leg price", () => {
  assert.equal(dominatingLeg([0n, WAD / 2n], 1_000_000n, 3_000_000n), -1);
});

test("independentJointProbWad multiplies leg prices", () => {
  assert.equal(independentJointProbWad([WAD / 2n, WAD / 4n]), WAD / 8n);
  assert.equal(independentJointProbWad([WAD]), WAD);
  assert.equal(independentJointProbWad([WAD / 2n, 0n]), 0n);
});
