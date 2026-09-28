import { test } from "node:test";
import assert from "node:assert/strict";
import { devig, devig3, fixtureFromEspn, housePick, LEAGUES, matchdayOf, outcomeKey, plan, questionFixtureKey, questionPick, questionSides, registerAction, registerQuestionAction, settleAction, settleQuestionAction, stamp, winnerSide, withPriors } from "./house-lib.mjs";

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
  // One team's league fixtures, Fri-Mon rounds plus a midweek round: the matchday is how many
  // of its fixtures fall on or before the kickoff, whatever the gaps.
  const team = [day(8, 19), day(8, 24), day(8, 30), day(9, 6), day(9, 13), day(9, 17), day(9, 20), day(10, 9)];
  assert.equal(matchdayOf(day(8, 19), team), 1);
  assert.equal(matchdayOf(day(9, 17), team), 6);
  assert.equal(matchdayOf(day(10, 9), team), 8);
  assert.throws(() => matchdayOf(day(12, 25), team), /not in season/);
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

function questionFor(fx, qid, venue = "flip") {
  // Payload always built for "flip" (registerQuestionAction rejects unknown venues); `venue` only
  // stamps the outcome rows, so a foreign venue like "zzz" can be faked.
  const inst = registerQuestionAction(fx, PL(), "flip").operation.registerQuestionFromTemplate.questionTemplateInstance;
  const description = inst.keywordToValue.map(([k, v]) => `${k}:${v}`).join("|");
  const base = qid * 10;
  const yesNo = [{ name: "Yes" }, { name: "No" }];
  const question = { question: qid, name: "template:sportsContestResult5", description, fallbackOutcome: base, namedOutcomes: [base + 1, base + 2, base + 3], settledNamedOutcomes: [] };
  const outcomes = [
    { outcome: base, venue, name: "template fallback", description: "other", quoteToken: "USDC", sideSpecs: yesNo },
    { outcome: base + 1, venue, name: "template:sportsContestParticipant5", description: `participant:${fx.home.name}`, quoteToken: "USDC", sideSpecs: yesNo },
    { outcome: base + 2, venue, name: "template:sportsContestDraw5", description: "", quoteToken: "USDC", sideSpecs: yesNo },
    { outcome: base + 3, venue, name: "template:sportsContestParticipant5", description: `participant:${fx.away.name}`, quoteToken: "USDC", sideSpecs: yesNo },
  ];
  return { question, outcomes };
}

test("settleQuestionAction settles exactly one side to 1 and echoes every named outcome verbatim", () => {
  const { question, outcomes } = questionFor(livMci(), 1392, "flp");
  const byId = new Map(outcomes.map((o) => [o.outcome, o]));
  const sides = questionSides(question, byId);
  assert.deepEqual(sides.map((s) => [s.o.outcome, s.side]), [[13921, "home"], [13922, "draw"], [13923, "away"]]);
  const action = settleQuestionAction(question, sides, "draw");
  assert.equal(action.venue, "flp");
  const s = action.operation.settleQuestion2;
  assert.equal(s.question, 1392);
  assert.deepEqual(s.nameAndDescription, [question.name, question.description]);
  assert.deepEqual(s.outcomeSettlements.map((x) => [x.outcome, x.settleFraction, x.details]), [[13921, "0", ""], [13922, "1", ""], [13923, "0", ""]]);
  assert.deepEqual(s.outcomeSettlements[0], { outcome: 13921, settleFraction: "0", details: "", nameAndDescription: ["template:sportsContestParticipant5", "participant:Liverpool"], sideNames: ["Yes", "No"] });
  assert.deepEqual(settleQuestionAction(question, sides, "home").operation.settleQuestion2.outcomeSettlements.map((x) => x.settleFraction), ["1", "0", "0"]);
  assert.deepEqual(settleQuestionAction(question, sides, "away").operation.settleQuestion2.outcomeSettlements.map((x) => x.settleFraction), ["0", "0", "1"]);
  // An already-settled member is left out of outcomeSettlements.
  const partial = { ...question, settledNamedOutcomes: [13921] };
  assert.deepEqual(settleQuestionAction(partial, questionSides(partial, byId), "away").operation.settleQuestion2.outcomeSettlements.map((x) => x.outcome), [13922, 13923]);
  // Malformed questions are rejected: a member missing, or a participant that matches neither side.
  assert.equal(questionSides(question, new Map([...byId].filter(([id]) => id !== 13922))), null);
  const stranger = new Map(byId); stranger.set(13923, { ...byId.get(13923), description: "participant:Everton" });
  assert.equal(questionSides(question, stranger), null);
  assert.deepEqual([winnerSide({ winner: "B" }), winnerSide({ winner: "A" }), winnerSide({ winner: "tie" }), winnerSide({ winner: null })], ["home", "away", "draw", null]);
});

