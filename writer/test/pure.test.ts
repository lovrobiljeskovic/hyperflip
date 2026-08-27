import { test } from "node:test";
import assert from "node:assert/strict";
import { blockRanges, isStalled, stallThresholdMs } from "../src/pure.js";

test("blockRanges: single range when span fits", () => {
  assert.deepEqual(blockRanges(10n, 20n, 1000n), [{ from: 10n, to: 20n }]);
});

test("blockRanges: chunks at exact size boundaries, inclusive", () => {
  assert.deepEqual(blockRanges(0n, 2999n, 1000n), [
    { from: 0n, to: 999n },
    { from: 1000n, to: 1999n },
    { from: 2000n, to: 2999n },
  ]);
});

test("blockRanges: partial tail chunk", () => {
  assert.deepEqual(blockRanges(100n, 1150n, 1000n), [
    { from: 100n, to: 1099n },
    { from: 1100n, to: 1150n },
  ]);
});

test("blockRanges: empty when to < from", () => {
  assert.deepEqual(blockRanges(5n, 4n, 1000n), []);
});

test("blockRanges: single block", () => {
  assert.deepEqual(blockRanges(7n, 7n, 1000n), [{ from: 7n, to: 7n }]);
});

test("stallThresholdMs: scales with open count and tick interval, plus fixed margin", () => {
  assert.equal(stallThresholdMs(0, 60_000, 15_000), 15_000 + 120_000);
  assert.equal(stallThresholdMs(3, 60_000, 15_000), 3 * 60_000 + 15_000 + 120_000);
  assert.equal(stallThresholdMs(0, 60_000, 15_000, 5_000), 15_000 + 5_000);
});

test("isStalled: false within threshold, true once elapsed exceeds it", () => {
  const lastTickAt = 1_000_000;
  assert.equal(isStalled(lastTickAt, lastTickAt + 120_000, 120_000), false); // exactly at bound: not yet stalled
  assert.equal(isStalled(lastTickAt, lastTickAt + 120_001, 120_000), true);
  assert.equal(isStalled(lastTickAt, lastTickAt, 120_000), false); // no time elapsed
});
