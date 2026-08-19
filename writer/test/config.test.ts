import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkets, parseInviteCodes } from "../src/config.js";

const VAULT = "0x1111111111111111111111111111111111111111";

test("parseMarkets parses JSON array and keys by lowercase vault", () => {
  const raw = JSON.stringify([
    { vault: VAULT.toUpperCase().replace("0X", "0x"), coinYes: "+123850", coinNo: "+123851", expiryMs: 1755500000000, underlying: "BTC", cluster: "crypto", direction: "up", title: "Will BTC close above X?", category: "crypto" },
  ]);
  const m = parseMarkets(raw);
  const info = m.get(VAULT.toLowerCase());
  assert.ok(info);
  assert.equal(info.coinYes, "+123850");
  assert.equal(info.coinNo, "+123851");
  assert.equal(info.expiryMs, 1755500000000);
  assert.equal(info.underlying, "BTC");
  assert.equal(info.cluster, "crypto");
  assert.equal(info.direction, "up");
  assert.equal(info.title, "Will BTC close above X?");
  assert.equal(info.category, "crypto");
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

test("parseMarkets rejects missing or bad direction", () => {
  assert.throws(() => parseMarkets(JSON.stringify([{ vault: VAULT, coinYes: "a", coinNo: "b", underlying: "BTC", cluster: "crypto", title: "t", category: "c" }])), /direction/);
  assert.throws(() => parseMarkets(JSON.stringify([{ vault: VAULT, coinYes: "a", coinNo: "b", underlying: "BTC", cluster: "crypto", direction: "sideways", title: "t", category: "c" }])), /direction/);
});

test("parseMarkets accepts registry object shape and requires title/category", () => {
  const raw = JSON.stringify({
    markets: [{
      vault: "0x2695562df7D7056E7262CC5D2CD7b5916ce463aF",
      title: "Will MU close above X?", category: "crypto",
      coinYes: "#130690", coinNo: "#130691", underlying: "MU", cluster: "crypto", direction: "up",
    }],
  });
  const m = parseMarkets(raw);
  const info = m.get("0x2695562df7d7056e7262cc5d2cd7b5916ce463af")!;
  assert.equal(info.title, "Will MU close above X?");
  assert.equal(info.category, "crypto");
});

test("parseMarkets rejects entry missing title/category", () => {
  const raw = JSON.stringify({
    markets: [{
      vault: "0x2695562df7D7056E7262CC5D2CD7b5916ce463aF",
      coinYes: "#130690", coinNo: "#130691", underlying: "MU", cluster: "crypto", direction: "up",
    }],
  });
  assert.throws(() => parseMarkets(raw), /missing title\/category/);
});

test("parseInviteCodes trims and drops empties", () => {
  assert.deepEqual([...parseInviteCodes(" a, b,,c ")], ["a", "b", "c"]);
});