test("plan adopts house questions: settles finals and deadlines, wraps members with 3-way priors, refreshes priors pre-kickoff only", () => {
  const upcoming = livMci(); // kicks off KO, 13 days after nowMs
  const nowMs = KO - 13 * D;
  const { question: qUp, outcomes: oUp } = questionFor(upcoming, 1392);
  const finished = { ...fixtureFromEspn(soccerEvent("f1", "ARS", "Arsenal", "LEE", "Leeds United", nowMs - 20 * H, { fullTime: true })), league: "eng.1", matchday: 5 };
  const { question: qFin, outcomes: oFin } = questionFor(finished, 1400, "flp");
  const stale = { ...fixtureFromEspn(soccerEvent("f2", "CHE", "Chelsea", "BOU", "AFC Bournemouth", nowMs - 5 * D)), league: "eng.1", matchday: 4 }; // never final; deadline passed
  const { question: qStale, outcomes: oStale } = questionFor(stale, 1401);
  const foreign = questionFor({ ...upcoming, home: { abbr: "X", name: "Foreign" } }, 1500, "zzz");
  const outcomes = [...oUp, ...oFin, ...oStale, ...foreign.outcomes];
  const questions = [qUp, qFin, qStale, foreign.question];
  const p = plan({ outcomes, questions, fixtures: [], soccerFixtures: [upcoming, finished, stale], registry: { markets: [] }, nowMs, maxActive: 20 });

  assert.deepEqual(p.toSettleQuestions.map((s) => [s.q.question, s.venue, s.winner]), [[1400, "flp", "draw"], [1401, "flip", "draw"]]);
  assert.deepEqual(p.toRegisterQuestions, []);
  assert.deepEqual(p.toWrap.map((w) => [w.outcome, w.coinYes, w.title, w.sideNo, w.group, w.groupTitle, w.priorYes, w.deployer, w.question]), [
    [13921, "#139210", "Liverpool", "Not Liverpool", "q1392", "Liverpool vs Manchester City", 0.4649, "flip", 1392],
    [13922, "#139220", "Draw", "Not Draw", "q1392", "Liverpool vs Manchester City", 0.2695, "flip", 1392],
    [13923, "#139230", "Manchester City", "Not Manchester City", "q1392", "Liverpool vs Manchester City", 0.2656, "flip", 1392],
  ]);
  assert.deepEqual([...p.priors], []);

  // rotate-markets already wrapped all three members (question 1392 today): no re-wrap, priors attach by coinYes.
  const rows = [13921, 13922, 13923].map((id) => ({ coinYes: `#${id * 10}`, deployer: "flip", question: 1392, startMs: KO }));
  const p2 = plan({ outcomes: oUp, questions: [qUp], fixtures: [], soccerFixtures: [upcoming], registry: { markets: rows }, nowMs, maxActive: 20 });
  assert.equal(p2.toWrap.length, 0);
  assert.deepEqual([...p2.priors], [["#139210", 0.4649], ["#139220", 0.2695], ["#139230", 0.2656]]);
  // Only the home member wrapped so far: wrap the other two.
  const p3 = plan({ outcomes: oUp, questions: [qUp], fixtures: [], soccerFixtures: [upcoming], registry: { markets: rows.slice(0, 1) }, nowMs, maxActive: 20 });
  assert.deepEqual(p3.toWrap.map((w) => w.outcome), [13922, 13923]);
  // After kickoff nothing is wrapped and priors freeze.
  const p4 = plan({ outcomes: oUp, questions: [qUp], fixtures: [], soccerFixtures: [upcoming], registry: { markets: rows }, nowMs: KO + H, maxActive: 20 });
  assert.deepEqual([p4.toWrap, [...p4.priors]], [[], []]);
  // A finished match with a home winner settles home.
  const homeWin = { ...finished, ...fixtureFromEspn(soccerEvent("f1", "ARS", "Arsenal", "LEE", "Leeds United", nowMs - 20 * H, { fullTime: true, homeWins: true })) };
  const p5 = plan({ outcomes: oFin, questions: [qFin], fixtures: [], soccerFixtures: [homeWin], registry: { markets: [] }, nowMs, maxActive: 20 });
  assert.deepEqual(p5.toSettleQuestions.map((s) => s.winner), ["home"]);
  // Kickoff moved by a day on ESPN after registration: still the same question (no Draw, no duplicate).
  const moved = { ...upcoming, ...fixtureFromEspn(soccerEvent("401879264", "LIV", "Liverpool", "MNC", "Manchester City", KO + D)) };
  const p7 = plan({ outcomes: oUp, questions: [qUp], fixtures: [], soccerFixtures: [moved], registry: { markets: [] }, nowMs, maxActive: 20, nflMaxActive: 0 });
  assert.deepEqual([p7.toSettleQuestions, p7.toRegisterQuestions, p7.toWrap.map((w) => w.priorYes)], [[], [], [0.4649, 0.2695, 0.2656]]);
  // Past the deadline with no ESPN fixture at all: wait and report, never guess Draw.
  const p8 = plan({ outcomes: oStale, questions: [qStale], fixtures: [], soccerFixtures: [], registry: { markets: [] }, nowMs, maxActive: 20 });
  assert.deepEqual([p8.toSettleQuestions, p8.unmatched.map((u) => u.q.question)], [[], [1401]]);
  // Past the deadline with the fixture known and still not final (postponed): Draw.
  assert.deepEqual(plan({ outcomes: oStale, questions: [qStale], fixtures: [], soccerFixtures: [stale], registry: { markets: [] }, nowMs, maxActive: 20 }).toSettleQuestions.map((s) => s.winner), ["draw"]);
  // A league that is not enabled this run is not touched: no settle, no wrap, no priors.
  const p9 = plan({ outcomes: [...oUp, ...oStale], questions: [qUp, qStale], fixtures: [], soccerFixtures: [upcoming, stale], registry: { markets: rows }, nowMs, maxActive: 20, questionLeagues: [] });
  assert.deepEqual([p9.toSettleQuestions, p9.toWrap, [...p9.priors], p9.unmatched], [[], [], [], []]);
  // A fixture with no odds wraps without a prior.
  const noOdds = { ...upcoming }; delete noOdds.odds;
  const p6 = plan({ outcomes: oUp, questions: [qUp], fixtures: [], soccerFixtures: [noOdds], registry: { markets: [] }, nowMs, maxActive: 20 });
  assert.deepEqual(p6.toWrap.map((w) => w.priorYes), [undefined, undefined, undefined]);
  assert.equal(questionPick(qUp, oUp[1], { participantA: "A", participantB: "B", competition: "PL", sport: "Soccer", startMs: 1, expiryMs: 2 }, "home", undefined).priorYes, undefined);
});

