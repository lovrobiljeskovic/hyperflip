import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBinary, parseRecurring, pickBinaries, registryEntry, marketSymbol, classify } from "./rotate-lib.mjs";

const NOW = Date.UTC(2026, 7, 18, 12, 0); // 2026-08-18T12:00Z

test("parseBinary happy path", () => {
  assert.deepEqual(parseBinary("perp:BTC|threshold:64200|time:20260820-0200"), {
    perp: "BTC",
    venue: null,
    threshold: 64200,
    expiryMs: Date.UTC(2026, 7, 20, 2, 0),
  });
});

test("parseBinary keeps xyz-venue perps, drops other venues and garbage", () => {
  assert.deepEqual(parseBinary("perp:xyz:NVDA|threshold:217.92|time:20260819-2010"), {
    perp: "NVDA",
    venue: "xyz",
    threshold: 217.92,
    expiryMs: Date.UTC(2026, 7, 19, 20, 10),
  });
  // binaryPrice4 carries extra fields — ignored, not a parse failure.
  assert.equal(parseBinary("perp:ETH|priceDescription:Mark|seconds:1200|threshold:2398.1|time:20260822-1133").perp, "ETH");
  assert.equal(parseBinary("perp:pew:TM1|threshold:7750|time:20260821-1900"), null);
  assert.equal(parseBinary("competition:MLB|contestType:game"), null);
  assert.equal(parseBinary("perp:BTC|threshold:abc|time:20260820-0200"), null);
  assert.equal(parseBinary("perp:BTC|threshold:1|time:2026-08-20"), null);
});

test("classify splits crypto, equity and commodity clusters", () => {
  assert.deepEqual(classify({ perp: "BTC", venue: null }), {
    category: "crypto",
    cluster: "crypto",
    diversityKey: "btc",
  });
  assert.deepEqual(classify({ perp: "NVDA", venue: "xyz" }), {
    category: "equity",
    cluster: "equity",
    diversityKey: "equity",
  });
  assert.deepEqual(classify({ perp: "GOLD", venue: "xyz" }), {
    category: "commodity",
    cluster: "commodity",
    diversityKey: "commodity",
  });
});

test("crypto perps share a correlation cluster but keep distinct diversity keys", () => {
  // The whole point of the split. Same cluster => the writer's copula prices
  // BTC and ETH as comoving (0.918, not 0.09). Distinct diversity keys => the
  // picker still refuses to let one perp fill the board.
  const btc = classify({ perp: "BTC", venue: null });
  const eth = classify({ perp: "ETH", venue: null });
  assert.equal(btc.cluster, eth.cluster);
  assert.notEqual(btc.diversityKey, eth.diversityKey);
});

const SIDES = [{ name: "template:Yes" }, { name: "template:No" }];
function outcome(id, description, name = "template:binaryPrice") {
  return { outcome: id, name, description, quoteToken: "USDC", sideSpecs: SIDES };
}

