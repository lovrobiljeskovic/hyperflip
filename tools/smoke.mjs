// Launch-day smoke: is the writer up, is the board live and priced, does a real
// 2-leg quote come back? One line out, exit 1 on any failure.
//   INVITE_CODE=OVR-XXXX node tools/smoke.mjs
// Env: WRITER_URL (default hosted writer), TAKER (any address), INVITE_CODE.
const WRITER = process.env.WRITER_URL ?? "https://writer.hyperflip.xyz";
const INFO = "https://api.hyperliquid-testnet.xyz/info";
const TAKER = process.env.TAKER ?? "0x1111111111111111111111111111111111111111";
const CODE = process.env.INVITE_CODE;
const now = Date.now();

const fail = (msg) => {
  console.log(`SMOKE FAIL: ${msg}`);
  process.exit(1);
};
const json = async (url, init) => {
  const r = await fetch(url, init).catch((e) => fail(`${url}: ${e.message}`));
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const health = (await json(`${WRITER}/health`)).body;
if (!health.ok || !health.seeded) fail(`health ${JSON.stringify(health).slice(0, 200)}`);

const m = (await json(`${WRITER}/markets`)).body;
const markets = Array.isArray(m) ? m : m.markets;
const live = markets.filter((x) => x.expiryMs > now);
if (live.length < 2) fail(`only ${live.length} live markets`);

const mids = (await json(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "allMids" }) })).body;
// Writer refuses a leg whose only price is an untraded 0.5 book (unpriced-leg).
const priced = live.filter((x) => mids[x.coinYes] !== undefined && Number(mids[x.coinYes]) !== 0.5);
if (priced.length < 2) fail(`${live.length} live but only ${priced.length} priced (allMids)`);

let quote = "skipped (no INVITE_CODE)";
if (CODE) {
  const maxStake = BigInt((await json(`${WRITER}/limits`)).body.maxStake ?? "1000000");
  const stake = maxStake < 1_000_000n ? maxStake : 1_000_000n;
  // Legs must come from different games (same-game is refused); try a few pairs.
  let last = "no pair tried";
  quote = null;
  for (const a of priced.slice(0, 6)) {
    const b = priced.find((x) => x.group !== a.group && x.underlying !== a.underlying);
    if (!b) continue;
    const legs = [a, b].map((x) => ({ vault: x.vault, isYes: true }));
    const r = await json(`${WRITER}/quote`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taker: TAKER, legs, stake: stake.toString(), inviteCode: CODE }) });
    if (r.status === 200 && r.body.quote) {
      const q = r.body.quote;
      quote = `${(Number(q.maxPayout) / Number(q.premium)).toFixed(2)}x on ${a.title} + ${b.title}`;
      break;
    }
    last = `${r.status} ${r.body.error ?? ""} (${a.title} + ${b.title})`;
  }
  if (!quote) fail(`no quote: last ${last}`);
}

console.log(`SMOKE OK: live ${live.length}/${markets.length}, priced ${priced.length}, open ${health.openParlays}, bankroll ${health.bankroll ?? "n/a"}, reserved ${health.reservedGlobal}, quote ${quote}`);
