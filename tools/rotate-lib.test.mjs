import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBinary, pickBinaries, registryEntry, marketSymbol } from "./rotate-lib.mjs";

const NOW = Date.UTC(2026, 7, 19, 12, 0); // 2026-08-19T12:00Z

test("parseBinary happy path", () => {
  assert.deepEqual(parseBinary("perp:BTC|threshold:64200|time:20260820-0200"), {
    perp: "BTC",
    threshold: 64200,
    expiryMs: Date.UTC(2026, 7, 20, 2, 0),
  });
});

test("parseBinary rejects venue-prefixed perps and garbage", () => {
  assert.equal(parseBinary("perp:xyz:NVDA|threshold:217.92|time:20260819-2010"), null);
  assert.equal(parseBinary("competition:MLB|contestType:game"), null);
  assert.equal(parseBinary("perp:BTC|threshold:abc|time:20260820-0200"), null);
  assert.equal(parseBinary("perp:BTC|threshold:1|time:2026-08-20"), null);
});

function outcome(id, description) {
  return { outcome: id, name: "template:binaryPrice", description, quoteToken: "USDC" };
}

test("pickBinaries filters expired, known, midless, non-binary; round-robins perps", () => {
  const outcomes = [
    outcome(100, "perp:BTC|threshold:1|time:20260820-0200"),
    outcome(101, "perp:BTC|threshold:2|time:20260820-0600"),
    outcome(102, "perp:BTC|threshold:3|time:20260821-0200"), // 3rd BTC, over perUnderlying
    outcome(103, "perp:ETH|threshold:4|time:20260820-0200"),
    outcome(104, "perp:SOL|threshold:5|time:20260819-1300"), // expires in 1h < 2h floor
    outcome(105, "perp:HYPE|threshold:6|time:20260820-0200"), // no mid
    outcome(106, "perp:ZEC|threshold:7|time:20260820-0200"), // already known
    outcome(109, "perp:LIT|threshold:2|time:20260901-0000"), // 13 days out > 4-day window
    { outcome: 107, name: "template:sportsContestWinner3", description: "x", quoteToken: "USDC" },
    { outcome: 108, name: "template:binaryPrice", description: "perp:DOGE|threshold:8|time:20260820-0200", quoteToken: "USDH" },
  ];
  const mids = Object.fromEntries([100, 101, 102, 103, 104, 106, 109].map((id) => [`#${id * 10}`, "0.5"]));
  const picked = pickBinaries({ outcomes, mids, knownCoins: new Set(["#1060"]), nowMs: NOW });
  assert.deepEqual(
    picked.map((p) => p.outcome),
    [100, 103, 101], // round 1: earliest BTC + ETH; round 2: second BTC; #102 cut by perUnderlying=2
  );
  assert.deepEqual(picked[0], {
    outcome: 100,
    coinYes: "#1000",
    coinNo: "#1001",
    perp: "BTC",
    threshold: 1,
    expiryMs: Date.UTC(2026, 7, 20, 2, 0),
  });
});

test("pickBinaries respects cap", () => {
  const outcomes = Array.from({ length: 12 }, (_, i) =>
    outcome(200 + i, `perp:P${i}|threshold:1|time:20260820-0200`),
  );
  const mids = Object.fromEntries(outcomes.map((o) => [`#${o.outcome * 10}`, "0.5"]));
  const picked = pickBinaries({ outcomes, mids, knownCoins: new Set(), nowMs: NOW });
  assert.equal(picked.length, 8);
});

test("registryEntry and marketSymbol shape", () => {
  const pick = { outcome: 100, coinYes: "#1000", coinNo: "#1001", perp: "BTC", threshold: 64200, expiryMs: Date.UTC(2026, 7, 20, 2, 0) };
  assert.deepEqual(registryEntry(pick, "0xabc"), {
    vault: "0xabc",
    title: "BTC above 64200 on Aug 20?",
    category: "crypto",
    coinYes: "#1000",
    coinNo: "#1001",
    underlying: "BTC",
    cluster: "btc",
    direction: "up",
    expiryMs: Date.UTC(2026, 7, 20, 2, 0),
  });
  assert.equal(marketSymbol(pick), "BTC0820");
});