test("pickBinaries filters expired, known, midless, non-binary, question legs", () => {
  const outcomes = [
    outcome(100, "perp:BTC|threshold:100|time:20260820-0200"),
    outcome(101, "perp:BTC|threshold:101|time:20260820-0600"),
    outcome(102, "perp:BTC|threshold:102|time:20260821-0200"), // 3rd BTC, over perUnderlying
    outcome(103, "perp:ETH|threshold:4|time:20260820-0200", "template:binaryPrice4"),
    outcome(104, "perp:SOL|threshold:5|time:20260819-0600"), // expires in 18h < 24h floor
    outcome(105, "perp:HYPE|threshold:6|time:20260820-0200"), // no mid
    outcome(106, "perp:ZEC|threshold:7|time:20260820-0200"), // already known
    outcome(109, "perp:LIT|threshold:2|time:20260910-0000"), // 22 days out > 14-day window
    outcome(110, "perp:APT|threshold:9|time:20260820-0200"), // leg of a question
    { outcome: 107, name: "template:sportsContestWinner3", description: "x", quoteToken: "USDC", sideSpecs: SIDES },
    outcome(108, "perp:DOGE|threshold:8|time:20260820-0200"),
  ];
  outcomes.at(-1).quoteToken = "USDH";
  const mids = Object.fromEntries([100, 101, 102, 103, 104, 106, 109, 110].map((id) => [`#${id * 10}`, "0.5"]));
  Object.assign(mids, { BTC: "100", ETH: "4", SOL: "5", HYPE: "6", ZEC: "7", LIT: "2", APT: "9", DOGE: "8" });
  const picked = pickBinaries({
    outcomes,
    mids,
    questions: [{ fallbackOutcome: 999, namedOutcomes: [110] }],
    knownCoins: new Set(["#1060"]),
    nowMs: NOW,
  });
  assert.deepEqual(
    picked.map((p) => p.outcome),
    [100, 103, 101], // round 1: earliest BTC + ETH; round 2: second BTC; #102 cut by perUnderlying=2
  );
  assert.deepEqual(picked[0], {
    outcome: 100,
    coinYes: "#1000",
    coinNo: "#1001",
    perp: "BTC",
    venue: null,
    priced: 0,
    threshold: 100,
    expiryMs: Date.UTC(2026, 7, 20, 2, 0),
  });
});

test("pickBinaries prefers markets that have actually printed a price", () => {
  const outcomes = [
    outcome(300, "perp:BTC|threshold:1|time:20260820-0200"), // sooner, but pinned at 0.5
    outcome(301, "perp:ETH|threshold:2|time:20260823-0200"), // later, real mid
  ];
  const picked = pickBinaries({
    outcomes,
    mids: { "#3000": "0.5", "#3010": "0.42", BTC: "1", ETH: "2" },
    knownCoins: new Set(),
    nowMs: NOW,
  });
  assert.deepEqual(picked.map((p) => p.outcome), [301, 300]);
});

test("pickBinaries caps one correlated bloc so equities cannot fill the board", () => {
  const outcomes = ["NVDA", "TSLA", "AAPL", "MU", "SNDK"].map((sym, i) =>
    outcome(400 + i, `perp:xyz:${sym}|threshold:1|time:20260820-0200`),
  );
  const mids = Object.fromEntries(outcomes.map((o) => [`#${o.outcome * 10}`, "0.4"]));
  for (const sym of ["NVDA", "TSLA", "AAPL", "MU", "SNDK"]) mids[`xyz:${sym}`] = "1";
  const picked = pickBinaries({ outcomes, mids, knownCoins: new Set(), nowMs: NOW });
  assert.equal(picked.length, 3); // perCluster
});

test("pickBinaries caps crypto per perp, not per correlation bloc", () => {
  // Regression guard for the split: crypto legs all share cluster "crypto" for
  // pricing, so capping the board on `cluster` would collapse it to perCluster
  // (3) markets. The picker caps on diversityKey instead, which is per-perp,
  // so five crypto perps still fill the board as they always did.
  const syms = ["BTC", "ETH", "SOL", "HYPE", "ZEC"];
  const outcomes = syms.map((sym, i) => outcome(500 + i, `perp:${sym}|threshold:1|time:20260820-0200`));
  const mids = Object.fromEntries(outcomes.map((o) => [`#${o.outcome * 10}`, "0.4"]));
  for (const sym of syms) mids[sym] = "1";
  const picked = pickBinaries({ outcomes, mids, knownCoins: new Set(), nowMs: NOW });
  assert.equal(picked.length, 5, "one crypto bloc must not be capped at perCluster");
  assert.equal(new Set(picked.map((p) => p.perp)).size, 5);
});

