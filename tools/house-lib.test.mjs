import { test } from "node:test";
import assert from "node:assert/strict";
import { devig, devig3, fixtureFromEspn, housePick, LEAGUES, matchdayOf, outcomeKey, plan, questionFixtureKey, registerAction, registerQuestionAction, settleAction, stamp, withPriors } from "./house-lib.mjs";

const T0 = Date.UTC(2026, 8, 17, 12); // Thu 2026-09-17 12:00Z
const H = 3600_000;
const D = 86400_000;

function espnEvent(id, awayAbbr, awayName, homeAbbr, homeName, kickoffMs, { final = false, awayWins = false, homeWins = false } = {}) {
  return {
    id, date: new Date(kickoffMs).toISOString(),
    competitions: [{
      competitors: [
        { homeAway: "away", team: { abbreviation: awayAbbr, displayName: awayName }, winner: awayWins },
        { homeAway: "home", team: { abbreviation: homeAbbr, displayName: homeName }, winner: homeWins },
      ],
      status: { type: { name: final ? "STATUS_FINAL" : "STATUS_SCHEDULED", completed: final } },
    }],
  };
}


/** ESPN soccer scoreboard event. Home is listed first; a draw has no winner flag on either side. */
function soccerEvent(id, homeAbbr, homeName, awayAbbr, awayName, kickoffMs, { fullTime = false, homeWins = false, awayWins = false } = {}) {
  return {
    id, date: new Date(kickoffMs).toISOString(),
    competitions: [{
      competitors: [
        { homeAway: "home", team: { abbreviation: homeAbbr, displayName: homeName }, winner: homeWins },
        { homeAway: "away", team: { abbreviation: awayAbbr, displayName: awayName }, winner: awayWins },
      ],
      status: { type: { name: fullTime ? "STATUS_FULL_TIME" : "STATUS_SCHEDULED", completed: fullTime } },
    }],
  };
}

const det = espnEvent("1", "DET", "Detroit Lions", "BUF", "Buffalo Bills", T0 + 12 * H);
const car = espnEvent("2", "CAR", "Carolina Panthers", "ATL", "Atlanta Falcons", T0 + 3 * D);
const nyg = espnEvent("3", "NYG", "New York Giants", "LAR", "Los Angeles Rams", T0 + 4.5 * D);

function outcomeFor(fx, id, venue = "flip") {
  const kv = registerAction(fx, 2, "flip").operation.registerStandaloneOutcomeFromTemplate.keywordToValue;
  return {
    outcome: id, venue, name: "template:sportsContestWinner7", quoteToken: "USDC",
    description: kv.map(([k, v]) => `${k}:${v}`).join("|"),
    sideSpecs: [{ name: "template:{shortNameA}" }, { name: "template:{shortNameB}" }],
  };
}

test("devig removes the vig and returns P(away)", () => {
  assert.equal(devig(180, -218), 0.3425);
  assert.equal(devig(-110, -110), 0.5);
  assert.equal(stamp(Date.UTC(2026, 8, 18, 0, 15)), "20260918-0015");
});

test("registerAction fills sportsContestWinner7 with sorted keywords and refuses oversized names", () => {
  const fx = fixtureFromEspn(det, { away: 180, home: -218 });
  const action = registerAction(fx, 2, "flip");
  assert.equal(action.venue, "flip");
  assert.equal(registerAction({ ...fx, venue: "flp" }, 2).venue, "flp");
  assert.throws(() => registerAction(fx, 2, "zzz"), /unknown venue/);
  const inst = action.operation.registerStandaloneOutcomeFromTemplate;
  assert.equal(inst.id, "sportsContestWinner7");
  assert.equal(inst.deployerFeeScale, "1");
  const keys = inst.keywordToValue.map(([k]) => k);
  assert.deepEqual(keys, [...keys].sort());
  assert.deepEqual(Object.fromEntries(inst.keywordToValue), {
    competition: "NFL", contestType: "game", officialSource: "NFL", participantA: "Detroit Lions", participantB: "Buffalo Bills",
    resolutionDeadline: "20260921-0000", scheduledStart: "20260918-0000", season: "2026", shortNameA: "DET", shortNameB: "BUF",
    sport: "American football", stage: "Week 2",
  });
  const long = { ...fx, away: { abbr: "AAA", name: "A".repeat(40) }, home: { abbr: "BBB", name: "B".repeat(40) } };
  assert.throws(() => registerAction(long, 2, "flip"), /name > 70/);
  assert.throws(() => registerAction({ ...fx, away: { abbr: "A|B", name: "x" } }, 2, "flip"), /invalid/);
});

