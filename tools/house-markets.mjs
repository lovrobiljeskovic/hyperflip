// House HIP-4 deployer sync: settle finished games, register upcoming ones (20 slots per venue on testnet,
// `flip` filled before `flp`; NFL keeps a 16-slot weekly budget, soccer 3-way questions take the rest at
// 4 slots a match), wrap our outcomes in OutcomeVaults, refresh registry priors from ESPN odds.
//   node tools/house-markets.mjs sync [--dry-run]
// Runs hourly from rotate.service ahead of rotate-markets.mjs; registry mtime triggers
// the writer/keeper restart there.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bigBlocks, deployPair, info, ROOT, rotatedRegistry, sportsRegistryEntry } from "./rotate-lib.mjs";
import { fixtureFromEspn, LEAGUE, LEAGUES, matchdayOf, plan, registerAction, registerQuestionAction, settleAction, settleQuestionAction, VENUES, withPriors } from "./house-lib.mjs";

const REGISTRY = path.join(ROOT, "registry/markets.json");
const dryRun = process.argv.includes("--dry-run");
if (process.argv[2] !== "sync") {
  console.error("usage: node tools/house-markets.mjs sync [--dry-run]");
  process.exit(2);
}
process.loadEnvFile(path.join(ROOT, ".env"));
for (const key of ["PRIVATE_KEY", "TESTNET_RPC", "KEEPER_ADDRESS"]) {
  if (!process.env[key]) {
    console.error(`${key} must be set in .env`);
    process.exit(1);
  }
}
const horizonMs = Number(process.env.HOUSE_HORIZON_DAYS ?? 7) * 86400_000;
const maxActive = Number(process.env.HOUSE_MAX_ACTIVE ?? 10);
const minWindowMs = Number(process.env.HOUSE_MIN_WINDOW_HOURS ?? 18) * 3600_000;
const soccerHorizonMs = Number(process.env.HOUSE_SOCCER_HORIZON_DAYS ?? 14) * 86400_000;
const nflMaxActive = Number(process.env.HOUSE_NFL_MAX_ACTIVE ?? 16);
const leagueKeys = (process.env.HOUSE_LEAGUES ?? "nfl").split(",").map((s) => s.trim()).filter(Boolean);
const leagues = LEAGUES.filter((l) => leagueKeys.includes(l.key));
for (const key of leagueKeys) if (!leagues.some((l) => l.key === key)) throw new Error(`HOUSE_LEAGUES: unknown league ${key}`);
const leagueByKey = new Map(leagues.map((l) => [l.key, l]));

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function espnFixtures() {
  const base = `https://site.api.espn.com/apis/site/v2/sports/${LEAGUE.path}/scoreboard`;
  const byWeek = (w) => getJson(`${base}?week=${w}&seasontype=${LEAGUE.seasontype}&dates=${LEAGUE.season}`);
  const board = process.env.HOUSE_WEEK ? await byWeek(process.env.HOUSE_WEEK) : await getJson(base);
  const weekNo = Number(process.env.HOUSE_WEEK ?? board.week?.number);
  // A slot freed by Sunday's finals should be refilled at once, not on Tuesday when ESPN's
  // "current week" finally advances: fetch the next week too. plan()'s horizon still bounds
  // how far ahead a game may be listed, so this only widens the candidate pool.
  const boards = [{ week: weekNo, board }];
  if (weekNo) boards.push({ week: weekNo + 1, board: await byWeek(weekNo + 1).catch(() => ({ events: [] })) });
  const events = boards.flatMap(({ week, board: b }) => (b.events ?? []).map((event) => ({ week, event })));
  const fixtures = await Promise.all(events.map(async ({ week, event }) => {
    let moneyline;
    try {
      const odds = await getJson(`https://sports.core.api.espn.com/v2/sports/${LEAGUE.path.replace("/", "/leagues/")}/events/${event.id}/competitions/${event.id}/odds`);
      const item = odds.items?.[0];
      const away = item?.awayTeamOdds?.moneyLine;
      const home = item?.homeTeamOdds?.moneyLine;
      if (Number.isFinite(away) && Number.isFinite(home)) moneyline = { away, home };
    } catch (err) {
      console.log(`odds unavailable for ${event.name}: ${err.message}`);
    }
    return { ...fixtureFromEspn(event, moneyline), week };
  }));
  return { weekNo, fixtures };
}

