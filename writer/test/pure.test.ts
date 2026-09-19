import { test } from "node:test";
import assert from "node:assert/strict";
import { bankrollRoom, blockRanges, clientIp, isStalled, lowBankrollAlerter, stallThresholdMs } from "../src/pure.js";

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

test("bankrollRoom is min(allowance, balance)", () => {
  assert.equal(bankrollRoom(500n, 200n), 200n);
  assert.equal(bankrollRoom(100n, 200n), 100n);
});

test("lowBankrollAlerter fires once per dip and re-arms on recovery", () => {
  const alert = lowBankrollAlerter(100n);
  assert.equal(alert(150n), false);
  assert.equal(alert(50n), true);
  assert.equal(alert(10n), false);
  assert.equal(alert(100n), false);
  assert.equal(alert(99n), true);
});

test("clientIp reads the proxy-observed hop, not the client's header", () => {
  // Caddy appends the real peer, so a spoofed leftmost entry must not become the key.
  assert.equal(clientIp("1.2.3.4, 203.0.113.7"), "203.0.113.7");
  assert.equal(clientIp("203.0.113.7"), "203.0.113.7");
  // Repeated headers arrive as an array; the last one is the one our proxy set.
  assert.equal(clientIp(["1.2.3.4", "9.9.9.9, 203.0.113.7"]), "203.0.113.7");
  assert.equal(clientIp(undefined, "198.51.100.2"), "198.51.100.2");
  assert.equal(clientIp("", undefined), "unknown");
});
