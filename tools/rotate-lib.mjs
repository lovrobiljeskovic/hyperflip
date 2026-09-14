function parseFields(description) {
  return Object.fromEntries(
    description.split("|").map((kv) => {
      const i = kv.indexOf(":");
      return i === -1 ? [kv, ""] : [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );
}

function parseStamp(stamp) {
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
      const key = `${teamSlug(ev.participantA)}-${teamSlug(ev.participantB)}-${yyyymmdd(ev.startMs)}`;
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
