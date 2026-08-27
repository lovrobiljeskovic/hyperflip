import { test } from "node:test";
import assert from "node:assert/strict";
import { ExposureBook } from "../src/exposure.js";

const V1 = "0x1111111111111111111111111111111111111111";
const V2 = "0x2222222222222222222222222222222222222222";
const V3 = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const T1 = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const T2 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("check fails at-capacity when risk exceeds allowance minus reservations", () => {
  const b = new ExposureBook();
  b.reserve("q1", 60n, [V1], 1000, T1);
  const r = b.check(50n, [V2], 100n, 1000n, 0);
  assert.deepEqual(r, { ok: false, reason: "at-capacity", headroom: 40n }); // 100 allowance - 60 reserved
});

test("expired reservations free capacity", () => {
  const b = new ExposureBook();
  b.reserve("q1", 60n, [V1], 1000, T1);
  assert.equal(b.check(50n, [V2], 100n, 1000n, 1001).ok, true);
});

test("per-market cap counts reserved + open, case-insensitive", () => {
  const b = new ExposureBook();
  // reserved with a mixed/upper-case address (real hex letters, so this actually
  // exercises case folding — V3 differs from its uppercase form, unlike an all-digit addr)
  b.reserve("q1", 30n, [V3.toUpperCase().replace("0X", "0x")], 10_000, T1);
  b.onMinted("q0", "7", 30n, [V3]);
  // market total 60; cap 80 -> risk 25 breaches V3 but not global (allowance 1000)
  const r = b.check(25n, [V3], 1000n, 80n, 0);
  assert.deepEqual(r, { ok: false, reason: "market-cap", headroom: 20n }); // cap 80 - market total 60
  assert.equal(b.check(25n, [V2], 1000n, 80n, 0).ok, true);
});

test("onMinted converts reservation to open exposure (global freed, market kept)", () => {
  const b = new ExposureBook();
  b.reserve("q1", 40n, [V1], 10_000, T1);
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

test("cluster cap counts reserved + open across same-cluster markets", () => {
  const cluster = (v: string) => (v === V1 || v === V2 ? "crypto" : undefined);
  const b = new ExposureBook(cluster);
  b.reserve("q1", 30n, [V1], 10_000, T1);
  b.onMinted("q0", "7", 30n, [V2]);
  // cluster total 60; cap 80 -> risk 25 breaches crypto cluster
  const r = b.check(25n, [V1], 1000n, 1000n, 0, 80n);
  assert.deepEqual(r, { ok: false, reason: "cluster-cap", headroom: 20n }); // cap 80 - cluster total 60
  // V3 has no cluster -> unaffected
  assert.equal(b.check(25n, [V3], 1000n, 1000n, 0, 80n).ok, true);
});

test("check without perClusterCap skips cluster dimension", () => {
  const b = new ExposureBook((_) => "crypto");
  b.onMinted("q0", "1", 100n, [V1]);
  assert.equal(b.check(50n, [V2], 1000n, 1000n, 0).ok, true);
});

test("release undoes a reservation that never minted (e.g. signing failed)", () => {
  const b = new ExposureBook();
  b.reserve("q1", 40n, [V1], 10_000, T1);
  b.release("q1");
  assert.equal(b.reservedGlobal(0), 0n);
});

test("headroom never goes negative when a cap is already breached", () => {
  const b = new ExposureBook();
  b.onMinted("q0", "7", 90n, [V1]); // market already 90 against a cap of 80
  const r = b.check(25n, [V1], 1000n, 80n, 0);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.headroom === 0n, "headroom clamps at 0, so a suggested stake is never negative");
});

// mainnet-hardening P0-4: a taker who quotes repeatedly and never mints
// shouldn't be able to pin quotable headroom for everyone else.
test("taker-cap: one taker cannot reserve past their per-taker cap", () => {
  const b = new ExposureBook();
  b.reserve("q1", 60n, [V1], 10_000, T1);
  // T1 already holds 60 of unminted risk against a 80 cap; a further 25 breaches it.
  const r = b.check(25n, [V2], 1_000_000n, 1_000_000n, 0, undefined, T1, 80n);
  assert.deepEqual(r, { ok: false, reason: "taker-cap", headroom: 20n }); // cap 80 - reserved 60
});

test("taker-cap: a second taker is unaffected by the first taker's reservations", () => {
  const b = new ExposureBook();
  b.reserve("q1", 60n, [V1], 10_000, T1);
  // Same 80 cap, but T2 has no reservations of its own.
  const r = b.check(25n, [V2], 1_000_000n, 1_000_000n, 0, undefined, T2, 80n);
  assert.equal(r.ok, true);
});

test("taker-cap: expiry frees the taker's reserved budget", () => {
  const b = new ExposureBook();
  b.reserve("q1", 60n, [V1], 1000, T1);
  assert.equal(b.reservedByTaker(T1, 500), 60n);
  assert.equal(b.reservedByTaker(T1, 1001), 0n); // reservation expired at t=1000
  assert.equal(b.check(75n, [V2], 1_000_000n, 1_000_000n, 1001, undefined, T1, 80n).ok, true);
});

test("taker-cap: minting converts the reservation, freeing the taker's budget immediately", () => {
  const b = new ExposureBook();
  b.reserve("q1", 60n, [V1], 10_000, T1);
  b.onMinted("q1", "1", 60n, [V1]);
  // Risk is now "open", not "reserved" — reservedByTaker no longer counts it,
  // so T1 can quote again right away instead of waiting for the TTL.
  assert.equal(b.reservedByTaker(T1, 0), 0n);
  assert.equal(b.check(75n, [V2], 1_000_000n, 1_000_000n, 0, undefined, T1, 80n).ok, true);
});

test("taker-cap: address matching is case-insensitive", () => {
  const b = new ExposureBook();
  b.reserve("q1", 60n, [V1], 10_000, T1.toUpperCase().replace("0X", "0x"));
  assert.equal(b.reservedByTaker(T1, 0), 60n);
});
