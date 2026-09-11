// Pure logic for market rotation — no I/O, tested by rotate-lib.test.mjs.

// Tokenized non-crypto perps are venue-prefixed (`perp:xyz:NVDA`). Only the
// `xyz` venue trades — `pew:` deployments are junk with dead 0.5 books.
const TRADED_VENUES = new Set(["xyz"]);

function parseFields(description) {
  return Object.fromEntries(
    description.split("|").map((kv) => {
      const i = kv.indexOf(":");
      return i === -1 ? [kv, ""] : [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );
}

/** `20260820-0200` (UTC) to epoch ms, or null. */
function parseStamp(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(stamp ?? "");
  return m === null ? null : Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

/** Parse a `template:binaryPrice*` description like
 * `perp:BTC|threshold:64200|time:20260820-0200` (time is UTC). binaryPrice2/4
 * carry extra fields (priceDescription, seconds); they are ignored.
 * Returns null on any shape mismatch. */
export function parseBinary(description) {
  const fields = parseFields(description);
  const { perp, threshold, time } = fields;
  if (!perp || !threshold || !time) return null;
  const parts = perp.split(":");
  if (parts.length > 2) return null;
  const [venue, symbol] = parts.length === 2 ? parts : [null, parts[0]];
  if (venue !== null && !TRADED_VENUES.has(venue)) return null;
  if (!symbol) return null;
  const expiryMs = parseStamp(time);
  if (expiryMs === null || !Number.isFinite(Number(threshold))) return null;
  return { perp: symbol, venue, threshold: Number(threshold), expiryMs };
}

/** Parse a `Recurring` (Crypto 1d tab) description like
 * `class:priceBinary|underlying:BTC|expiry:20260823-0300|targetPrice:78881|period:1d`.
 * Returns the same shape as parseBinary, or null on mismatch. */
export function parseRecurring(description) {
  const fields = parseFields(description);
  if (fields.class !== "priceBinary") return null;
  const { underlying, targetPrice, expiry } = fields;
  const expiryMs = parseStamp(expiry);
  if (!underlying || expiryMs === null || !Number.isFinite(Number(targetPrice))) return null;
  return { perp: underlying, venue: null, threshold: Number(targetPrice), expiryMs };
}

const COMMODITIES = new Set(["GOLD", "SILVER", "NATGAS", "CL", "OIL", "COPPER"]);

/** Category, correlation cluster, and board-diversity key for a parsed pick.
 *
 * `cluster` is a CORRELATION bloc and nothing else: the writer's copula treats
 * two legs sharing it as comoving, and `perClusterCap` pools their exposure.
 * Crypto used to get one cluster per perp, which made BTC and ETH look like
 * unrelated assets — they priced at correlation 0.09 instead of 0.918, a 59%
 * payout inflation on the most obvious parlay a user can build. One bloc per
 * thing that actually comoves: crypto, equity, commodity.
 *
 * `diversityKey` is a BOARD-COMPOSITION key and nothing else — it stops one
 * perp, or one bloc, filling every slot. It stays per-perp for crypto, which
 * is what `cluster` used to be doing here by accident. The two were one field
 * doing two jobs, and correctness for either meant breaking the other. */
export function classify({ perp, venue }) {
  if (venue === null) return { category: "crypto", cluster: "crypto", diversityKey: perp.toLowerCase() };
  return COMMODITIES.has(perp)
    ? { category: "commodity", cluster: "commodity", diversityKey: "commodity" }
    : { category: "equity", cluster: "equity", diversityKey: "equity" };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Every binary template, not just `template:binaryPrice` — binaryPrice2 and
 * binaryPrice4 differ only in settlement source and are the bulk of the live
 * board. Verified against outcomeMeta: all 72 carry sideSpecs [Yes, No]. */
const isBinary = (o) =>
  o.name?.startsWith("template:binaryPrice") &&
  o.sideSpecs?.length === 2 &&
  o.sideSpecs[0]?.name === "template:Yes" &&
  o.sideSpecs[1]?.name === "template:No";

/** The Crypto(1d) tab: house-deployed daily binaries, plain Yes/No sides. */
const isRecurring = (o) =>
  o.name === "Recurring" &&
  o.sideSpecs?.length === 2 &&
  o.sideSpecs[0]?.name === "Yes" &&
  o.sideSpecs[1]?.name === "No";

/** Recurring markets live exactly 24h, so the standard minMsLeft floor would
 * reject every one of them. 2h keeps us off nearly-expired boards only. */
const RECURRING_MIN_MS = 2 * 3600_000;

/** Pick fresh standalone binaries to wrap.
 * outcomes: outcomeMeta.outcomes; mids: allMids object; questions:
 * outcomeMeta.questions; knownCoins: Set of coinYes already in the registry. */
export function pickBinaries({
  outcomes,
  mids,
  questions = [],
  knownCoins,
  nowMs,
  cap = 8,
  perUnderlying = 2,
  perCluster = 3,
  minMsLeft = 24 * 3600_000,
  maxMsLeft = 14 * 86400_000,
}) {
  // An outcome inside a question is one leg of a mutually exclusive group and
  // must NOT be deployed with the standalone QUESTION_ID sentinel. None exist
  // today; this keeps a future one from settling against the wrong question.
  const grouped = new Set();
  for (const q of questions) {
    if (q.fallbackOutcome != null) grouped.add(q.fallbackOutcome);
    for (const o of q.namedOutcomes ?? []) grouped.add(o);
  }
  const candidates = [];
  for (const o of outcomes) {
    const recurring = isRecurring(o);
    if ((!isBinary(o) && !recurring) || o.quoteToken !== "USDC" || grouped.has(o.outcome)) continue;
    const parsed = recurring ? parseRecurring(o.description) : parseBinary(o.description);
    if (!parsed) continue;
    const msLeft = parsed.expiryMs - nowMs;
    if (msLeft < (recurring ? RECURRING_MIN_MS : minMsLeft) || msLeft > maxMsLeft) continue;
    const coinYes = `#${o.outcome * 10}`;
    if (knownCoins.has(coinYes)) continue;
    const mid = mids[coinYes];
    if (mid === undefined) continue; // no live book/mid — dead board entry
    // Junk deployments ("BTC above 100") are certainties wearing a 0.55 mid —
    // a free leg for the taker and a guaranteed loss for the house. Anchor the
    // strike to the underlying's own mid; xyz perps live under `xyz:SYM`.
    const spot = Number(mids[parsed.venue ? `${parsed.venue}:${parsed.perp}` : parsed.perp]);
    if (!Number.isFinite(spot) || spot <= 0) continue;
    const moneyness = parsed.threshold / spot - 1;
    // Near the money is the only place a testnet book's price is defensible
    // without a vol model: far strikes here sit at a stale 0.5 the taker can
    // pick off from whichever side is nearly certain.
    // ponytail: flat +/-25% band across all assets (was 10%; widened so the
    // testnet's own 1d strikes like HYPE 43 vs spot 54.8 stay on the board —
    // accepted house-loss risk on testnet). Upgrade path is the deferred
    // vol-based leg pricing, which would replace this with an
    // implied-probability sanity check.
    if (Math.abs(moneyness) > 0.25) continue;
    // A mid pinned at exactly 0.5 is an untraded book. Those resolve VOID when
    // the mark never leaves the strike (the ZEC incident), so they lose every
    // tie-break to a market that has actually printed a price.
    candidates.push({ outcome: o.outcome, coinYes, coinNo: `#${o.outcome * 10 + 1}`, priced: Number(mid) === 0.5 ? 0 : 1, ...parsed });
  }
  // Priced markets first, then nearest expiry; round-robin across underlyings
  // and cap per diversity key so one perp — or one correlated bloc — can't fill
  // the board. Deliberately NOT the correlation cluster: pooling all of crypto
  // into one bloc is right for pricing and wrong here, where it would cut the
  // board from eight crypto markets to three.
  candidates.sort((a, b) => b.priced - a.priced || a.expiryMs - b.expiryMs);
  const byPerp = new Map();
  for (const c of candidates) {
    if (!byPerp.has(c.perp)) byPerp.set(c.perp, []);
    byPerp.get(c.perp).push(c);
  }
  const picked = [];
  const clusterCount = new Map();
  for (let round = 0; round < perUnderlying && picked.length < cap; round++) {
    for (const list of byPerp.values()) {
      if (picked.length >= cap) break;
      const c = list[round];
      if (!c) continue;
      const { diversityKey } = classify(c);
      const n = clusterCount.get(diversityKey) ?? 0;
      if (n >= perCluster) continue;
      clusterCount.set(diversityKey, n + 1);
      picked.push(c);
    }
  }
  return picked;
}

/** Keep picks to source-registry mappings and refuse a new active set over cap. */
export function filterMappedPicks(picks, registry, activeUnderlyings, max = 20) {
  const mapped = new Set(registry.sources.map((source) => source.underlying));
  const filtered = picks.filter((pick) => mapped.has(pick.perp));
  const active = new Set(activeUnderlyings);
  for (const pick of filtered) active.add(pick.perp);
  if (active.size > max) throw new Error(`at most ${max} active underlyings are allowed`);
  return filtered;
}

/** Keep rotation from rewriting a testnet registry as an unbound market list. */
export function rotatedRegistry(registry, markets, archived) {
  if (registry.network !== "testnet") throw new Error("market registry network must be testnet");
  return { network: registry.network, markets, archived };
}

/** Registry entry in the exact shape registry/markets.json uses.
 * Must satisfy writer/src/config.ts parseMarkets — it hard-fails on a missing
 * field, and the writer is the only consumer that validates the shape. */
export function registryEntry(pick, vault) {
  const d = new Date(pick.expiryMs);
  const title = `${pick.perp} above ${pick.threshold} on ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}?`;
  // diversityKey is picker-only — it governs board composition and means
  // nothing to the writer, the keeper or the frontend, and GET /markets serves
  // this object verbatim. Keep it out of the registry schema.
  const { diversityKey: _diversityKey, ...classification } = classify(pick);
  return {
    vault,
    title,
    ...classification,
    coinYes: pick.coinYes,
    coinNo: pick.coinNo,
    underlying: pick.perp,
    // parseBinary only accepts the above-threshold template, so YES is always "up".
    direction: "up",
    expiryMs: pick.expiryMs,
  };
}

/** oYES/oNO symbol suffix, e.g. BTC0820. */
export function marketSymbol(pick) {
  const d = new Date(pick.expiryMs);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${pick.perp}${mm}${dd}`;
}

// ---------------------------------------------------------------------------
// Sports (ROTATE_MODE=sports). HIP-4 sports come in two shapes:
//   - a `template:sportsContestResult*` / `template:sportsTournamentWinner*`
//     QUESTION whose named outcomes are the participants (+ Draw), all
//     mutually exclusive; the question description carries the fixture.
//   - a standalone `template:sportsContestWinner*` (sides = the two
//     participants, or Yes/No) or `template:sportsScalarMarket*` (Over/Under)
//     OUTCOME whose own description carries the fixture.
// Every outcome is still a Yes/No pair on Core, so one OutcomeVault per
// outcome; a question is wrapped whole or not at all so the UI card is
// complete and the writer can refuse two legs of it (`same-game`).

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const yyyymmdd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");

/** Fixture fields shared by sports templates. Null unless both timestamps
 * parse — a market without a kickoff has no lockout and is not quotable. */
export function parseSportsEvent(description) {
  const f = parseFields(description ?? "");
  const startMs = parseStamp(f.scheduledStart);
  const expiryMs = parseStamp(f.resolutionDeadline);
  if (startMs === null || expiryMs === null || expiryMs < startMs) return null;
  // Scalar props name the fixture as `event:A vs B (MLB)` — the parenthetical
  // is the competition, which is the writer's cluster.
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
// Testnet deployers file politics and macro under the sports templates
// (`sport:politics`, "Yes beats No?"). Sports-only beta: drop those.
const NON_SPORT = /politic|econom|election|geopolit|law\b|government/i;
// Testnet deployers file smoke tests, block-stacking, earthquakes and cooking
// under the sports templates; with untraded books now wrapped, the 0.5 pin no
// longer weeds them, so `sport` must name a real one.
const SPORT = /baseball|basketball|soccer|football|\bf1\b|formula|hockey|tennis|golf|cricket|rugby|\bmma\b|boxing|\bufc\b|motorsport|racing|athletics|track|esport|dota|\bcs2\b|dodgeball/i;
// Hypurr Race (Hypurr v Usain Bolt) and Ancient War (Radiant v Dire, season 1523rd)
// pass the sport whitelist (track, esport) but are deployer fiction.
const JUNK = /smoke|\btest\b|hypurr race|ancient war/i;
const isRealSport = (ev) =>
  !!ev.sport && SPORT.test(ev.sport) && !NON_SPORT.test(ev.sport) && !NON_SPORT.test(ev.competition) &&
  !JUNK.test([ev.competition, ev.officialSource, ev.participantA, ev.participantB].join("|"));
// Two deployers list the same match as "Arsenal FC" and "Arsenal"; the key must
// collide so the board carries one vault per fixture and the writer's
// same-`underlying` refusal catches a parlay of the twins.
const teamSlug = (s) => slug(s).replace(/(^|-)(fc|afc|cf|sc)(?=-|$)/g, "").replace(/^-|-$/g, "");
const isSportsWinner = (o) => typeof o.name === "string" && o.name.startsWith("template:sportsContestWinner");
const isSportsScalar = (o) => typeof o.name === "string" && o.name.startsWith("template:sportsScalarMarket");

/** Label for one named outcome of a sports question. */
function memberLabel(o) {
  if (typeof o.name === "string" && o.name.startsWith("template:sportsContestDraw")) return "Draw";
  const f = parseFields(o.description ?? "");
  return f.participant || o.name || `outcome ${o.outcome}`;
}

/** Pick sports events to wrap. Returns one candidate per OUTCOME, question
 * members grouped under `group`. `cap` bounds vaults per rotation (each is a
 * big-block deploy); a question only fits if all of it fits. */
export function pickSports({
  outcomes,
  questions = [],
  mids,
  knownCoins,
  nowMs,
  cap = 30,
  perCompetition = 12,
  minMsLeft = 2 * 3600_000,
  // ponytail: a year, not the crypto board's 14 days — on today's testnet the
  // only sports books that have traded are season-long tournaments (UCL,
  // Super Bowl); every near-term fixture sits at 0.5. Tighten once real
  // deployers list priced weekly games; PER_CLUSTER_CAP bounds the long-dated
  // escrow meanwhile.
  maxMsLeft = 365 * 86400_000,
}) {
  const byId = new Map(outcomes.map((o) => [o.outcome, o]));
  const coinOf = (id) => `#${id * 10}`;
  const mid = (id) => mids[coinOf(id)];
  // Gate on the resolution deadline, not kickoff: an in-play fixture is still
  // quotable (the writer locks at expiryMs too).
  const inWindow = (ev) => ev.expiryMs - nowMs >= minMsLeft && ev.expiryMs - nowMs <= maxMsLeft;
  const events = []; // { key, competition, startMs, priced, legs: [candidate] }

  for (const q of questions) {
    if (!isSportsQuestion(q)) continue;
    const ev = parseSportsEvent(q.description);
    if (!ev || !isRealSport(ev) || !inWindow(ev)) continue;
    const members = (q.namedOutcomes ?? []).map((id) => byId.get(id)).filter(Boolean);
    if (members.length < 2 || members.length !== (q.namedOutcomes ?? []).length) continue;
    if (members.some((o) => o.quoteToken !== "USDC" || mid(o.outcome) === undefined || knownCoins.has(coinOf(o.outcome)))) continue;
    // Every leg at 0.5 = never traded. Wrapped anyway so the board lists it;
    // the writer refuses to quote a 0.5-pinned empty book (unpriced-leg) until
    // Core prints a price, so an untraded question costs deploy gas, not edge.
    const priced = members.some((o) => Number(mid(o.outcome)) !== 0.5) ? 1 : 0;
    // A match is "A vs B"; a season/tournament question lists its favourites
    // as participantA/B, which would mislabel a 9-way winner market.
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
      // Sides are either the two participants (`template:{shortNameA}`) or a
      // plain Yes/No on "participantA wins".
      const named = o.sideSpecs[0]?.name === "template:{shortNameA}";
      const key = `${teamSlug(ev.participantA)}-${teamSlug(ev.participantB)}-${yyyymmdd(ev.startMs)}`;
      leg = {
        title: named ? `${ev.participantA} vs ${ev.participantB}` : `${ev.participantA} beats ${ev.participantB}?`,
        sideYes: named ? ev.shortNameA || ev.participantA : "Yes",
        sideNo: named ? ev.shortNameB || ev.participantB : "No",
        underlying: key, groupTitle: `${ev.participantA} vs ${ev.participantB}`,
      };
    } else {
      // Only a single line (high == low) is a clean Over/Under; a band has no
      // two-sided reading a taker can price.
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

  // Traded books first, then soonest kickoff, so untraded ones only take cap
  // room left over; a competition (= writer cluster, = PER_CLUSTER_CAP pool)
  // cannot fill the board; a question that does not fit whole is skipped.
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

/** Registry row for a sports pick — the writer's parseMarkets shape plus the
 * optional sports fields (question, startMs, side labels, group). */
export function sportsRegistryEntry(pick, vault) {
  const entry = {
    vault,
    title: pick.title,
    category: "sports",
    cluster: pick.cluster,
    coinYes: pick.coinYes,
    coinNo: pick.coinNo,
    underlying: pick.underlying,
    direction: "up",
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
  // outcomeMeta's per-outcome `venue` is the HIP-4 deployer's name; the UI
  // shows it so a taker can tell whose market a leg is.
  if (pick.deployer) entry.deployer = pick.deployer;
  return entry;
}

/** oYES/oNO symbol suffix for a sports vault: the outcome id is the only
 * short, unique, ASCII-safe handle a fixture has. */
export function sportsMarketSymbol(pick) {
  return `S${pick.outcome}`;
}