test("settleAction echoes the on-chain outcome verbatim", () => {
  const o = outcomeFor(fixtureFromEspn(det), 7);
  const action = settleAction(o, "0.5");
  assert.equal(action.venue, "flip");
  assert.equal(settleAction(outcomeFor(fixtureFromEspn(det), 8, "flp"), "1").venue, "flp");
  assert.deepEqual(action.operation.settleOutcome, {
    outcome: 7, settleFraction: "0.5", details: "", nameAndDescription: [o.name, o.description], sideNames: ["template:{shortNameA}", "template:{shortNameB}"],
  });
  assert.equal(outcomeKey(o), `Detroit Lions|Buffalo Bills|${T0 + 12 * H}`);
});

test("plan: settles finals and stale deadlines, registers by kickoff within the cap, wraps unknown outcomes, priors pre-kickoff only", () => {
  const detFinal = espnEvent("1", "DET", "Detroit Lions", "BUF", "Buffalo Bills", T0 - 20 * H, { final: true, homeWins: true });
  const old = espnEvent("9", "OLD", "Old Away", "OLH", "Old Home", T0 - 5 * D); // never went final; deadline passed
  const fixtures = [fixtureFromEspn(detFinal), fixtureFromEspn(old), fixtureFromEspn(car, { away: 120, home: -140 }), fixtureFromEspn(nyg)];
  const oDet = outcomeFor(fixtures[0], 1);
  const oOld = outcomeFor(fixtures[1], 2);
  const oCar = outcomeFor(fixtures[2], 3);
  const other = outcomeFor(fixtures[3], 4, "zzz"); // another deployer's listing: ignored
  const registry = { markets: [{ coinYes: "#10", deployer: "flip", startMs: T0 - 20 * H, priorYes: 0.3 }] };
  const p = plan({ outcomes: [oDet, oOld, oCar, other], fixtures, registry, nowMs: T0, horizonMs: 4 * D, maxActive: 3 });

  assert.deepEqual(p.toSettle.map((s) => [s.o.outcome, s.fraction]), [[1, "0"], [2, "0.5"]]);
  // 3 mine, 2 settling -> 1 active -> room for 2; NYG is beyond the 4d horizon, CAR already registered.
  assert.deepEqual(p.toRegister.map((fx) => fx.id), []);
  const p2 = plan({ outcomes: [oDet, oOld, oCar, other], fixtures, registry, nowMs: T0, horizonMs: 5 * D, maxActive: 3 });
  assert.deepEqual(p2.toRegister.map((fx) => [fx.id, fx.venue]), [["3", "flip"]]);
  assert.deepEqual(p.toWrap.map((w) => [w.outcome, w.coinYes, w.underlying, w.priorYes, w.deployer]), [[3, "#30", "carolina-panthers-atlanta-falcons-20260920", 0.438, "flip"]]);
  assert.deepEqual([...p.priors], []); // DET kicked off: frozen
  const live = { markets: [{ coinYes: "#30", deployer: "flip", startMs: T0 + 3 * D, priorYes: 0.5 }] };
  const p3 = plan({ outcomes: [oCar], fixtures, registry: live, nowMs: T0, maxActive: 3 });
  assert.deepEqual([...p3.priors], [["#30", 0.438]]);
  assert.equal(p3.toWrap.length, 0);
});

