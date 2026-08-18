import { test } from "node:test";
import assert from "node:assert/strict";
import { ExposureBook } from "../src/exposure.js";

const V1 = "0x1111111111111111111111111111111111111111";
const V2 = "0x2222222222222222222222222222222222222222";

test("check fails at-capacity when risk exceeds allowance minus reservations", () => {
  const b = new ExposureBook();
  b.reserve("q1", 60n, [V1], 1000);
  const r = b.check(50n, [V2], 100n, 1000n, 0);
  assert.deepEqual(r, { ok: false, reason: "at-capacity" });
});

test("expired reservations free capacity", () => {
  const b = new ExposureBook();
  b.reserve("q1", 60n, [V1], 1000);
  assert.equal(b.check(50n, [V2], 100n, 1000n, 1001).ok, true);
});

test("per-market cap counts reserved + open, case-insensitive", () => {
  const b = new ExposureBook();
  b.reserve("q1", 30n, [V1.toUpperCase().replace("0X", "0x")], 10_000);
  b.onMinted("q0", "7", 30n, [V1]);
  // market total 60; cap 80 -> risk 25 breaches V1 but not global (allowance 1000)
  const r = b.check(25n, [V1], 1000n, 80n, 0);
  assert.deepEqual(r, { ok: false, reason: "market-cap" });
  assert.equal(b.check(25n, [V2], 1000n, 80n, 0).ok, true);
});

test("onMinted converts reservation to open exposure (global freed, market kept)", () => {
  const b = new ExposureBook();
  b.reserve("q1", 40n, [V1], 10_000);
  b.onMinted("q1", "1", 40n, [V1]);
  assert.equal(b.reservedGlobal(0), 0n); // allowance now reflects it on-chain
  assert.equal(b.perMarket(V1, 0), 40n);
});

test("onMinted without prior reservation still records open exposure (crash recovery)", () => {
  const b = new ExposureBook();
  b.onMinted("unknown", "2", 40n, [V1]);
  assert.equal(b.perMarket(V1, 0), 40n);
});

test("onResolved releases per-market exposure", () => {
  const b = new ExposureBook();
  b.onMinted("q1", "1", 40n, [V1]);
  b.onResolved("1");
  assert.equal(b.perMarket(V1, 0), 0n);
});
