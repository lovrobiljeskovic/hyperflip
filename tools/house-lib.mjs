// Pure planning for house-deployed HIP-4 markets. State lives on Core (outcomeMeta) and at
// ESPN; nothing is persisted here. CLI: tools/house-markets.mjs.
import { eventKey, parseSportsEvent } from "./rotate-lib.mjs";

// Testnet caps each venue owner at 10 active outcomes, so we own two venues. Fill order matters:
// `flip` first, `flp` only takes the overflow. Sub-deployer (box EOA) is the same on both.
export const VENUES = ["flip", "flp"];
export const TEMPLATE = "sportsContestWinner7";
// One entry per league we deploy. `standalone` leagues use sportsContestWinner7 (one Yes/No outcome
// per game); `question` leagues use sportsContestResult5 (Home / Draw / Away + fallback, 4 slots).
export const LEAGUE = { key: "nfl", kind: "standalone", path: "football/nfl", competition: "NFL", sport: "American football", officialSource: "NFL", season: "2026", seasontype: 2 };
export const LEAGUES = [
  LEAGUE,
  { key: "eng.1", kind: "question", path: "soccer/eng.1", competition: "Premier League", officialSource: "Premier League", sport: "Soccer", season: "2026/27", contestType: "Match", seasonStartMs: Date.UTC(2026, 7, 1) },
  { key: "esp.1", kind: "question", path: "soccer/esp.1", competition: "La Liga", officialSource: "La Liga", sport: "Soccer", season: "2026/27", contestType: "Match", seasonStartMs: Date.UTC(2026, 7, 1) },
];
export const QUESTION_TEMPLATE = "sportsContestResult5";
const DEADLINE_MS = 3 * 86400_000; // resolutionDeadline = kickoff + 3d (NFL: postponement voids to 0.5; soccer: Draw)

/** Implied P(away) from two American moneylines, vig removed by normalisation. */
export function devig(awayMl, homeMl) {
  const dec = (ml) => (ml > 0 ? 1 + ml / 100 : 1 + 100 / -ml);
  const a = 1 / dec(awayMl);
  const h = 1 / dec(homeMl);
  return Math.round((a / (a + h)) * 1e4) / 1e4;
}

/** Implied Home/Draw/Away from three American moneylines, vig removed by normalisation. */
export function devig3(homeMl, drawMl, awayMl) {
  const dec = (ml) => (ml > 0 ? 1 + ml / 100 : 1 + 100 / -ml);
  const h = 1 / dec(homeMl);
  const d = 1 / dec(drawMl);
  const a = 1 / dec(awayMl);
  const s = h + d + a;
  const r = (x) => Math.round((x / s) * 1e4) / 1e4;
  return { home: r(h), draw: r(d), away: r(a) };
}

/** 1-based matchday of `kickoffMs` for one team: how many of that team's league fixtures fall on
 * or before the kickoff. ESPN publishes no round number; counting a team's own games survives
 * midweek rounds and Fri-Mon spreads, where clustering by date gaps does not. */
export function matchdayOf(kickoffMs, teamKickoffs) {
  if (!teamKickoffs.includes(kickoffMs)) throw new Error(`kickoff ${new Date(kickoffMs).toISOString()} not in season kickoffs`);
  return teamKickoffs.filter((ms) => ms <= kickoffMs).length;
}

/** Inverse of rotate-lib parseStamp: ms -> YYYYMMDD-HHMM UTC. */
export function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

const FINAL_STATUS = new Set(["STATUS_FINAL", "STATUS_FULL_TIME"]); // NFL / soccer

/** ESPN scoreboard event -> fixture. `winner` is "A" (away) / "B" (home) / "tie" / null. */
export function fixtureFromEspn(event, moneyline) {
  const c = event.competitions[0];
  const side = (ha) => c.competitors.find((t) => t.homeAway === ha);
  const away = side("away");
  const home = side("home");
  const final = FINAL_STATUS.has(c.status?.type?.name) && c.status?.type?.completed === true;
  const winner = !final ? null : away.winner ? "A" : home.winner ? "B" : "tie";
  return {
    id: event.id,
    kickoffMs: Date.parse(event.date),
    away: { abbr: away.team.abbreviation, name: away.team.displayName },
    home: { abbr: home.team.abbreviation, name: home.team.displayName },
    final,
    winner,
    ...(moneyline ? { moneyline } : {}),
  };
}