/** ESPN soccer: the scoreboard only answers month queries (`dates=YYYYMM`); a single day returns
 * nothing and the bare call is stuck on a stale day. Fetch every month from the season start so
 * each team's matchday can be counted, keep fixtures from 7 days back (settle window, wider than the
 * 3-day deadline so a late settle still sees the result) to the soccer horizon, and price upcoming
 * ones from the DraftKings 3-way line. */
async function espnSoccerFixtures(league, nowMs) {
  const base = `https://site.api.espn.com/apis/site/v2/sports/${league.path}/scoreboard`;
  const months = [];
  const end = new Date(nowMs);
  for (let d = new Date(league.seasonStartMs); d <= new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 1)); d.setUTCMonth(d.getUTCMonth() + 1)) {
    months.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  const seen = new Map();
  for (const m of months) for (const e of (await getJson(`${base}?dates=${m}&limit=300`)).events ?? []) seen.set(e.id, e);
  const events = [...seen.values()];
  const teamKickoffs = new Map(); // team displayName -> its kickoffs this season
  for (const e of events) {
    for (const t of e.competitions[0].competitors) teamKickoffs.set(t.team.displayName, [...(teamKickoffs.get(t.team.displayName) ?? []), Date.parse(e.date)]);
  }
  const fixtures = [];
  for (const event of events) {
    const kickoffMs = Date.parse(event.date);
    if (kickoffMs < nowMs - 7 * 86400_000 || kickoffMs > nowMs + soccerHorizonMs) continue;
    let odds;
    if (kickoffMs > nowMs) {
      try {
        const o = await getJson(`https://sports.core.api.espn.com/v2/sports/${league.path.replace("/", "/leagues/")}/events/${event.id}/competitions/${event.id}/odds`);
        const item = o.items?.[0];
        const line = [item?.homeTeamOdds?.moneyLine, item?.drawOdds?.moneyLine, item?.awayTeamOdds?.moneyLine];
        if (line.every(Number.isFinite)) odds = { home: line[0], draw: line[1], away: line[2] };
      } catch (err) {
        console.log(`odds unavailable for ${event.name}: ${err.message}`);
      }
    }
    const fx = fixtureFromEspn(event);
    fixtures.push({ ...fx, ...(odds ? { odds } : {}), league: league.key, matchday: matchdayOf(kickoffMs, teamKickoffs.get(fx.home.name)) });
  }
  return fixtures;
}

const hip4 = (action) => execFileSync("uv", ["run", "tools/hip4.py", JSON.stringify(action)], { cwd: ROOT, stdio: "inherit" });
const meta = async () => {
  const { outcomes, questions } = await info("outcomeMeta");
  return { outcomes, questions };
};

const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));
const nowMs = Date.now();
const nfl = leagues.find((l) => l.kind === "standalone");
const { weekNo, fixtures } = nfl ? await espnFixtures() : { weekNo: undefined, fixtures: [] };
// A league whose ESPN fetch fails this hour is dropped from the run entirely (no settle, no
// register, no priors) so one feed outage neither blocks NFL nor settles anything blind.
const questionLeagues = [];
const soccerFixtures = [];
for (const league of leagues.filter((l) => l.kind === "question")) {
  try {
    soccerFixtures.push(...(await espnSoccerFixtures(league, nowMs)));
    questionLeagues.push(league);
  } catch (err) {
    console.log(`ESPN ${league.key} unavailable, league skipped this run: ${err.message}`);
  }
}
let { outcomes, questions } = await meta();
const planArgs = () => ({ outcomes, questions, fixtures, soccerFixtures, registry, nowMs, horizonMs, soccerHorizonMs, maxActive, nflMaxActive, minWindowMs, questionLeagues });
let p = plan(planArgs());

