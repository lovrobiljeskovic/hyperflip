import { test } from "node:test";
import assert from "node:assert/strict";
import { blockRanges } from "../src/pure.js";

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