const checkValue = (k, v) => {
  if (v.length > 100 || /[{}|]/.test(v)) throw new Error(`keyword ${k} invalid: ${v}`);
  return v;
};

export function registerAction(fx, week, venue = fx.venue) {
  if (!VENUES.includes(venue)) throw new Error(`unknown venue: ${venue}`);
  const stage = `Week ${week}`;
  const kv = {
    competition: LEAGUE.competition, contestType: "game", officialSource: LEAGUE.officialSource,
    participantA: fx.away.name, participantB: fx.home.name,
    resolutionDeadline: stamp(fx.kickoffMs + DEADLINE_MS), scheduledStart: stamp(fx.kickoffMs),
    season: LEAGUE.season, shortNameA: fx.away.abbr, shortNameB: fx.home.abbr, sport: LEAGUE.sport, stage,
  };
  for (const [k, v] of Object.entries(kv)) checkValue(k, v);
  if (kv.shortNameA.length > 10 || kv.shortNameB.length > 10) throw new Error("shortName > 10 chars");
  const name = `${kv.competition} ${stage}: ${kv.participantA} v ${kv.participantB}`;
  if (name.length > 70) throw new Error(`name > 70 chars: ${name}`);
  const keywordToValue = Object.entries(kv).sort(([a], [b]) => (a < b ? -1 : 1));
  return { type: "outcomeDeploy", venue, operation: { registerStandaloneOutcomeFromTemplate: { id: TEMPLATE, keywordToValue, deployerFeeScale: "1" } } };
}

export const questionFixtureKey = (fx) => `${fx.home.name}|${fx.away.name}|${fx.kickoffMs}`;

/** Soccer questions list the home side as participantA (question 1392 set the precedent). */
export function registerQuestionAction(fx, league, venue = fx.venue) {
  if (!VENUES.includes(venue)) throw new Error(`unknown venue: ${venue}`);
  if (!(fx.matchday >= 1)) throw new Error(`fixture ${fx.id} has no matchday`);
  const kv = {
    competition: league.competition, contestType: league.contestType, officialSource: league.officialSource,
    participantA: fx.home.name, participantB: fx.away.name,
    resolutionDeadline: stamp(fx.kickoffMs + DEADLINE_MS), scheduledStart: stamp(fx.kickoffMs),
    season: league.season, sport: league.sport, stage: `Matchday ${fx.matchday}`,
  };
  for (const [k, v] of Object.entries(kv)) checkValue(k, v);
  for (const p of [kv.participantA, kv.participantB]) if (p.length > 25) throw new Error(`participant > 25 chars: ${p}`);
  const name = `${kv.competition} ${kv.stage}: ${kv.participantA} v ${kv.participantB}`;
  if (name.length > 70) throw new Error(`name > 70 chars: ${name}`);
  const keywordToValue = Object.entries(kv).sort(([a], [b]) => (a < b ? -1 : 1));
  return {
    type: "outcomeDeploy", venue,
    operation: { registerQuestionFromTemplate: {
      questionTemplateInstance: { id: QUESTION_TEMPLATE, keywordToValue, deployerFeeScale: "1" },
      namedOutcomeTemplateInstances: [
        { id: "sportsContestParticipant5", keywordToValue: [["participant", kv.participantA]] },
        { id: "sportsContestDraw5", keywordToValue: [] },
        { id: "sportsContestParticipant5", keywordToValue: [["participant", kv.participantB]] },
      ],
    } },
  };
}

export const fixtureKey = (fx) => `${fx.away.name}|${fx.home.name}|${fx.kickoffMs}`;
export const outcomeKey = (o) => {
  const ev = parseSportsEvent(o.description);
  return ev ? `${ev.participantA}|${ev.participantB}|${ev.startMs}` : null;
};

/** Settlement copies name/description/sideSpecs from outcomeMeta verbatim: Core rejects any drift. */
export function settleAction(o, fraction) {
  return {
    type: "outcomeDeploy", venue: o.venue,
    operation: { settleOutcome: { outcome: o.outcome, settleFraction: fraction, details: "", nameAndDescription: [o.name, o.description], sideNames: o.sideSpecs.map((s) => s.name) } },
  };
}