test("pickBinaries drops strikes untethered from the underlying's own mid", () => {
  const outcomes = [
    outcome(500, "perp:BTC|threshold:100|time:20260822-0200"), // certainty wearing a mid
    outcome(501, "perp:ETH|threshold:2400|time:20260822-0200"), // 4% from spot
    outcome(502, "perp:SOL|threshold:120|time:20260822-0200"), // 31% out, mid stale at 0.5
    outcome(503, "perp:HYPE|threshold:43|time:20260822-0200"), // 22% out — inside the 25% band
  ];
  const picked = pickBinaries({
    outcomes,
    mids: { "#5000": "0.55", "#5010": "0.5", "#5020": "0.5", "#5030": "0.5", BTC: "79712", ETH: "2503.5", SOL: "91.35", HYPE: "54.83" },
    knownCoins: new Set(),
    nowMs: NOW,
  });
  assert.deepEqual(picked.map((p) => p.outcome), [501, 503]);
});

test("pickBinaries respects cap", () => {
  const outcomes = Array.from({ length: 12 }, (_, i) =>
    outcome(200 + i, `perp:P${i}|threshold:1|time:20260820-0200`),
  );
  const mids = Object.fromEntries(outcomes.map((o) => [`#${o.outcome * 10}`, "0.5"]));
  for (let i = 0; i < 12; i++) mids[`P${i}`] = "1";
  const picked = pickBinaries({ outcomes, mids, knownCoins: new Set(), nowMs: NOW });
  assert.equal(picked.length, 8);
});

test("parseRecurring happy path and garbage", () => {
  assert.deepEqual(parseRecurring("class:priceBinary|underlying:BTC|expiry:20260823-0300|targetPrice:78881|period:1d"), {
    perp: "BTC",
    venue: null,
    threshold: 78881,
    expiryMs: Date.UTC(2026, 7, 23, 3, 0),
  });
  assert.equal(parseRecurring("class:somethingElse|underlying:BTC|expiry:20260823-0300|targetPrice:78881"), null);
  assert.equal(parseRecurring("class:priceBinary|underlying:BTC|expiry:2026-08-23|targetPrice:78881"), null);
  assert.equal(parseRecurring("class:priceBinary|underlying:BTC|expiry:20260823-0300|targetPrice:abc"), null);
  assert.equal(parseRecurring("competition:MLB|contestType:game"), null);
});

test("pickBinaries includes Recurring 1d markets despite the 24h floor", () => {
  const recSides = [{ name: "Yes" }, { name: "No" }];
  const outcomes = [
    // 15h left — a template binary this close is rejected, a recurring is kept.
    { outcome: 600, name: "Recurring", description: "class:priceBinary|underlying:BTC|expiry:20260819-0300|targetPrice:100|period:1d", quoteToken: "USDC", sideSpecs: recSides },
    outcome(601, "perp:ETH|threshold:2|time:20260819-0300"),
    // 1h left — even a recurring must clear the 2h floor.
    { outcome: 602, name: "Recurring", description: "class:priceBinary|underlying:SOL|expiry:20260818-1300|targetPrice:5|period:1d", quoteToken: "USDC", sideSpecs: recSides },
  ];
  const mids = { "#6000": "0.5", "#6010": "0.5", "#6020": "0.5", BTC: "100", ETH: "2", SOL: "5" };
  const picked = pickBinaries({ outcomes, mids, knownCoins: new Set(), nowMs: NOW });
  assert.deepEqual(picked.map((p) => p.outcome), [600]);
  assert.deepEqual(registryEntry(picked[0], "0xabc").title, "BTC above 100 on Aug 19?");
});

test("registryEntry and marketSymbol shape", () => {
  const pick = { outcome: 100, coinYes: "#1000", coinNo: "#1001", perp: "BTC", venue: null, threshold: 64200, expiryMs: Date.UTC(2026, 7, 20, 2, 0) };
  assert.deepEqual(registryEntry(pick, "0xabc"), {
    vault: "0xabc",
    title: "BTC above 64200 on Aug 20?",
    category: "crypto",
    coinYes: "#1000",
    coinNo: "#1001",
    underlying: "BTC",
    cluster: "crypto",
    direction: "up",
    expiryMs: Date.UTC(2026, 7, 20, 2, 0),
  });
  assert.equal(marketSymbol(pick), "BTC0820");
  assert.equal(registryEntry({ ...pick, perp: "NVDA", venue: "xyz", threshold: 218.18 }, "0xdef").cluster, "equity");
});
