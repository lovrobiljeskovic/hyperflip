// Mainnet NFL depth sampler (D41): read-only `outcomeMeta` + `l2Book` on the mainnet info API,
// one JSONL row per outcome coin per run. No signer, no writes. Decides whether the mainnet
// book can be a prior source (D41 gate: median spread under ~3c, top-of-book a few hundred USDC).
//   node tools/depth-sampler.mjs sample   # append one sweep to DEPTH_SAMPLES (default depth-samples.jsonl)
//   node tools/depth-sampler.mjs report   # medians over the file, pre-kickoff vs in-play
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAINNET_INFO_URL = "https://api.hyperliquid.xyz/info";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const field = (desc, key) => new RegExp(`(?:^|\\|)${key}:([^|]*)`).exec(desc ?? "")?.[1];
const stampMs = (s) => {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(s ?? "");
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
};

/** NFL game-winner outcomes → the two coins each (`#<id*10>` = side A, `+1` = side B). */
export function nflCoins(outcomes) {
  return outcomes
    .filter((o) => o.name?.startsWith("template:sportsContestWinner") && field(o.description, "competition") === "NFL")
    .flatMap((o) => {
      const game = `${field(o.description, "shortNameA")}-${field(o.description, "shortNameB")}`;
      const startMs = stampMs(field(o.description, "scheduledStart"));
      return [
        { coin: `#${o.outcome * 10}`, outcome: o.outcome, venue: o.venue, game, side: field(o.description, "shortNameA"), startMs },
        { coin: `#${o.outcome * 10 + 1}`, outcome: o.outcome, venue: o.venue, game, side: field(o.description, "shortNameB"), startMs },
      ];
    });
}

const usdc = (levels) => levels.reduce((s, l) => s + Number(l.px) * Number(l.sz), 0);

/** Top-of-book stats from an l2Book payload. Sizes are outcome tokens (1 USDC at par), so
 * px*sz is USDC notional. Nulls on an empty side. */
export function bookStats(book) {
  const [bids = [], asks = []] = book?.levels ?? [];
  const bid = bids[0] ? Number(bids[0].px) : null;
  const ask = asks[0] ? Number(asks[0].px) : null;
  return {
    bid,
    ask,
    spread: bid !== null && ask !== null ? +(ask - bid).toFixed(5) : null,
    bidTop1Usdc: +usdc(bids.slice(0, 1)).toFixed(2),
    bidTop3Usdc: +usdc(bids.slice(0, 3)).toFixed(2),
    askTop1Usdc: +usdc(asks.slice(0, 1)).toFixed(2),
    askTop3Usdc: +usdc(asks.slice(0, 3)).toFixed(2),
  };
}

const median = (xs) => {
  const s = xs.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

/** D41 gate numbers, split by whether the sample was taken before kickoff. */
export function summarize(rows) {
  const bucket = (rs) => ({
    samples: rs.length,
    emptyBooks: rs.filter((r) => r.ask === null || r.bid === null).length,
    medianSpread: median(rs.map((r) => r.spread)),
    medianAskTop1Usdc: median(rs.map((r) => r.askTop1Usdc)),
    medianAskTop3Usdc: median(rs.map((r) => r.askTop3Usdc)),
    medianBidTop1Usdc: median(rs.map((r) => r.bidTop1Usdc)),
  });
  const pre = rows.filter((r) => r.startMs === null || r.ts < r.startMs);
  return { preKickoff: bucket(pre), inPlay: bucket(rows.filter((r) => !pre.includes(r))), games: new Set(rows.map((r) => r.game)).size };
}

async function info(body) {
  const res = await fetch(MAINNET_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`info ${body.type}: HTTP ${res.status}`);
  return res.json();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.env.DEPTH_SAMPLES ?? path.join(ROOT, "depth-samples.jsonl");
  const cmd = process.argv[2];
  if (cmd === "sample") {
    const ts = Date.now();
    const coins = nflCoins((await info({ type: "outcomeMeta" })).outcomes);
    let lines = "";
    for (const c of coins) {
      // ponytail: sequential ~70 calls/run; batch if the info API starts rate-limiting
      try {
        lines += JSON.stringify({ ts, ...c, ...bookStats(await info({ type: "l2Book", coin: c.coin })) }) + "\n";
      } catch (err) {
        console.error(`${c.coin} ${c.game}: ${err.message}`);
      }
    }
    appendFileSync(file, lines);
    console.log(`sampled ${lines.split("\n").length - 1}/${coins.length} coins → ${file}`);
  } else if (cmd === "report") {
    const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    console.log(JSON.stringify(summarize(rows), null, 2));
  } else {
    console.error("usage: node tools/depth-sampler.mjs sample|report");
    process.exit(2);
  }
}