/** fixtureFromEspn winner ("A" = away, "B" = home, "tie") -> question side. */
export const winnerSide = (fx) => (fx.winner === "B" ? "home" : fx.winner === "A" ? "away" : fx.winner === "tie" ? "draw" : null);

/** Which side each named outcome of a 3-way soccer question stands for, in namedOutcomes order.
 * null when the question is not ours to settle: a member is missing from outcomeMeta, or a
 * participant matches neither side of the question's own description. */
export function questionSides(q, byId) {
  const ev = parseSportsEvent(q.description);
  if (!ev) return null;
  const sides = [];
  for (const id of q.namedOutcomes ?? []) {
    const o = byId.get(id);
    if (!o) return null;
    const side = o.name === "template:sportsContestDraw5" ? "draw"
      : o.description === `participant:${ev.participantA}` ? "home"
      : o.description === `participant:${ev.participantB}` ? "away" : null;
    if (!side) return null;
    sides.push({ o, side });
  }
  return sides.length === 3 && new Set(sides.map((s) => s.side)).size === 3 ? sides : null;
}

/** settleQuestion2 must cover exactly the remaining named outcomes, one of them at "1", and echo
 * names/descriptions/side names verbatim. The fallback settles to 0 on its own. */
export function settleQuestionAction(q, sides, winner) {
  const settled = new Set(q.settledNamedOutcomes ?? []);
  return {
    type: "outcomeDeploy", venue: sides[0].o.venue,
    operation: { settleQuestion2: {
      question: q.question,
      outcomeSettlements: sides.filter(({ o }) => !settled.has(o.outcome)).map(({ o, side }) => ({
        outcome: o.outcome, settleFraction: side === winner ? "1" : "0", details: "",
        nameAndDescription: [o.name, o.description], sideNames: o.sideSpecs.map((s) => s.name),
      })),
      nameAndDescription: [q.name, q.description],
    } },
  };
}

const fractionFor = (winner) => (winner === "A" ? "1" : winner === "B" ? "0" : "0.5");

/** Pick shape consumed by rotate-lib deploy() + sportsRegistryEntry(). */
export function housePick(o, ev, priorYes) {
  const title = `${ev.participantA} vs ${ev.participantB}`;
  return {
    outcome: o.outcome, coinYes: `#${o.outcome * 10}`, coinNo: `#${o.outcome * 10 + 1}`, question: null, group: null,
    title, groupTitle: title, sideYes: ev.shortNameA, sideNo: ev.shortNameB, underlying: eventKey(ev), cluster: ev.competition,
    sport: ev.sport, startMs: ev.startMs, expiryMs: ev.expiryMs, deployer: o.venue, ...(priorYes !== undefined ? { priorYes } : {}),
  };
}

const sideLabel = (ev, side) => (side === "draw" ? "Draw" : side === "home" ? ev.participantA : ev.participantB);

/** Same leg shape rotate-lib pickSports builds for third-party questions, plus the house prior,
 * so rotate-markets sees the coin as known and the writer/app treat it like any question leg. */
export function questionPick(q, o, ev, side, priorYes) {
  const label = sideLabel(ev, side);
  const underlying = `q${q.question}`;
  return {
    outcome: o.outcome, coinYes: `#${o.outcome * 10}`, coinNo: `#${o.outcome * 10 + 1}`, question: q.question, group: underlying,
    groupTitle: `${ev.participantA} vs ${ev.participantB}`, title: label, sideYes: label, sideNo: `Not ${label}`, underlying,
    cluster: ev.competition, sport: ev.sport, startMs: ev.startMs, expiryMs: ev.expiryMs, deployer: o.venue,
    ...(priorYes !== undefined ? { priorYes } : {}),
  };
}

const prior3 = (fx) => (fx?.odds ? devig3(fx.odds.home, fx.odds.draw, fx.odds.away) : undefined);

