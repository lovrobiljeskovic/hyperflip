import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBinary, parseRecurring, pickBinaries, registryEntry, marketSymbol, classify, filterMappedPicks, rotatedRegistry } from "./rotate-lib.mjs";

const NOW = Date.UTC(2026, 7, 18, 12, 0); // 2026-08-18T12:00Z

const btcSource = {
  schemaVersion: 1,
  underlying: "BTC",
  sourceNetwork: "testnet",
  sourceCoin: "BTC",
  cluster: "crypto",
  calendar: "continuous",
  measurementEnabled: true,
  fallbackEligible: true,
};

test("rotation keeps only explicit source mappings without exceeding the active cap", () => {
  const sources = { schemaVersion: 2, network: "testnet", sources: [btcSource] };
  assert.deepEqual(filterMappedPicks([{ perp: "BTC" }, { perp: "DOGE" }], sources, new Set(), 20), [{ perp: "BTC" }]);
  assert.throws(() => filterMappedPicks([{ perp: "BTC" }], sources, new Set(Array.from({ length: 20 }, (_, i) => `A${i}`)), 20), /at most 20/);
});

test("rotation preserves the testnet registry identity", () => {
  assert.deepEqual(rotatedRegistry({ network: "testnet" }, [{ vault: "0x1" }], []), { network: "testnet", markets: [{ vault: "0x1" }], archived: [] });
  assert.throws(() => rotatedRegistry({ network: "mainnet" }, [], []), /network must be testnet/);
});

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

// ---------------------------------------------------------------------------
// Sports picker

import { parseSportsEvent, pickSports, sportsRegistryEntry, sportsMarketSymbol } from "./rotate-lib.mjs";

const NAMED_SIDES = [{ name: "template:{shortNameA}" }, { name: "template:{shortNameB}" }];
const YN_SIDES = [{ name: "Yes" }, { name: "No" }];
const OU_SIDES = [{ name: "template:Over" }, { name: "template:Under" }];
const FIXTURE = "competition:MLB|contestType:Baseball|officialSource:ESPN|participantA:Minnesota Twins|participantB:Baltimore Orioles|resolutionDeadline:20260826-1446|scheduledStart:20260820-1546|season:2026|shortNameA:min|shortNameB:bal|sport:baseball|stage:Regular";

test("parseSportsEvent reads the fixture and refuses one without both timestamps", () => {
  const ev = parseSportsEvent(FIXTURE);
  assert.equal(ev.competition, "MLB");
  assert.equal(ev.participantA, "Minnesota Twins");
  assert.equal(ev.shortNameB, "bal");
  assert.equal(ev.sport, "baseball");
  assert.equal(ev.startMs, Date.UTC(2026, 7, 20, 15, 46));
  assert.equal(ev.expiryMs, Date.UTC(2026, 7, 26, 14, 46));
  assert.equal(parseSportsEvent("high:1.5|low:1.5|measure:Goals"), null);
  assert.equal(parseSportsEvent("competition:X|scheduledStart:20260820-1546"), null);
});

