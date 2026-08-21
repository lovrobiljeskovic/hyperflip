// Pure logic for market rotation — no I/O, tested by rotate-lib.test.mjs.

/** Parse a `template:binaryPrice` description like
 * `perp:BTC|threshold:64200|time:20260820-0200` (time is UTC).
 * Returns null on any shape mismatch, including venue-prefixed perps
 * (`perp:xyz:NVDA`) which are tokenized stocks, not crypto. */
export function parseBinary(description) {
  const fields = Object.fromEntries(
    description.split("|").map((kv) => {
      const i = kv.indexOf(":");
      return i === -1 ? [kv, ""] : [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );
  const { perp, threshold, time } = fields;
  if (!perp || perp.includes(":") || !threshold || !time) return null;
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(time);
  if (m === null || !Number.isFinite(Number(threshold))) return null;
  const expiryMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return { perp, threshold: Number(threshold), expiryMs };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Pick fresh standalone crypto binaries to wrap.
 * outcomes: outcomeMeta.outcomes; mids: allMids object;
 * knownCoins: Set of coinYes strings already in the registry. */
// maxMsLeft keeps the board on near-dated dailies — far-dated testnet
// binaries are mostly junk deployments with dead 0.5 mids.
export function pickBinaries({ outcomes, mids, knownCoins, nowMs, cap = 8, perUnderlying = 2, minMsLeft = 2 * 3600_000, maxMsLeft = 4 * 86400_000 }) {
  const candidates = [];
  for (const o of outcomes) {
    if (o.name !== "template:binaryPrice" || o.quoteToken !== "USDC") continue;
    const parsed = parseBinary(o.description);
    if (!parsed) continue;
    const msLeft = parsed.expiryMs - nowMs;
    if (msLeft < minMsLeft || msLeft > maxMsLeft) continue;
    const coinYes = `#${o.outcome * 10}`;
    if (knownCoins.has(coinYes)) continue;
    if (mids[coinYes] === undefined) continue; // no live book/mid — dead board entry
    candidates.push({ outcome: o.outcome, coinYes, coinNo: `#${o.outcome * 10 + 1}`, ...parsed });
  }
  // Nearest expiry first within each underlying; round-robin across
  // underlyings so one busy perp can't fill the whole board.
  candidates.sort((a, b) => a.expiryMs - b.expiryMs);
  const byPerp = new Map();
  for (const c of candidates) {
    if (!byPerp.has(c.perp)) byPerp.set(c.perp, []);
    byPerp.get(c.perp).push(c);
  }
  const picked = [];
  for (let round = 0; round < perUnderlying && picked.length < cap; round++) {
    for (const list of byPerp.values()) {
      if (picked.length >= cap) break;
      if (list[round]) picked.push(list[round]);
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
    category: "crypto",
    coinYes: pick.coinYes,
    coinNo: pick.coinNo,
    underlying: pick.perp,
    cluster: pick.perp.toLowerCase(),
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