test("plan: NFL keeps a 16-slot budget, soccer takes the rest in whole chunks of 4, flip first, most balanced first, no odds means no listing", () => {
  const nowMs = KO - 10 * D;
  const soccer = (id, home, away, odds, daysOut = 10) => ({ ...fixtureFromEspn(soccerEvent(id, home.slice(0, 3).toUpperCase(), home, away.slice(0, 3).toUpperCase(), away, nowMs + daysOut * D)), ...(odds ? { odds } : {}), league: "eng.1", matchday: 6 });
  const even = soccer("s1", "Liverpool", "Manchester City", { home: 100, draw: 245, away: 250 });
  const lopsided = soccer("s2", "Barcelona", "Getafe", { home: -1200, draw: 900, away: 2000 });
  const mild = soccer("s3", "Chelsea", "AFC Bournemouth", { home: -140, draw: 300, away: 320 });
  const unpriced = soccer("s4", "Everton", "Hull City", undefined);
  const far = soccer("s5", "Leeds United", "Arsenal", { home: 100, draw: 245, away: 250 }, 20);
  const soon = soccer("s6", "Fulham", "Ipswich Town", { home: 100, draw: 245, away: 250 }, 0.5);
  const nfl = ["A", "B", "C"].map((x, i) => fixtureFromEspn(espnEvent(x, x, `${x} Away`, `${x}H`, `${x} Home`, nowMs + (2 + i) * D), { away: -110, home: -110 }));

  // 20 per venue, NFL budget 2: NFL takes 2 on flip, soccer gets floor(18/4)=4 chunks on flip + 5 on flp = 9 chunks, 3 eligible.
  const p = plan({ outcomes: [], questions: [], fixtures: nfl, soccerFixtures: [lopsided, unpriced, far, soon, mild, even], registry: { markets: [] }, nowMs, maxActive: 20, nflMaxActive: 2 });
  assert.deepEqual(p.toRegister.map((fx) => [fx.id, fx.venue]), [["A", "flip"], ["B", "flip"]]);
  assert.deepEqual(p.toRegisterQuestions.map((fx) => [fx.id, fx.venue]), [["s1", "flip"], ["s3", "flip"], ["s2", "flip"]]);

  // 20 per venue, 3 NFL active on flip and 13 NFL slots still reserved (flip first): flip has
  // 17 free - 13 reserved = 4 -> 1 chunk; flp has 20 -> 5 chunks.
  const active = nfl.map((fx, i) => outcomeFor(fx, i + 1));
  const p2 = plan({ outcomes: active, questions: [], fixtures: nfl, soccerFixtures: [even, mild, lopsided], registry: { markets: [] }, nowMs, maxActive: 20, nflMaxActive: 16 });
  assert.deepEqual(p2.toRegister, []);
  assert.deepEqual(p2.toRegisterQuestions.map((fx) => [fx.id, fx.venue]), [["s1", "flip"], ["s3", "flp"], ["s2", "flp"]]);

  // A registered question and its fallback count as 4 active; a settling one frees its 4.
  const { question, outcomes } = questionFor(even, 1392);
  const p3 = plan({ outcomes, questions: [question], fixtures: [], soccerFixtures: [even, mild], registry: { markets: [] }, nowMs, maxActive: 4, nflMaxActive: 0 });
  // The NFL reservation holds even with no NFL fixture in sight: 40 free, 16 reserved, 6 matches fit.
  const six = ["a", "b", "c", "d", "e", "f", "g"].map((x) => soccer(x, `${x} Home`, `${x} Away`, { home: 100, draw: 245, away: 250 }));
  const pr = plan({ outcomes: [], questions: [], fixtures: [], soccerFixtures: six, registry: { markets: [] }, nowMs, maxActive: 20, nflMaxActive: 16 });
  assert.deepEqual(pr.toRegisterQuestions.map((fx) => fx.venue), ["flip", "flp", "flp", "flp", "flp", "flp"]);
  assert.deepEqual(p3.toRegisterQuestions.map((fx) => [fx.id, fx.venue]), [["s3", "flp"]]);
  // Two hours after kickoff the match is full time (same kickoff, so the question key still matches):
  // its 4 slots free up this run and the next fixture takes them on flip.
  const later = KO + 2 * H;
  const done = { ...even, ...fixtureFromEspn(soccerEvent("s1", "LIV", "Liverpool", "MNC", "Manchester City", KO, { fullTime: true, awayWins: true })) };
  const next = { ...mild, ...fixtureFromEspn(soccerEvent("s3", "CHE", "Chelsea", "BOU", "AFC Bournemouth", later + 5 * D)) };
  const p4 = plan({ outcomes, questions: [question], fixtures: [], soccerFixtures: [done, next], registry: { markets: [] }, nowMs: later, maxActive: 4, nflMaxActive: 0 });
  assert.deepEqual(p4.toSettleQuestions.map((s) => s.winner), ["away"]);
  assert.deepEqual(p4.toRegisterQuestions.map((fx) => [fx.id, fx.venue]), [["s3", "flip"]]);
});
