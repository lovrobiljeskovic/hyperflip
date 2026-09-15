import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const INFO_URL = "https://api.hyperliquid-testnet.xyz/info";
const PUBLIC_DEPLOY_RPCS = ["https://rpc.hyperliquid-testnet.xyz/evm", "https://rpcs.chain.link/hyperevm/testnet", "https://hyperliquid-testnet.drpc.org"];
export const DEPLOY_ENV = {
  QUOTE_TOKEN_ADDRESS: "0x2B3370eE501B4a559b57D449569354196457D8Ab",
  CORE_SYSTEM_ADDRESS: "0x2000000000000000000000000000000000000000",
  QUOTE_TOKEN_CORE_INDEX: "0",
  VERIFIER_ADDRESS: "0xc19d502255852C3D2564C027b61556EB2E89e431",
  QUESTION_ID: String(0xffffffff), // standalone-binary sentinel
};
// Read at call time so `.env` (loaded by the CLI after import) is honoured.
const deployRpcs = () => [...new Set([...(process.env.DEPLOY_RPCS ?? "").split(",").map((u) => u.trim()).filter(Boolean), ...PUBLIC_DEPLOY_RPCS])];

export async function info(type, extra = {}) {
  const res = await fetch(INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, ...extra }),
  });
  if (!res.ok) throw new Error(`info ${type}: HTTP ${res.status}`);
  return res.json();
}

export function bigBlocks(flag) {
  execFileSync("uv", ["run", "tools/bigblocks.py", flag], { cwd: ROOT, stdio: "inherit" });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function landedVault(pick, polls = 6) {
  let tx;
  try {
    const broadcast = JSON.parse(readFileSync(path.join(ROOT, "broadcast/Deploy.s.sol/998/run-latest.json"), "utf8"));
    tx = broadcast.transactions.find((t) => t.contractName === "OutcomeVault" && t.arguments?.[4] === String(pick.outcome));
  } catch {
    return null;
  }
  if (!tx) return null;
  const rpcs = deployRpcs();
  for (let i = 0; i < polls; i++) {
    for (const rpc of rpcs) {
      try {
        const res = await fetch(rpc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [tx.hash] }),
        });
        const receipt = (await res.json()).result;
        if (receipt?.status === "0x1") return tx.contractAddress;
        if (receipt) return null; // landed but reverted
      } catch {} // RPC flake — try the other / next poll
    }
    await sleep(20_000); // big blocks tick ~60s; give a pending tx time
  }
  return null;
}

export async function deploy(pick, attempts = 4) {
  const prior = await landedVault(pick, 1);
  if (prior) {
    console.log(`reusing already-landed vault ${prior} for outcome ${pick.outcome}`);
    return prior;
  }
  const rpcs = deployRpcs();
  for (let i = 0; i < attempts; i++) {
    try {
      execFileSync(
        "forge",
        // Pass the signing key through the environment, never command arguments.
        ["script", "script/Deploy.s.sol", "--rpc-url", rpcs[i % rpcs.length], "--broadcast", "--legacy", "--sig", "run()", "--retries", "12", "--delay", "10"],
        {
          cwd: ROOT,
          stdio: "inherit",
          env: {
            ...process.env,
            ...DEPLOY_ENV,
            // Question members must settle against their actual question ID.
            ...(pick.question != null ? { QUESTION_ID: String(pick.question) } : {}),
            OUTCOME_ID: String(pick.outcome),
            MARKET_SYMBOL: sportsMarketSymbol(pick),
          },
        },
      );
    } catch (err) {
      console.log(`forge exited non-zero for outcome ${pick.outcome} (attempt ${i + 1}) — checking chain for a landed tx...`);
    }
    const vault = await landedVault(pick);
    if (vault) return vault;
    if (i + 1 < attempts) {
      console.log(`no landed tx for outcome ${pick.outcome}, retrying on other RPC in 15s...`);
      await sleep(15_000);
    }
  }
  throw new Error(`deploy failed for outcome ${pick.outcome} after ${attempts} attempts`);
}