function sportsBoard() {
  const outcomes = [
    // q927: 3-way match, whole question wrapped. Kickoff Sep 1 18:00.
    { outcome: 11276, name: "template:sportsContestParticipant", description: "participant:Cats", quoteToken: "USDC", sideSpecs: YN_SIDES },
    { outcome: 11277, name: "template:sportsContestDraw", description: "", quoteToken: "USDC", sideSpecs: YN_SIDES },
    { outcome: 11278, name: "template:sportsContestParticipant", description: "participant:Humans", quoteToken: "USDC", sideSpecs: YN_SIDES },
    { outcome: 11275, name: "template fallback", description: "", quoteToken: "USDC", sideSpecs: YN_SIDES },
    // q928: every leg at 0.5 -> untraded, wrapped last
    { outcome: 11286, name: "template:sportsContestParticipant", description: "participant:Dogs", quoteToken: "USDC", sideSpecs: YN_SIDES },
    { outcome: 11287, name: "template:sportsContestParticipant", description: "participant:Birds", quoteToken: "USDC", sideSpecs: YN_SIDES },
    // standalone 2-way winner with named sides, kickoff Aug 20
    { outcome: 12289, name: "template:sportsContestWinner3", description: FIXTURE, quoteToken: "USDC", sideSpecs: NAMED_SIDES },
    // standalone winner pinned at 0.5 -> wrapped last
    { outcome: 12290, name: "template:sportsContestWinner3", description: FIXTURE.replace("Minnesota Twins", "Boston Red Sox"), quoteToken: "USDC", sideSpecs: NAMED_SIDES },
    // standalone Yes/No winner, kickoff Oct 1 (inside 60d)
    { outcome: 11273, name: "template:sportsContestWinner", description: "competition:Hypurr Race|contestType:race|officialSource:Hypurr News|participantA:Hypurr|participantB:Usain Bolt|resolutionDeadline:20261005-2359|scheduledStart:20261001-1500|season:2026|sport:track|stage:Final", quoteToken: "USDC", sideSpecs: [{ name: "template:Yes" }, { name: "template:No" }] },
    // over/under with a real fixture
    { outcome: 16541, name: "template:sportsScalarMarket4", description: "event:St. Louis Cardinals vs Los Angeles Dodgers (MLB)|high:0.5|low:0.5|measure:Shohei Ohtani home runs|officialSource:mlb.com|resolutionDeadline:20260904-0210|scheduledStart:20260903-0210|sport:Baseball", quoteToken: "USDC", sideSpecs: OU_SIDES },
    // over/under without dates -> not quotable
    { outcome: 12566, name: "template:sportsScalarMarket", description: "high:1.5|low:1.5|measure:Goals", quoteToken: "USDC", sideSpecs: OU_SIDES },
    // resolution deadline already passed
    { outcome: 15317, name: "template:sportsContestWinner", description: "competition:NFL|participantA:Washington Commanders|participantB:Baltimore Ravens|resolutionDeadline:20260817-1200|scheduledStart:20260810-1200|sport:football", quoteToken: "USDC", sideSpecs: NAMED_SIDES },
    // beyond the window (maxMsLeft 50d in this fixture)
    { outcome: 15386, name: "template:sportsContestWinner", description: "competition:Popularity Contest|participantA:OXYZ|participantB:TXYZ|resolutionDeadline:20261212-1212|scheduledStart:20261212-1212|sport:Popularity", quoteToken: "USDC", sideSpecs: NAMED_SIDES },
    // same fixture as 12289 from a second deployer with club suffixes -> deduped by key
    { outcome: 12291, name: "template:sportsContestWinner7", description: FIXTURE.replace("Minnesota Twins", "Minnesota Twins FC").replace("Baltimore Orioles", "Baltimore Orioles AFC").replace("competition:MLB", "competition:USA_-_MLB"), quoteToken: "USDC", sideSpecs: NAMED_SIDES },
    // deployer smoke test and a disaster market under the sports template -> junk
    { outcome: 16289, name: "template:sportsContestWinner", description: "competition:SMOKE|contestType:game|officialSource:smoke.test|participantA:Smoke Team A|participantB:Smoke Team B|resolutionDeadline:20260910-1200|scheduledStart:20260907-1700|season:2026|sport:football|stage:1", quoteToken: "USDC", sideSpecs: NAMED_SIDES },
    { outcome: 12666, name: "template:sportsContestWinner3", description: "competition:Magnitude 6.0+ earthquake in Japan|contestType:event|officialSource:USGS|participantA:Yes|participantB:No|resolutionDeadline:20261001-2359|scheduledStart:20260916-0000|season:2026|shortNameA:Yes|shortNameB:No|sport:earthquakes|stage:Before Oct 1", quoteToken: "USDC", sideSpecs: NAMED_SIDES },
    // politics filed under the sports template -> not sports
    { outcome: 11569, name: "template:sportsContestWinner", description: "competition:US Midterms 2026|contestType:House majority race|officialSource:AP|participantA:Democrats|participantB:Republicans|resolutionDeadline:20260915-1200|scheduledStart:20260901-0000|season:2026|sport:politics|stage:House Control", quoteToken: "USDC", sideSpecs: NAMED_SIDES },
  ];
  const questions = [
    { question: 927, name: "template:sportsContestResult", description: "competition:Hypurr Dodgeball League|contestType:match|officialSource:HDL|participantA:Cats|participantB:Humans|resolutionDeadline:20260908-2359|scheduledStart:20260901-1800|season:2026|sport:dodgeball|stage:Final", fallbackOutcome: 11275, namedOutcomes: [11276, 11277, 11278] },
    { question: 928, name: "template:sportsContestResult", description: "competition:Hypurr Dodgeball League|contestType:match|officialSource:HDL|participantA:Dogs|participantB:Birds|resolutionDeadline:20260908-2359|scheduledStart:20260902-1800|season:2026|sport:dodgeball|stage:Final", fallbackOutcome: 11285, namedOutcomes: [11286, 11287] },
    // not a sports question
    { question: 820, name: "May CPI year-over-year", description: "free text", fallbackOutcome: 10217, namedOutcomes: [10218, 10219] },
  ];
  const mids = {
    "#112760": "0.45", "#112770": "0.5", "#112780": "0.3",
    "#112860": "0.5", "#112870": "0.5",
    "#122890": "0.61", "#122900": "0.5", "#122910": "0.58", "#162890": "0.6", "#126660": "0.7", "#112730": "0.054", "#165410": "0.4", "#125660": "0.4", "#153170": "0.7", "#153860": "0.4", "#115690": "0.53",
  };
  return { outcomes, questions, mids, maxMsLeft: 50 * 86400_000 };
}

