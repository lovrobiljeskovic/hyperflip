import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coinIdForOutcome,
  deltaMatches,
  evmToOutcomeWei,
  expectedDelta,
  fractionWadFromSettledValue,
  newestSampleBefore,
  opKey,
  parseCoinId,
  parseDecimalToUnits,
  resolveBalanceCheck,
} from "../src/pure.js";

test("opKey matches Solidity keccak256(abi.encode(vault, opId))", () => {
  // Ground truth computed independently with foundry's cast, not viem:
  //   cast abi-encode "f(address,uint256)" 0x1234567890123456789012345678901234567890 42
  //   cast keccak <that>
  const got = opKey("0x1234567890123456789012345678901234567890", 42n);
  assert.equal(got, "0x4220827be32e7c245e0cc491b25d54bf231d74059611d02456f351610e80d78c");
});

test("opKey differs by opId (padded word, not concatenation ambiguity)", () => {
  const vault = "0x1234567890123456789012345678901234567890";
  assert.notEqual(opKey(vault, 1n), opKey(vault, 2n));
});

test("parseCoinId strips '+' and parses the outcome coin id", () => {
  assert.equal(parseCoinId("+123850"), 123850n);
  assert.equal(parseCoinId("+123851"), 123851n);
});

test("parseCoinId rejects non-outcome coins", () => {
  assert.equal(parseCoinId("USDC"), null);
  assert.equal(parseCoinId("-123850"), null);
  assert.equal(parseCoinId("+12a"), null);
});

test("coinIdForOutcome matches the spike-observed encoding", () => {
  // FINDINGS.md: split on outcome 12385 minted coins "+123850" (yes) and "+123851" (no).
  assert.equal(coinIdForOutcome(12385, true), 123850n);
  assert.equal(coinIdForOutcome(12385, false), 123851n);
});

test("parseDecimalToUnits: whole share", () => {
  assert.equal(parseDecimalToUnits("10.0", 5), 1_000_000n);
});

test("parseDecimalToUnits: sub-share fraction, no decimal point, and truncation", () => {
  assert.equal(parseDecimalToUnits("0.007", 5), 700n);
  assert.equal(parseDecimalToUnits("5", 5), 500_000n);
  assert.equal(parseDecimalToUnits("1.123456", 5), 112_345n); // extra digit truncated, not rounded
});

test("evmToOutcomeWei mirrors CoreConstants._convert for 6-decimal USDC", () => {
  const evmUnitsPerShare = 1_000_000n; // 1e6, real testnet USDC decimals
  assert.equal(evmToOutcomeWei(10_000_000n, evmUnitsPerShare), 1_000_000n); // 10 USDC -> 10 shares @1e5
});

test("evmToOutcomeWei rejects dust the same way Solidity reverts", () => {
  // 15 wei of 6-decimal USDC: scaled = 15 * 1e5 = 1_500_000, /1e6 truncates to 1 (w>0) but
  // 1 * 1e6 != 1_500_000 -- the exact-division check must catch it, not the zero check.
  assert.throws(() => evmToOutcomeWei(15n, 1_000_000n), /DUST/);
});

test("evmToOutcomeWei rejects zero the same way Solidity reverts", () => {
  assert.throws(() => evmToOutcomeWei(0n, 1_000_000n), /BAD_AMOUNT/);
});

test("expectedDelta / deltaMatches: split credits, merge debits", () => {
  assert.equal(expectedDelta(0, 1_000_000n), 1_000_000n);
  assert.equal(expectedDelta(1, 1_000_000n), -1_000_000n);
  assert.equal(deltaMatches(0n, 1_000_000n, 0, 1_000_000n), true);
  assert.equal(deltaMatches(1_000_000n, 0n, 1, 1_000_000n), true);
  assert.equal(deltaMatches(0n, 500_000n, 0, 1_000_000n), false); // partial delta, not confirmed
});

test("fractionWadFromSettledValue scales 1e8 settledValue to 1e18 fractionWad", () => {
  assert.equal(fractionWadFromSettledValue(100_000_000n), 1_000_000_000_000_000_000n); // fraction 1.0
  assert.equal(fractionWadFromSettledValue(0n), 0n);
  assert.equal(fractionWadFromSettledValue(50_000_000n), 500_000_000_000_000_000n); // fraction 0.5
});