function parseFields(description) {
  return Object.fromEntries(
    description.split("|").map((kv) => {
      const i = kv.indexOf(":");
      return i === -1 ? [kv, ""] : [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );
}

export function parseStamp(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(stamp ?? "");
  return m === null ? null : Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

export function rotatedRegistry(registry, markets, archived) {
  if (registry.network !== "testnet") throw new Error("market registry network must be testnet");
  return { network: registry.network, markets, archived };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const yyyymmdd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");

export function parseSportsEvent(description) {
  const f = parseFields(description ?? "");
  const startMs = parseStamp(f.scheduledStart);
  const expiryMs = parseStamp(f.resolutionDeadline);
  if (startMs === null || expiryMs === null || expiryMs < startMs) return null;
  const eventCompetition = /\(([^)]+)\)\s*$/.exec(f.event ?? "")?.[1];
  return {
    competition: f.competition || eventCompetition || f.event || "sports",
    sport: f.sport || null,
    participantA: f.participantA || null,
    participantB: f.participantB || null,
    shortNameA: f.shortNameA || null,
    shortNameB: f.shortNameB || null,
    event: f.event || null,
    measure: f.measure || null,
    high: f.high !== undefined ? Number(f.high) : null,
    low: f.low !== undefined ? Number(f.low) : null,
    stage: f.stage || null,
    contestType: f.contestType || null,
    season: f.season || null,
    startMs,
    expiryMs,
  };
}

const isSportsQuestion = (q) => typeof q.name === "string" && /^template:sports(ContestResult|TournamentWinner)/.test(q.name);
const NON_SPORT = /politic|econom|election|geopolit|law\b|government/i;
const SPORT = /baseball|basketball|soccer|football|\bf1\b|formula|hockey|tennis|golf|cricket|rugby|\bmma\b|boxing|\bufc\b|motorsport|racing|athletics|track|esport|dota|\bcs2\b|dodgeball/i;
const JUNK = /smoke|\btest\b|hypurr race|ancient war/i;
const isRealSport = (ev) =>
  !!ev.sport && SPORT.test(ev.sport) && !NON_SPORT.test(ev.sport) && !NON_SPORT.test(ev.competition) &&
  !JUNK.test([ev.competition, ev.officialSource, ev.participantA, ev.participantB].join("|"));
// Normalize common club suffixes so duplicate listings share an event identity.
const teamSlug = (s) => slug(s).replace(/(^|-)(fc|afc|cf|sc)(?=-|$)/g, "").replace(/^-|-$/g, "");
/** Shared identity for one fixture across deployers: writer `sameGameLeg` keys on it. */
export const eventKey = (ev) => `${teamSlug(ev.participantA)}-${teamSlug(ev.participantB)}-${yyyymmdd(ev.startMs)}`;
const isSportsWinner = (o) => typeof o.name === "string" && o.name.startsWith("template:sportsContestWinner");
const isSportsScalar = (o) => typeof o.name === "string" && o.name.startsWith("template:sportsScalarMarket");

function memberLabel(o) {
  if (typeof o.name === "string" && o.name.startsWith("template:sportsContestDraw")) return "Draw";
  const f = parseFields(o.description ?? "");
  return f.participant || o.name || `outcome ${o.outcome}`;
}

export function pickSports({
  outcomes,
  questions = [],
  mids,
  knownCoins,
  nowMs,
  cap = 30,
  perCompetition = 12,
  minMsLeft = 2 * 3600_000,
  // ponytail: allow season-long testnet events; exposure caps bound locked funds.
  maxMsLeft = 365 * 86400_000,
}) {
  const byId = new Map(outcomes.map((o) => [o.outcome, o]));
  const coinOf = (id) => `#${id * 10}`;
  const mid = (id) => mids[coinOf(id)];
  const inWindow = (ev) => ev.expiryMs - nowMs >= minMsLeft && ev.expiryMs - nowMs <= maxMsLeft;
  const events = []; // { key, competition, startMs, priced, legs: [candidate] }

  for (const q of questions) {
    if (!isSportsQuestion(q)) continue;
    const ev = parseSportsEvent(q.description);
    if (!ev || !isRealSport(ev) || !inWindow(ev)) continue;
    const members = (q.namedOutcomes ?? []).map((id) => byId.get(id)).filter(Boolean);
    // Wrap every named outcome so the question remains complete.
    if (members.length < 2 || members.length !== (q.namedOutcomes ?? []).length) continue;
    if (members.some((o) => o.quoteToken !== "USDC" || mid(o.outcome) === undefined || knownCoins.has(coinOf(o.outcome)))) continue;
    const priced = members.some((o) => Number(mid(o.outcome)) !== 0.5) ? 1 : 0;
    const isMatch = /^(match|game)$/i.test(ev.contestType ?? "") || members.length <= 3;
    const groupTitle = isMatch && ev.participantA && ev.participantB
      ? `${ev.participantA} vs ${ev.participantB}`
      : `${ev.competition}${ev.season ? ` ${ev.season}` : ""} winner`;
    const underlying = `q${q.question}`;
    events.push({
      key: underlying, competition: ev.competition, startMs: ev.startMs, priced,
      legs: members.map((o) => {
        const label = memberLabel(o);
        return {
          outcome: o.outcome, coinYes: coinOf(o.outcome), coinNo: `#${o.outcome * 10 + 1}`,
          question: q.question, group: underlying, groupTitle, title: label,
          sideYes: label, sideNo: `Not ${label}`, underlying, cluster: ev.competition,
          sport: ev.sport, startMs: ev.startMs, expiryMs: ev.expiryMs, priced: Number(mid(o.outcome)) !== 0.5 ? 1 : 0,
          ...(o.venue ? { deployer: o.venue } : {}),
        };
      }),
    });
  }

  for (const o of outcomes) {
    const winner = isSportsWinner(o);
    const scalar = isSportsScalar(o);
    if ((!winner && !scalar) || o.quoteToken !== "USDC" || o.sideSpecs?.length !== 2) continue;
    if (knownCoins.has(coinOf(o.outcome)) || mid(o.outcome) === undefined) continue;
    const ev = parseSportsEvent(o.description);
    if (!ev || !isRealSport(ev) || !inWindow(ev)) continue;
    const priced = Number(mid(o.outcome)) !== 0.5 ? 1 : 0;
    let leg;
    if (winner) {
      if (!ev.participantA || !ev.participantB) continue;
      const named = o.sideSpecs[0]?.name === "template:{shortNameA}";
      const key = eventKey(ev);
      leg = {
        title: named ? `${ev.participantA} vs ${ev.participantB}` : `${ev.participantA} beats ${ev.participantB}?`,
        sideYes: named ? ev.shortNameA || ev.participantA : "Yes",
        sideNo: named ? ev.shortNameB || ev.participantB : "No",
        underlying: key, groupTitle: `${ev.participantA} vs ${ev.participantB}`,
      };
    } else {
      if (!ev.event || !ev.measure || ev.high === null || ev.high !== ev.low || !Number.isFinite(ev.high)) continue;
      const key = `${slug(ev.event)}-${yyyymmdd(ev.startMs)}`;
      leg = { title: `${ev.measure} over ${ev.high}?`, sideYes: "Over", sideNo: "Under", underlying: key, groupTitle: ev.event };
    }
    events.push({
      key: leg.underlying, competition: ev.competition, startMs: ev.startMs, priced,
      legs: [{
        outcome: o.outcome, coinYes: coinOf(o.outcome), coinNo: `#${o.outcome * 10 + 1}`,
        question: null, group: null, ...leg, cluster: ev.competition, sport: ev.sport,
        startMs: ev.startMs, expiryMs: ev.expiryMs, priced,
        ...(o.venue ? { deployer: o.venue } : {}),
      }],
    });
  }

  events.sort((a, b) => b.priced - a.priced || a.startMs - b.startMs);
  const picked = [];
  const perComp = new Map();
  const seen = new Set();
  for (const ev of events) {
    if (seen.has(ev.key)) continue;
    const n = perComp.get(ev.competition) ?? 0;
    if (picked.length + ev.legs.length > cap || n + ev.legs.length > perCompetition) continue;
    seen.add(ev.key);
    perComp.set(ev.competition, n + ev.legs.length);
    picked.push(...ev.legs);
  }
  return picked;
}

export function sportsRegistryEntry(pick, vault) {
  const entry = {
    vault,
    title: pick.title,
    category: "sports",
    cluster: pick.cluster,
    coinYes: pick.coinYes,
    coinNo: pick.coinNo,
    underlying: pick.underlying,
    startMs: pick.startMs,
    expiryMs: pick.expiryMs,
    sideYes: pick.sideYes,
    sideNo: pick.sideNo,
    groupTitle: pick.groupTitle,
  };
  if (pick.question !== null && pick.question !== undefined) {
    entry.question = pick.question;
    entry.group = pick.group;
  }
  if (pick.sport) entry.sport = pick.sport;
  if (pick.deployer) entry.deployer = pick.deployer;
  return entry;
}

export function sportsMarketSymbol(pick) {
  return `S${pick.outcome}`;
}
