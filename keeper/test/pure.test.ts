import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blockChunks,
  coinIdForOutcome,
  decodeFractionCache,
  deltaMatches,
  encodeFractionCache,
  encodedOutcomeAssetId,
  evmToOutcomeWei,
  expectedDelta,
  fractionWadFromSettledValue,
  newestSampleBefore,
  opKey,
  parseCoinId,
  parseDecimalToUnits,
  parseRegistryMarkets,
  resolveBalanceCheck,
  WAD,
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

test("fraction cache CRITICAL: survives a round trip so a restart mid-prune-window can still relay", () => {
  // The whole point: a keeper that observed status 2, then restarted before settle() landed, must
  // come back holding the fraction. Losing it means the pruned vault can never be settled.
  const cache = new Map([
    ["0xAAAA000000000000000000000000000000000001", WAD],
    ["0xbbbb000000000000000000000000000000000002", WAD / 2n],
    ["0xcccc000000000000000000000000000000000003", 0n],
  ]);
  const back = decodeFractionCache(encodeFractionCache(cache));
  assert.equal(back.get("0xaaaa000000000000000000000000000000000001"), WAD); // lowercased, so checksum-case config churn cannot orphan it
  assert.equal(back.get("0xbbbb000000000000000000000000000000000002"), WAD / 2n);
  assert.equal(back.get("0xcccc000000000000000000000000000000000003"), 0n); // a real "YES lost" fraction, not a missing entry
});

test("fraction cache: corrupt input degrades to empty rather than throwing or inventing a fraction", () => {
  // An unreadable cache must land on the manual-recovery alert, never on a fabricated relay.
  assert.equal(decodeFractionCache("").size, 0);
  assert.equal(decodeFractionCache("{ not json").size, 0);
  assert.equal(decodeFractionCache("null").size, 0);
  assert.equal(decodeFractionCache("[1,2,3]").size, 0);
  assert.equal(decodeFractionCache('{"0xaaa":"not-a-number"}').size, 0);
  assert.equal(decodeFractionCache('{"0xaaa":123}').size, 0); // number, not string: reject
  assert.equal(decodeFractionCache(`{"0xaaa":"${(WAD + 1n).toString()}"}`).size, 0); // settle() would revert BAD_FRACTION
  // one bad entry must not discard the good ones
  const mixed = decodeFractionCache(`{"0xaaa":"bad","0xbbb":"${WAD.toString()}"}`);
  assert.equal(mixed.size, 1);
  assert.equal(mixed.get("0xbbb"), WAD);
});

test("parseRegistryMarkets CRITICAL: keeper watches exactly what the writer quotes", () => {
  // Two hand-synced market lists is how a market becomes quotable-but-unsettleable.
  const registry = JSON.stringify({
    markets: [
      { vault: "0x69288D331911984fAeC8Af82688B7f718e2bB541", expiryMs: 1787194800000 },
      { vault: "0xd6959Ac6a60b5af8edFf8165f642FBc7D02C1c0E" }, // no expiry: allowed, just unwatched
    ],
  });
  assert.deepEqual(parseRegistryMarkets(registry), [
    { vault: "0x69288D331911984fAeC8Af82688B7f718e2bB541", expiryMs: 1787194800000 },
    { vault: "0xd6959Ac6a60b5af8edFf8165f642FBc7D02C1c0E", expiryMs: undefined },
  ]);
  // A non-numeric expiry must not become a NaN deadline that alerts on every tick forever.
  const bogus = JSON.stringify({ markets: [{ vault: "0x69288D331911984fAeC8Af82688B7f718e2bB541", expiryMs: "soon" }] });
  assert.equal(parseRegistryMarkets(bogus)[0].expiryMs, undefined);
});

test("parseRegistryMarkets: a malformed registry fails loudly rather than watching a short list", () => {
  // Silently dropping an entry here is the whole bug this replaces — a keeper watching fewer
  // vaults than the writer quotes looks healthy right up until an expiry strands one.
  assert.throws(() => parseRegistryMarkets("{ not json"));
  assert.throws(() => parseRegistryMarkets("{}"), /no markets array/);
  assert.throws(() => parseRegistryMarkets('{"markets":[]}'), /lists no markets/);
  assert.throws(() => parseRegistryMarkets('{"markets":[{"title":"no vault"}]}'), /invalid vault/);
  assert.throws(() => parseRegistryMarkets('{"markets":[{"vault":"0xnothex"}]}'), /invalid vault/);
  assert.throws(() => parseRegistryMarkets('{"markets":[{"vault":"0x1234"}]}'), /invalid vault/); // truncated address
});

test("encodedOutcomeAssetId matches L1Read.sol: 100000000 + 10*outcome + side", () => {
  // outcome 13734 = live NVDA market, coinYes "#137340" -> asset id 100137340 (testnet-verified)
  assert.equal(encodedOutcomeAssetId(13734, true), 100_137_340n);
  assert.equal(encodedOutcomeAssetId(13734, false), 100_137_341n);
  assert.equal(encodedOutcomeAssetId(0, true), 100_000_000n);
});

test("blockChunks pages newest-first in <=chunk ranges covering exactly (head-lookback, head]", () => {
  assert.deepEqual(blockChunks(10_000n, 2_500n, 1_000n), [
    { from: 9_001n, to: 10_000n },
    { from: 8_001n, to: 9_000n },
    { from: 7_501n, to: 8_000n },
  ]);
});

test("blockChunks clamps at genesis instead of going negative", () => {
  assert.deepEqual(blockChunks(500n, 7_200n, 1_000n), [{ from: 1n, to: 500n }]);
});