test("resolveBalanceCheck: matching delta always attests true, confidence irrelevant", () => {
  assert.equal(resolveBalanceCheck(0n, 1_000_000n, 0, 1_000_000n, 999_999, 60_000, true), "attest-true");
  assert.equal(resolveBalanceCheck(0n, 1_000_000n, 0, 1_000_000n, 999_999, 60_000, false), "attest-true");
});

test("resolveBalanceCheck: no delta, timeout not yet elapsed -> wait regardless of confidence", () => {
  assert.equal(resolveBalanceCheck(0n, 0n, 0, 1_000_000n, 59_999, 60_000, true), "wait");
  assert.equal(resolveBalanceCheck(0n, 0n, 0, 1_000_000n, 59_999, 60_000, false), "wait");
});

test("resolveBalanceCheck: no delta, timeout elapsed, confident baseline -> attest-false", () => {
  assert.equal(resolveBalanceCheck(0n, 0n, 0, 1_000_000n, 60_001, 60_000, true), "attest-false");
});

test("resolveBalanceCheck CRITICAL: no delta, timeout elapsed, UNCONFIDENT baseline -> hold, never attest-false", () => {
  // This is the regression test for the critical finding: a rebuilt op whose pre-op baseline
  // status is unknown must never have "no delta observed" read as evidence of a drop.
  assert.equal(resolveBalanceCheck(0n, 0n, 0, 1_000_000n, 60_001, 60_000, false), "hold");
  assert.notEqual(resolveBalanceCheck(0n, 0n, 0, 1_000_000n, 10_000_000, 60_000, false), "attest-false");
});

test("newestSampleBefore picks the latest qualifying sample, not just any one before the cutoff", () => {
  const samples = [
    { readAt: 1_000, balance: 10n },
    { readAt: 3_000, balance: 30n },
    { readAt: 5_000, balance: 50n }, // after cutoff, must be excluded
  ];
  assert.deepEqual(newestSampleBefore(samples, 4_000), { readAt: 3_000, balance: 30n });
});

test("newestSampleBefore includes a sample exactly at the cutoff (<=, not <)", () => {
  const samples = [{ readAt: 2_000, balance: 20n }];
  assert.deepEqual(newestSampleBefore(samples, 2_000), { readAt: 2_000, balance: 20n });
});

test("newestSampleBefore CRITICAL: returns undefined (never a post-execution sample) when nothing qualifies", () => {
  // This is the regression test for the live-baseline fix: with no sample provably pre-dating the
  // OpQueued block (e.g. right after startup), the caller must fall back explicitly rather than
  // silently accepting a later, possibly post-execution, sample.
  const samples = [
    { readAt: 9_000, balance: 90n },
    { readAt: 9_500, balance: 95n },
  ];
  assert.equal(newestSampleBefore(samples, 4_000), undefined);
  assert.equal(newestSampleBefore([], 4_000), undefined);
});

test("newestSampleBefore CRITICAL: clock-skew margin excludes a sample that only qualifies without it", () => {
  // A sample at 3_900 is <= the raw cutoff (4_000) but would be excluded once a keeper-clock-behind
  // margin of 2_000ms is applied (effective cutoff 2_000) — this is exactly the case a keeper clock
  // running behind chain time could otherwise misclassify as provably pre-op.
  const samples = [
    { readAt: 1_500, balance: 15n },
    { readAt: 3_900, balance: 39n },
  ];
  assert.deepEqual(newestSampleBefore(samples, 4_000, 2_000), { readAt: 1_500, balance: 15n });
  assert.deepEqual(newestSampleBefore(samples, 4_000), { readAt: 3_900, balance: 39n }); // no margin: default behavior unchanged
});

test("newestSampleBefore CRITICAL: MAX_SAMPLE_AGE excludes a stale sample even though it predates the cutoff", () => {
  // A sample from long before the cutoff is provably pre-op but too stale to trust as "current" —
  // a stalled sampler must not be able to serve an arbitrarily old balance as a confident baseline.
  const samples = [{ readAt: 100, balance: 1n }];
  assert.equal(newestSampleBefore(samples, 100_000, 0, 60_000), undefined);
  assert.deepEqual(newestSampleBefore(samples, 100_000, 0, 200_000), { readAt: 100, balance: 1n });
});