export function plan({ outcomes, questions = [], fixtures, soccerFixtures = [], registry, nowMs, horizonMs = 7 * 86400_000, soccerHorizonMs = 14 * 86400_000, maxActive = 10, nflMaxActive = 16, minWindowMs = 18 * 3600_000, questionLeagues = LEAGUES.filter((l) => l.kind === "question") }) {
  const mine = outcomes.filter((o) => VENUES.includes(o.venue) && o.name === `template:${TEMPLATE}`);
  const byKey = new Map(fixtures.map((fx) => [fixtureKey(fx), fx]));
  const knownCoins = new Set(registry.markets.map((m) => m.coinYes));

  const toSettle = [];
  for (const o of mine) {
    const ev = parseSportsEvent(o.description);
    const fx = byKey.get(outcomeKey(o));
    if (fx?.final) toSettle.push({ o, fx, fraction: fractionFor(fx.winner) });
    else if (ev && ev.expiryMs <= nowMs) toSettle.push({ o, fx: fx ?? null, fraction: "0.5" }); // no result by deadline
  }
  const settling = new Set(toSettle.map((s) => s.o.outcome));

  // Our 3-way soccer questions: every member must be present and match the question's own sides,
  // and the competition must be enabled this run. A league whose ESPN feed is off or disabled is
  // left alone entirely: settling it blind would pay the Draw side on no evidence.
  const byId = new Map(outcomes.map((o) => [o.outcome, o]));
  const enabled = new Set(questionLeagues.map((l) => l.competition));
  const mineQ = [];
  for (const q of questions) {
    if (q.name !== `template:${QUESTION_TEMPLATE}`) continue;
    const sides = questionSides(q, byId);
    if (!sides || !VENUES.includes(sides[0].o.venue)) continue;
    const ev = parseSportsEvent(q.description);
    if (!enabled.has(ev.competition)) continue;
    mineQ.push({ q, sides, venue: sides[0].o.venue, ev });
  }
  // A question and a fixture are the same match when the pairing matches and the kickoff is within
  // the deadline window: ESPN moves kickoffs after we register (TV picks), and a pairing does not
  // recur that close in league play.
  const pairKey = (a, b) => `${a}|${b}`;
  const fixturesByPair = new Map();
  for (const fx of soccerFixtures) {
    const k = pairKey(fx.home.name, fx.away.name);
    fixturesByPair.set(k, [...(fixturesByPair.get(k) ?? []), fx]);
  }
  const fixtureOf = (m) => (fixturesByPair.get(pairKey(m.ev.participantA, m.ev.participantB)) ?? [])
    .filter((fx) => Math.abs(fx.kickoffMs - m.ev.startMs) <= DEADLINE_MS)
    .sort((a, b) => Math.abs(a.kickoffMs - m.ev.startMs) - Math.abs(b.kickoffMs - m.ev.startMs))[0];
  const toSettleQuestions = [];
  const unmatched = [];
  for (const m of mineQ) {
    const fx = fixtureOf(m);
    if (fx?.final) toSettleQuestions.push({ ...m, fx, winner: winnerSide(fx) });
    else if (m.ev.expiryMs <= nowMs) {
      if (fx) toSettleQuestions.push({ ...m, fx, winner: "draw" }); // known match, no result by the deadline: Draw
      else unmatched.push({ q: m.q, reason: "past deadline, no ESPN fixture" }); // wait, never guess
    }
  }
  const settlingQ = new Set(toSettleQuestions.map((s) => s.q.question));

  const priorOf = (fx) => (fx?.moneyline ? devig(fx.moneyline.away, fx.moneyline.home) : undefined);
  // Slots are scarce (20 per venue on testnet): a game must keep at least minWindowMs of pre-kickoff
  // trading to be worth a slot, and balanced games (prior nearest 0.5) win contested slots.
  const lopsided = (fx) => Math.abs((priorOf(fx) ?? 0.5) - 0.5);
  const registered = new Set(mine.map(outcomeKey));
  // Every outcome on a venue counts against its cap: standalone games, question members and
  // fallbacks. Outcomes settling this run are freed up front.
  const activeOn = (venue) =>
    outcomes.filter((o) => o.venue === venue && !settling.has(o.outcome)).length -
    4 * toSettleQuestions.filter((s) => s.venue === venue).length;
  // NFL keeps a fixed budget across both venues (one week of games); fill `flip` first so it
  // stays as it is and `flp` only gets what `flip` cannot hold.
  const nflRoom = Math.max(0, nflMaxActive - mine.filter((o) => !settling.has(o.outcome)).length);
  const slots = VENUES.flatMap((venue) => Array(Math.max(0, maxActive - activeOn(venue))).fill(venue)).slice(0, nflRoom);
  const toRegister = fixtures
    .filter((fx) => !registered.has(fixtureKey(fx)) && fx.kickoffMs - nowMs >= minWindowMs && fx.kickoffMs - nowMs <= horizonMs)
    .sort((a, b) => lopsided(a) - lopsided(b) || a.kickoffMs - b.kickoffMs)
    .slice(0, slots.length)
    .map((fx, i) => ({ ...fx, venue: slots[i] }));

  // Soccer takes what NFL left, four outcomes per match, most balanced match first. NFL's unused
  // budget stays reserved (flip first) so a bye week or an empty horizon never hands its slots away.
  const nflAssigned = (venue) => toRegister.filter((fx) => fx.venue === venue).length;
  let reserve = nflRoom - toRegister.length;
  const qSlots = VENUES.flatMap((venue) => {
    const free = Math.max(0, maxActive - activeOn(venue) - nflAssigned(venue));
    const held = Math.min(reserve, free);
    reserve -= held;
    return Array(Math.floor((free - held) / 4)).fill(venue);
  });
  const isRegistered = (fx) => mineQ.some((m) => fixtureOf(m) === fx);
  const balance3 = (fx) => Math.max(...Object.values(prior3(fx)));
  const toRegisterQuestions = soccerFixtures
    .filter((fx) => fx.odds && !isRegistered(fx) && fx.kickoffMs - nowMs >= minWindowMs && fx.kickoffMs - nowMs <= soccerHorizonMs)
    .sort((a, b) => balance3(a) - balance3(b) || a.kickoffMs - b.kickoffMs)
    .slice(0, qSlots.length)
    .map((fx, i) => ({ ...fx, venue: qSlots[i] }));

  const toWrap = [];
  for (const o of mine) {
    if (settling.has(o.outcome) || knownCoins.has(`#${o.outcome * 10}`)) continue;
    const ev = parseSportsEvent(o.description);
    if (!ev || ev.startMs <= nowMs) continue;
    toWrap.push(housePick(o, ev, priorOf(byKey.get(outcomeKey(o)))));
  }

  for (const m of mineQ) {
    if (settlingQ.has(m.q.question) || m.ev.startMs <= nowMs) continue;
    const p = prior3(fixtureOf(m));
    for (const { o, side } of m.sides) {
      if (knownCoins.has(`#${o.outcome * 10}`)) continue;
      toWrap.push(questionPick(m.q, o, m.ev, side, p?.[side]));
    }
  }

  // Priors refresh pre-kickoff only; after kickoff the last pre-game number is frozen.
  const priors = new Map();
  const fxByCoin = new Map(mine.map((o) => [`#${o.outcome * 10}`, byKey.get(outcomeKey(o))]));
  const qByCoin = new Map();
  for (const m of mineQ) {
    const fx = fixtureOf(m);
    for (const { o, side } of m.sides) qByCoin.set(`#${o.outcome * 10}`, { fx, side });
  }
  for (const m of registry.markets) {
    if (!VENUES.includes(m.deployer) || !(m.startMs > nowMs)) continue;
    const hit = qByCoin.get(m.coinYes);
    const p = hit ? prior3(hit.fx)?.[hit.side] : priorOf(fxByCoin.get(m.coinYes));
    if (p !== undefined) priors.set(m.coinYes, p);
  }
  return { toSettle, toSettleQuestions, unmatched, toRegister, toRegisterQuestions, toWrap, priors };
}

/** Same array reference back when no prior changed, so callers can skip the write. */
export function withPriors(markets, priors) {
  let changed = false;
  const out = markets.map((m) => {
    const p = priors.get(m.coinYes);
    if (p === undefined || m.priorYes === p) return m;
    changed = true;
    return { ...m, priorYes: p };
  });
  return changed ? out : markets;
}