const activeLine = () => VENUES.map((v) => `${v}=${outcomes.filter((o) => o.venue === v).length}`).join(" ");
console.log(`house: week ${weekNo ?? "-"}, ${fixtures.length} NFL fixtures, ${soccerFixtures.length} soccer fixtures, active ${activeLine()}`);
for (const s of p.toSettle) console.log(`settle: outcome ${s.o.outcome} -> ${s.fraction} (${s.o.description})`);
for (const s of p.toSettleQuestions) console.log(`settle question ${s.q.question} -> ${s.winner} (${s.q.description})`);
for (const u of p.unmatched) console.log(`WARN question ${u.q.question} ${u.reason}, left unsettled (${u.q.description})`);
for (const fx of p.toRegister) console.log(`register on ${fx.venue}: ${fx.away.name} @ ${fx.home.name} ${new Date(fx.kickoffMs).toISOString()}${fx.moneyline ? ` ml ${fx.moneyline.away}/${fx.moneyline.home}` : ""}`);
for (const fx of p.toRegisterQuestions) console.log(`register question on ${fx.venue}: ${fx.home.name} v ${fx.away.name} ${new Date(fx.kickoffMs).toISOString()} ${fx.league} md${fx.matchday} ml ${fx.odds.home}/${fx.odds.draw}/${fx.odds.away}`);
for (const w of p.toWrap) console.log(`wrap: outcome ${w.outcome} ${w.groupTitle && w.groupTitle !== w.title ? `${w.groupTitle} / ` : ""}${w.title} prior ${w.priorYes ?? "-"}`);
for (const [coin, prior] of p.priors) console.log(`prior: ${coin} ${prior}`);
if (dryRun) {
  console.log("dry run — stopping before Core actions");
  process.exit(0);
}

let settled = 0;
for (const s of p.toSettle) {
  try {
    hip4(settleAction(s.o, s.fraction));
    settled++;
  } catch (err) {
    console.log(`settle failed for outcome ${s.o.outcome}: ${err.message}`);
  }
}
for (const s of p.toSettleQuestions) {
  try {
    hip4(settleQuestionAction(s.q, s.sides, s.winner));
    settled++;
  } catch (err) {
    console.log(`settle failed for question ${s.q.question}: ${err.message}`);
  }
}
let registered = 0;
const failedVenues = new Set();
for (const fx of p.toRegister) {
  if (failedVenues.has(fx.venue)) continue; // cap or rejection: later fixtures on that venue will not fare better this hour
  try {
    hip4(registerAction(fx, fx.week ?? weekNo));
    registered++;
  } catch (err) {
    console.log(`register failed on ${fx.venue} for ${fx.away.name} @ ${fx.home.name}: ${err.message} — retry next run`);
    failedVenues.add(fx.venue);
  }
}
for (const fx of p.toRegisterQuestions) {
  if (failedVenues.has(fx.venue)) continue;
  let action;
  try {
    action = registerQuestionAction(fx, leagueByKey.get(fx.league)); // a bad team name skips this fixture only
  } catch (err) {
    console.log(`skip ${fx.home.name} v ${fx.away.name}: ${err.message}`);
    continue;
  }
  try {
    hip4(action);
    registered += 4;
  } catch (err) {
    console.log(`register failed on ${fx.venue} for ${fx.home.name} v ${fx.away.name}: ${err.message} — retry next run`);
    failedVenues.add(fx.venue);
  }
}
if (registered >= 40) console.log(`WARN: ${registered} deployments this run; the testnet daily cap is 50`);
if (settled || registered) {
  ({ outcomes, questions } = await meta());
  p = plan(planArgs());
}

const kept = withPriors(registry.markets, p.priors);
const priorsChanged = kept !== registry.markets;
const deployed = [];
const writeRegistry = () =>
  writeFileSync(REGISTRY, JSON.stringify(rotatedRegistry(registry, [...kept, ...deployed], registry.archived ?? []), null, 2) + "\n");

if (p.toWrap.length) {
  bigBlocks("on");
  try {
    for (const pick of p.toWrap) {
      const { vault, sourceVault } = await deployPair(pick);
      deployed.push({ ...sportsRegistryEntry(pick, vault, sourceVault), ...(pick.priorYes !== undefined ? { priorYes: pick.priorYes } : {}) });
      console.log(`wrapped ${sourceVault ?? vault}${sourceVault ? ` (leg ${vault})` : ""} for outcome ${pick.outcome}`);
    }
  } finally {
    // Record landed vaults even if resetting the block mode fails.
    try {
      bigBlocks("off");
    } finally {
      if (deployed.length || priorsChanged) writeRegistry();
    }
  }
} else if (priorsChanged) {
  writeRegistry();
}
console.log(`house: settled ${settled}, registered ${registered}, wrapped ${deployed.length}, priors ${p.priors.size}${priorsChanged || deployed.length ? " (registry written)" : ""}`);
