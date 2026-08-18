import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkets } from "../src/config.js";

const VAULT = "0x1111111111111111111111111111111111111111";

test("parseMarkets parses JSON array and keys by lowercase vault", () => {
  const raw = JSON.stringify([
    { vault: VAULT.toUpperCase().replace("0X", "0x"), coinYes: "+123850", coinNo: "+123851", expiryMs: 1755500000000, underlying: "BTC", cluster: "crypto" },
  ]);
  const m = parseMarkets(raw);
  const info = m.get(VAULT.toLowerCase());
  assert.ok(info);
  assert.equal(info.coinYes, "+123850");
  assert.equal(info.coinNo, "+123851");
  assert.equal(info.expiryMs, 1755500000000);
  assert.equal(info.underlying, "BTC");
  assert.equal(info.cluster, "crypto");
});

test("parseMarkets rejects bad address", () => {
  assert.throws(() => parseMarkets(JSON.stringify([{ vault: "0xnope", coinYes: "a", coinNo: "b", underlying: "BTC", cluster: "crypto" }])));
});

test("parseMarkets rejects missing coin fields", () => {
  assert.throws(() => parseMarkets(JSON.stringify([{ vault: VAULT }])));
});

test("parseMarkets rejects missing underlying/cluster", () => {
  assert.throws(() => parseMarkets(JSON.stringify([{ vault: VAULT, coinYes: "a", coinNo: "b" }])));
  assert.throws(() => parseMarkets(JSON.stringify([{ vault: VAULT, coinYes: "a", coinNo: "b", underlying: "BTC" }])));
  assert.throws(() => parseMarkets(JSON.stringify([{ vault: VAULT, coinYes: "a", coinNo: "b", underlying: "", cluster: "crypto" }])));
});