test("pickSports wraps templated questions whole, standalone winners and over/unders; untraded last, skips dated-out, past-deadline", () => {
  const { outcomes, questions, mids, maxMsLeft } = sportsBoard();
  const picked = pickSports({ outcomes, questions, mids, knownCoins: new Set(), nowMs: NOW, maxMsLeft });
  // traded first by kickoff: Twins/Orioles Aug 20, q927 Sep 1, Ohtani Sep 3 (Hypurr race is junk);
  // then untraded by kickoff: Red Sox/Orioles Aug 20, q928 Sep 2
  assert.deepEqual(picked.map((p) => p.outcome), [12289, 11276, 11277, 11278, 16541, 12290, 11286, 11287]);
  const [twins, cats, draw, , ohtani, redsox, dogs] = picked;
  assert.equal(redsox.priced, 0);
  assert.equal(dogs.priced, 0);
  assert.deepEqual(twins, {
    outcome: 12289, coinYes: "#122890", coinNo: "#122891", question: null, group: null,
    title: "Minnesota Twins vs Baltimore Orioles", sideYes: "min", sideNo: "bal",
    underlying: "minnesota-twins-baltimore-orioles-20260820", groupTitle: "Minnesota Twins vs Baltimore Orioles",
    cluster: "MLB", sport: "baseball", startMs: Date.UTC(2026, 7, 20, 15, 46), expiryMs: Date.UTC(2026, 7, 26, 14, 46), priced: 1,
  });
  assert.equal(cats.question, 927);
  assert.equal(cats.group, "q927");
  assert.equal(cats.underlying, "q927");
  assert.equal(cats.groupTitle, "Cats vs Humans");
  assert.equal(cats.sideYes, "Cats");
  assert.equal(cats.sideNo, "Not Cats");
  assert.equal(draw.title, "Draw");
  assert.equal(draw.priced, 0); // pinned leg still wrapped because a sibling traded
  assert.equal(ohtani.sideYes, "Over");
  assert.equal(ohtani.title, "Shohei Ohtani home runs over 0.5?");
  assert.equal(ohtani.underlying, "st-louis-cardinals-vs-los-angeles-dodgers-mlb-20260903");
  assert.ok(!picked.some((p) => p.outcome === 11273), "Hypurr Race is junk");
});

