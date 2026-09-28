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
const DEADLINE_MS = 3 * 86400_000; // resolutionDeadline = kickoff + 3d (postponements void to 0.5)

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

/** 1-based round of `kickoffMs` within a league season: ESPN publishes no round number, so a gap
 * of more than 3 days between consecutive fixture days starts a new matchday.
 * ponytail: a midweek round played Tue/Wed right after a Sat/Sun round merges into it; the
 * stage text is display only (settlement echoes what Core stored), so a wrong number is cosmetic. */
export function matchdayOf(kickoffMs, seasonKickoffs) {
  const toDay = (ms) => Math.floor(ms / 86400_000);
  const days = [...new Set(seasonKickoffs.map(toDay))].sort((a, b) => a - b);
  let round = 0;
  let prev = -Infinity;
  for (const day of days) {
    if (day - prev > 3) round++;
    prev = day;
    if (day === toDay(kickoffMs)) return round;
  }
  throw new Error(`kickoff ${new Date(kickoffMs).toISOString()} not in season kickoffs`);
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

export function plan({ outcomes, fixtures, registry, nowMs, horizonMs = 7 * 86400_000, maxActive = 10, minWindowMs = 18 * 3600_000 }) {
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

  const priorOf = (fx) => (fx?.moneyline ? devig(fx.moneyline.away, fx.moneyline.home) : undefined);
  // Slots are scarce (10 on testnet): a game must keep at least minWindowMs of pre-kickoff
  // trading to be worth a slot, and balanced games (prior nearest 0.5) win contested slots.
  const lopsided = (fx) => Math.abs((priorOf(fx) ?? 0.5) - 0.5);
  const registered = new Set(mine.map(outcomeKey));
  // maxActive is per venue owner; fill venues in VENUES order so `flip` stays as it is and
  // `flp` only gets what `flip` cannot hold.
  const slots = VENUES.flatMap((venue) => {
    const active = mine.filter((o) => o.venue === venue && !settling.has(o.outcome)).length;
    return Array(Math.max(0, maxActive - active)).fill(venue);
  });
  const toRegister = fixtures
    .filter((fx) => !registered.has(fixtureKey(fx)) && fx.kickoffMs - nowMs >= minWindowMs && fx.kickoffMs - nowMs <= horizonMs)
    .sort((a, b) => lopsided(a) - lopsided(b) || a.kickoffMs - b.kickoffMs)
    .slice(0, slots.length)
    .map((fx, i) => ({ ...fx, venue: slots[i] }));

  const toWrap = [];
  for (const o of mine) {
    if (settling.has(o.outcome) || knownCoins.has(`#${o.outcome * 10}`)) continue;
    const ev = parseSportsEvent(o.description);
    if (!ev || ev.startMs <= nowMs) continue;
    toWrap.push(housePick(o, ev, priorOf(byKey.get(outcomeKey(o)))));
  }

  // Priors refresh pre-kickoff only; after kickoff the last pre-game number is frozen.
  const priors = new Map();
  const fxByCoin = new Map(mine.map((o) => [`#${o.outcome * 10}`, byKey.get(outcomeKey(o))]));
  for (const m of registry.markets) {
    if (!VENUES.includes(m.deployer) || !(m.startMs > nowMs)) continue;
    const p = priorOf(fxByCoin.get(m.coinYes));
    if (p !== undefined) priors.set(m.coinYes, p);
  }
  return { toSettle, toRegister, toWrap, priors };
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
