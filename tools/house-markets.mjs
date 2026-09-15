// House HIP-4 deployer sync: settle finished games, register upcoming ones (10-slot testnet
// cap), wrap our outcomes in OutcomeVaults, refresh registry priors from ESPN moneylines.
//   node tools/house-markets.mjs sync [--dry-run]
// Runs hourly from rotate.service ahead of rotate-markets.mjs; registry mtime triggers
// the writer/keeper restart there.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bigBlocks, deploy, info, ROOT, rotatedRegistry, sportsRegistryEntry } from "./rotate-lib.mjs";
import { fixtureFromEspn, LEAGUE, plan, registerAction, settleAction, withPriors } from "./house-lib.mjs";

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

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function espnFixtures() {
  const base = `https://site.api.espn.com/apis/site/v2/sports/${LEAGUE.path}/scoreboard`;
  const week = process.env.HOUSE_WEEK;
  const board = await getJson(week ? `${base}?week=${week}&seasontype=${LEAGUE.seasontype}&dates=${LEAGUE.season}` : base);
  const weekNo = Number(week ?? board.week?.number);
  const fixtures = await Promise.all((board.events ?? []).map(async (event) => {
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
    return fixtureFromEspn(event, moneyline);
  }));
  return { weekNo, fixtures };
}

const hip4 = (action) => execFileSync("uv", ["run", "tools/hip4.py", JSON.stringify(action)], { cwd: ROOT, stdio: "inherit" });
const myOutcomes = async () => (await info("outcomeMeta")).outcomes;

const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));
const nowMs = Date.now();
const { weekNo, fixtures } = await espnFixtures();
let outcomes = await myOutcomes();
let p = plan({ outcomes, fixtures, registry, nowMs, horizonMs, maxActive, minWindowMs });

console.log(`house: week ${weekNo}, ${fixtures.length} fixtures, ${outcomes.filter((o) => o.venue === "flip").length} active outcomes`);
for (const s of p.toSettle) console.log(`settle: outcome ${s.o.outcome} -> ${s.fraction} (${s.o.description})`);
for (const fx of p.toRegister) console.log(`register: ${fx.away.name} @ ${fx.home.name} ${new Date(fx.kickoffMs).toISOString()}${fx.moneyline ? ` ml ${fx.moneyline.away}/${fx.moneyline.home}` : ""}`);
for (const w of p.toWrap) console.log(`wrap: outcome ${w.outcome} ${w.title} prior ${w.priorYes ?? "-"}`);
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
let registered = 0;
for (const fx of p.toRegister) {
  try {
    hip4(registerAction(fx, weekNo));
    registered++;
  } catch (err) {
    console.log(`register failed for ${fx.away.name} @ ${fx.home.name}: ${err.message} — retry next run`);
    break; // cap or rejection: later fixtures will not fare better this hour
  }
}
if (settled || registered) {
  outcomes = await myOutcomes();
  p = plan({ outcomes, fixtures, registry, nowMs, horizonMs, maxActive, minWindowMs });
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
      const vault = await deploy(pick);
      deployed.push({ ...sportsRegistryEntry(pick, vault), ...(pick.priorYes !== undefined ? { priorYes: pick.priorYes } : {}) });
      console.log(`wrapped ${vault} for outcome ${pick.outcome}`);
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