test("pickSports wraps an in-play fixture: kickoff passed, resolution deadline still ahead", () => {
  const outcomes = [{ outcome: 15317, name: "template:sportsContestWinner", description: "competition:NFL|participantA:Washington Commanders|participantB:Baltimore Ravens|resolutionDeadline:20260830-1200|scheduledStart:20260810-1200|sport:football", quoteToken: "USDC", sideSpecs: NAMED_SIDES }];
  assert.deepEqual(pickSports({ outcomes, mids: { "#153170": "0.7" }, knownCoins: new Set(), nowMs: NOW }).map((p) => p.outcome), [15317]);
});

test("pickSports skips a question already wrapped and one that does not fit the cap whole", () => {
  const { outcomes, questions, mids, maxMsLeft } = sportsBoard();
  assert.deepEqual(pickSports({ outcomes, questions, mids, knownCoins: new Set(["#112770"]), nowMs: NOW, maxMsLeft }).map((p) => p.outcome), [12289, 16541, 12290, 11286, 11287]);
  // cap 3: Twins (1) fits, q927 (3) would make 4 -> skipped whole, Ohtani (1) fits, untraded Red Sox (1) fits
  assert.deepEqual(pickSports({ outcomes, questions, mids, knownCoins: new Set(), nowMs: NOW, maxMsLeft, cap: 3 }).map((p) => p.outcome), [12289, 16541, 12290]);
  // perCompetition 1: only one MLB leg (the Ohtani prop's competition is the parenthetical MLB); untraded 2-leg q928 does not fit
  assert.deepEqual(pickSports({ outcomes, questions, mids, knownCoins: new Set(), nowMs: NOW, maxMsLeft, perCompetition: 1 }).map((p) => p.outcome), [12289]);
});

test("pickSports titles a season or tournament question by competition, not by its two seeded participants", () => {
  const outcomes = [11418, 11419, 11420, 11421].map((id, i) => ({ outcome: id, name: "template:sportsContestParticipant", description: `participant:Club ${i}`, quoteToken: "USDC", sideSpecs: YN_SIDES }));
  const questions = [{ question: 938, name: "template:sportsContestResult", description: "competition:UEFA Champions League|contestType:tournament|officialSource:uefa.com|participantA:Paris Saint-Germain|participantB:Bayern Munich|resolutionDeadline:20270606-2300|scheduledStart:20260908-1900|season:2026/27|sport:Association Football|stage:Tournament", fallbackOutcome: 11417, namedOutcomes: [11418, 11419, 11420, 11421] }];
  const mids = { "#114180": "0.72", "#114190": "0.5", "#114200": "0.475", "#114210": "0.445" };
  const picked = pickSports({ outcomes, questions, mids, knownCoins: new Set(), nowMs: NOW });
  assert.equal(picked.length, 4);
  assert.equal(picked[0].groupTitle, "UEFA Champions League 2026/27 winner");
  assert.equal(picked[0].cluster, "UEFA Champions League");
});

test("sportsRegistryEntry satisfies the writer's registry shape with the sports fields", () => {
  const { outcomes, questions, mids, maxMsLeft } = sportsBoard();
  const [twins, cats] = pickSports({ outcomes, questions, mids, knownCoins: new Set(), nowMs: NOW, maxMsLeft });
  assert.deepEqual(sportsRegistryEntry(cats, "0xabc"), {
    vault: "0xabc", title: "Cats", category: "sports", cluster: "Hypurr Dodgeball League",
    coinYes: "#112760", coinNo: "#112761", underlying: "q927", direction: "up",
    startMs: Date.UTC(2026, 8, 1, 18, 0), expiryMs: Date.UTC(2026, 8, 8, 23, 59),
    sideYes: "Cats", sideNo: "Not Cats", groupTitle: "Cats vs Humans", question: 927, group: "q927", sport: "dodgeball",
  });
  const standalone = sportsRegistryEntry(twins, "0xdef");
  assert.equal(standalone.question, undefined);
  assert.equal(standalone.group, undefined);
  assert.equal(sportsMarketSymbol(twins), "S12289");
});
