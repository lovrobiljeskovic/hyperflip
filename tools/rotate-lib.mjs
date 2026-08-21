// Pure logic for market rotation — no I/O, tested by rotate-lib.test.mjs.

// Tokenized non-crypto perps are venue-prefixed (`perp:xyz:NVDA`). Only the
// `xyz` venue trades — `pew:` deployments are junk with dead 0.5 books.
const TRADED_VENUES = new Set(["xyz"]);

/** Parse a `template:binaryPrice*` description like
 * `perp:BTC|threshold:64200|time:20260820-0200` (time is UTC). binaryPrice2/4
 * carry extra fields (priceDescription, seconds); they are ignored.
 * Returns null on any shape mismatch. */
export function parseBinary(description) {
  const fields = Object.fromEntries(
    description.split("|").map((kv) => {
      const i = kv.indexOf(":");
      return i === -1 ? [kv, ""] : [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );
  const { perp, threshold, time } = fields;
  if (!perp || !threshold || !time) return null;
  const parts = perp.split(":");
  if (parts.length > 2) return null;
  const [venue, symbol] = parts.length === 2 ? parts : [null, parts[0]];
  if (venue !== null && !TRADED_VENUES.has(venue)) return null;
  if (!symbol) return null;
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(time);
  if (m === null || !Number.isFinite(Number(threshold))) return null;
  const expiryMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return { perp: symbol, venue, threshold: Number(threshold), expiryMs };
}

const COMMODITIES = new Set(["GOLD", "SILVER", "NATGAS", "CL", "OIL", "COPPER"]);

/** Category + correlation cluster for a parsed pick. Equities and commodities
 * co-move inside their bloc, so each is ONE cluster — the writer charges
 * CLUSTER_EDGE_BPS on any pair drawn from it, which is what NVDA x TSLA needs. */
export function classify({ perp, venue }) {
  if (venue === null) return { category: "crypto", cluster: perp.toLowerCase() };
  return COMMODITIES.has(perp)
    ? { category: "commodity", cluster: "commodity" }
    : { category: "equity", cluster: "equity" };
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
    if (!isBinary(o) || o.quoteToken !== "USDC" || grouped.has(o.outcome)) continue;
    const parsed = parseBinary(o.description);
    if (!parsed) continue;
    const msLeft = parsed.expiryMs - nowMs;
    if (msLeft < minMsLeft || msLeft > maxMsLeft) continue;
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
    // ponytail: flat +/-10% band across all assets — gold moves nothing like
    // HYPE. Upgrade path is the deferred vol-based leg pricing, which would
    // replace this with an implied-probability sanity check.
    if (Math.abs(moneyness) > 0.10) continue;
    // A mid pinned at exactly 0.5 is an untraded book. Those resolve VOID when
    // the mark never leaves the strike (the ZEC incident), so they lose every
    // tie-break to a market that has actually printed a price.
    candidates.push({ outcome: o.outcome, coinYes, coinNo: `#${o.outcome * 10 + 1}`, priced: Number(mid) === 0.5 ? 0 : 1, ...parsed });
  }
  // Priced markets first, then nearest expiry; round-robin across underlyings
  // and cap per cluster so one perp — or one correlated bloc — can't fill the board.
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
      const { cluster } = classify(c);
      const n = clusterCount.get(cluster) ?? 0;
      if (n >= perCluster) continue;
      clusterCount.set(cluster, n + 1);
      picked.push(c);
    }
  }
  return picked;
}

/** Registry entry in the exact shape registry/markets.json uses.
 * Must satisfy writer/src/config.ts parseMarkets — it hard-fails on a missing
 * field, and the writer is the only consumer that validates the shape. */
export function registryEntry(pick, vault) {
  const d = new Date(pick.expiryMs);
  const title = `${pick.perp} above ${pick.threshold} on ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}?`;
  return {
    vault,
    title,
    ...classify(pick),
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