test("plan: contested slots go to balanced games with a real pre-kickoff window", () => {
  const fixtures = [fixtureFromEspn(det, { away: 320, home: -410 }), fixtureFromEspn(car, { away: -110, home: -110 }), fixtureFromEspn(nyg)];
  // Default 18h window drops DET (12h out); CAR (even) beats NYG (no odds = treated as even, later kickoff).
  const p = plan({ outcomes: [], fixtures, registry: { markets: [] }, nowMs: T0, maxActive: 2 });
  assert.deepEqual(p.toRegister.map((fx) => fx.id), ["2", "3"]);
  const p2 = plan({ outcomes: [], fixtures, registry: { markets: [] }, nowMs: T0, maxActive: 3, minWindowMs: 2 * H });
  assert.deepEqual(p2.toRegister.map((fx) => fx.id), ["2", "3", "1"]);
  // maxActive is per venue: one slot on flip, one on flp; DET (lopsided) is left out.
  const p3 = plan({ outcomes: [], fixtures, registry: { markets: [] }, nowMs: T0, maxActive: 1, minWindowMs: 2 * H });
  assert.deepEqual(p3.toRegister.map((fx) => [fx.id, fx.venue]), [["2", "flip"], ["3", "flp"]]);
});

test("plan: flip fills first, flp takes only the overflow; both venues settle and wrap", () => {
  const games = ["A", "B", "C", "D", "E"].map((x, i) => espnEvent(x, x, `${x} Away`, `${x}H`, `${x} Home`, T0 + (2 + i) * D));
  const fixtures = games.map((g) => fixtureFromEspn(g));
  // flip holds 2 of 2 (one already final), flp holds 1 of 2.
  const flipFinal = espnEvent("Z", "Z", "Z Away", "ZH", "Z Home", T0 - D, { final: true, awayWins: true });
  const outcomes = [outcomeFor(fixtureFromEspn(flipFinal), 1), outcomeFor(fixtures[0], 2), outcomeFor(fixtures[1], 3, "flp")];
  const p = plan({ outcomes, fixtures: [fixtureFromEspn(flipFinal), ...fixtures], registry: { markets: [] }, nowMs: T0, maxActive: 2 });
  assert.deepEqual(p.toSettle.map((s) => [s.o.outcome, s.fraction]), [[1, "1"]]);
  // settling frees a flip slot -> C on flip; flp has one slot -> D; E has no room.
  assert.deepEqual(p.toRegister.map((fx) => [fx.id, fx.venue]), [["C", "flip"], ["D", "flp"]]);
  assert.deepEqual(p.toWrap.map((w) => [w.outcome, w.deployer]), [[2, "flip"], [3, "flp"]]);
  const p2 = plan({ outcomes: [], fixtures, registry: { markets: [] }, nowMs: T0, maxActive: 2 });
  assert.deepEqual(p2.toRegister.map((fx) => fx.venue), ["flip", "flip", "flp", "flp"]);
});

test("withPriors returns the same reference when nothing changes", () => {
  const markets = [{ coinYes: "#10", priorYes: 0.4 }, { coinYes: "#20" }];
  assert.equal(withPriors(markets, new Map([["#10", 0.4]])), markets);
  const next = withPriors(markets, new Map([["#20", 0.7]]));
  assert.notEqual(next, markets);
  assert.deepEqual(next[1], { coinYes: "#20", priorYes: 0.7 });
  assert.equal(housePick({ outcome: 5 }, { participantA: "A", participantB: "B", shortNameA: "A", shortNameB: "B", competition: "NFL", sport: "x", startMs: 1, expiryMs: 2 }, undefined).priorYes, undefined);
});

