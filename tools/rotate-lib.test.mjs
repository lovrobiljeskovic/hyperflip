import { test } from "node:test";
import assert from "node:assert/strict";
const NOW = Date.UTC(2026, 7, 18, 12, 0);

import { rotatedRegistry, parseSportsEvent, pickSports, sportsRegistryEntry, sportsMarketSymbol } from "./rotate-lib.mjs";

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
  const outcomes = [11418, 11419, 11420, 11421].map((id, i) => ({ outcome: id, name: "template:sportsContestParticipant", description: `participant:Club ${i}`, quoteToken: "USDC", sideSpecs: YN_SIDES, venue: "abaa" }));
  const questions = [{ question: 938, name: "template:sportsContestResult", description: "competition:UEFA Champions League|contestType:tournament|officialSource:uefa.com|participantA:Paris Saint-Germain|participantB:Bayern Munich|resolutionDeadline:20270606-2300|scheduledStart:20260908-1900|season:2026/27|sport:Association Football|stage:Tournament", fallbackOutcome: 11417, namedOutcomes: [11418, 11419, 11420, 11421] }];
  const mids = { "#114180": "0.72", "#114190": "0.5", "#114200": "0.475", "#114210": "0.445" };
  const picked = pickSports({ outcomes, questions, mids, knownCoins: new Set(), nowMs: NOW });
  assert.equal(picked.length, 4);
  assert.equal(picked[0].groupTitle, "UEFA Champions League 2026/27 winner");
  assert.equal(picked[0].cluster, "UEFA Champions League");
  assert.equal(sportsRegistryEntry(picked[0], "0x1").deployer, "abaa");
});

test("sportsRegistryEntry satisfies the writer's registry shape with the sports fields", () => {
  const { outcomes, questions, mids, maxMsLeft } = sportsBoard();
  const [twins, cats] = pickSports({ outcomes, questions, mids, knownCoins: new Set(), nowMs: NOW, maxMsLeft });
  assert.deepEqual(sportsRegistryEntry(cats, "0xabc"), {
    vault: "0xabc", title: "Cats", category: "sports", cluster: "Hypurr Dodgeball League",
    coinYes: "#112760", coinNo: "#112761", underlying: "q927",
    startMs: Date.UTC(2026, 8, 1, 18, 0), expiryMs: Date.UTC(2026, 8, 8, 23, 59),
    sideYes: "Cats", sideNo: "Not Cats", groupTitle: "Cats vs Humans", question: 927, group: "q927", sport: "dodgeball",
  });
  const standalone = sportsRegistryEntry(twins, "0xdef");
  assert.equal(standalone.question, undefined);
  assert.equal(standalone.group, undefined);
  assert.equal(sportsMarketSymbol(twins), "S12289");
});

test("rotatedRegistry preserves the network and historical entries", () => {
  const archived = [{ vault: "0xold" }];
  assert.deepEqual(rotatedRegistry({ network: "testnet" }, [], archived), { network: "testnet", markets: [], archived });
  assert.throws(() => rotatedRegistry({ network: "mainnet" }, [], []), /network must be testnet/);
});
