import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coinIdForOutcome,
  deltaMatches,
  evmToOutcomeWei,
  expectedDelta,
  fractionWadFromSettledValue,
  opKey,
  parseCoinId,
  parseDecimalToUnits,
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