test("devig3 normalises a 3-way line; matchdayOf clusters the season by gaps of more than 3 days", () => {
  assert.deepEqual(devig3(-140, 300, 320), { home: 0.5444, draw: 0.2333, away: 0.2222 });
  assert.deepEqual(devig3(100, 100, 100), { home: 0.3333, draw: 0.3333, away: 0.3333 });
  const day = (m, d) => Date.UTC(2026, m - 1, d, 15);
  const season = [day(8, 21), day(8, 22), day(8, 23), day(8, 28), day(8, 29), day(9, 4), day(9, 5), day(10, 10), day(10, 11)];
  assert.equal(matchdayOf(day(8, 22), season), 1);
  assert.equal(matchdayOf(day(9, 5), season), 3);
  assert.equal(matchdayOf(day(10, 11), season), 4);
  assert.throws(() => matchdayOf(day(12, 25), season), /not in season/);
});

test("fixtureFromEspn treats a soccer full-time result as final; no winner flag is a draw", () => {
  const home = fixtureFromEspn(soccerEvent("s1", "LIV", "Liverpool", "MNC", "Manchester City", T0, { fullTime: true, homeWins: true }));
  assert.deepEqual([home.final, home.winner, home.home.name, home.away.name], [true, "B", "Liverpool", "Manchester City"]);
  const draw = fixtureFromEspn(soccerEvent("s2", "LIV", "Liverpool", "MNC", "Manchester City", T0, { fullTime: true }));
  assert.deepEqual([draw.final, draw.winner], [true, "tie"]);
  const live = fixtureFromEspn(soccerEvent("s3", "LIV", "Liverpool", "MNC", "Manchester City", T0));
  assert.deepEqual([live.final, live.winner], [false, null]);
});

const PL = () => LEAGUES.find((l) => l.key === "eng.1");
const KO = Date.UTC(2026, 9, 11, 15, 30); // Sun 2026-10-11 15:30Z
const livMci = () => ({ ...fixtureFromEspn(soccerEvent("401879264", "LIV", "Liverpool", "MNC", "Manchester City", KO)), odds: { home: 100, draw: 245, away: 250 }, league: "eng.1", matchday: 6 });

test("registerQuestionAction reproduces the hand-built Liverpool v Manchester City payload", () => {
  const action = registerQuestionAction(livMci(), PL(), "flip");
  assert.deepEqual(action, {
    type: "outcomeDeploy", venue: "flip",
    operation: { registerQuestionFromTemplate: {
      questionTemplateInstance: {
        id: "sportsContestResult5",
        keywordToValue: [
          ["competition", "Premier League"], ["contestType", "Match"], ["officialSource", "Premier League"],
          ["participantA", "Liverpool"], ["participantB", "Manchester City"], ["resolutionDeadline", "20261014-1530"],
          ["scheduledStart", "20261011-1530"], ["season", "2026/27"], ["sport", "Soccer"], ["stage", "Matchday 6"],
        ],
        deployerFeeScale: "1",
      },
      namedOutcomeTemplateInstances: [
        { id: "sportsContestParticipant5", keywordToValue: [["participant", "Liverpool"]] },
        { id: "sportsContestDraw5", keywordToValue: [] },
        { id: "sportsContestParticipant5", keywordToValue: [["participant", "Manchester City"]] },
      ],
    } },
  });
  assert.equal(registerQuestionAction({ ...livMci(), venue: "flp" }, PL()).venue, "flp");
  assert.equal(questionFixtureKey(livMci()), `Liverpool|Manchester City|${KO}`);
  assert.throws(() => registerQuestionAction(livMci(), PL(), "zzz"), /unknown venue/);
  assert.throws(() => registerQuestionAction({ ...livMci(), matchday: undefined }, PL(), "flip"), /matchday/);
  assert.throws(() => registerQuestionAction({ ...livMci(), home: { abbr: "X", name: "A".repeat(26) } }, PL(), "flip"), /participant > 25/);
  assert.throws(() => registerQuestionAction({ ...livMci(), away: { abbr: "X", name: "Bad|Name" } }, PL(), "flip"), /invalid/);
  assert.equal(LEAGUES.find((l) => l.key === "nfl").kind, "standalone");
  assert.equal(LEAGUES.find((l) => l.key === "esp.1").competition, "La Liga");
});
