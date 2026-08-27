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
