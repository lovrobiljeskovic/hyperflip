import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RfqBody } from "../src/maker.js";
import { handleIntent, handleWaitlist, newRelayMetrics, pickBest, startRelay, type RelayConfig, type RelayDeps, type RfqRecord } from "../src/relay.js";
import { signQuote, type ParlayQuote } from "../src/quotes.js";
import { RateLimiter, Waitlist } from "../src/waitlist.js";

const V1 = "0x1111111111111111111111111111111111111111" as Address;
const V2 = "0x2222222222222222222222222222222222222222" as Address;
const TAKER = "0x3333333333333333333333333333333333333333" as Address;
const MAKER_A = "0xaaaa000000000000000000000000000000000001" as Address;
const MAKER_B = "0xbbbb000000000000000000000000000000000002" as Address;
const KEY_A = `0x${"11".repeat(32)}` as Hex;
const KEY_B = `0x${"22".repeat(32)}` as Hex;
const SIGNER: Record<string, Address> = {
  [MAKER_A.toLowerCase()]: privateKeyToAccount(KEY_A).address,
  [MAKER_B.toLowerCase()]: privateKeyToAccount(KEY_B).address,
};
const NOW = 1_000_000;
const file = () => path.join(mkdtempSync(path.join(tmpdir(), "relay-")), "waitlist.json");

function cfg(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    chainId: 998, rpcUrl: "", parlayVault: V1, deployBlock: 0n, port: 0,
    makers: [{ maker: MAKER_A, url: "http://a" }, { maker: MAKER_B, url: "http://b" }],
    makerToken: "t", rfqWindowMs: 50, rfqMinTtlMs: 8000, rfqJournalFile: "/dev/null",
    maxStake: 10_000_000n, minLegs: 2, lockoutMs: 600_000, minPremiumBps: 100n,
    markets: new Map([
      [V1.toLowerCase(), { vault: V1, coinYes: "+10", coinNo: "+11", underlying: "game-1", cluster: "sports", title: "Twins vs Orioles", category: "sports" }],
      [V2.toLowerCase(), { vault: V2, coinYes: "+20", coinNo: "+21", expiryMs: 2_000_000, underlying: "game-2", cluster: "sports", title: "Arsenal vs Chelsea", category: "sports" }],
    ]),
    registryJson: "{}",
    inviteCodes: new Set(["beta-test"]),
    corsOrigins: ["https://overround.xyz"],
    waitlistFile: "/dev/null",
    ...overrides,
  };
}

const goodBody = { taker: TAKER, legs: [{ vault: V1, isYes: true }, { vault: V2, isYes: false }], stake: "1000000", inviteCode: "beta-test" };

type Reply = { status: number; json: unknown } | ((body: RfqBody, signal: AbortSignal) => Promise<{ status: number; json: unknown }>);
type Deps = RelayDeps & { journal: RfqRecord[] };

function deps(replies: Record<string, Reply>, overrides: Partial<RelayDeps> = {}): Deps {
  const journal: RfqRecord[] = [];
  return {
    cfg: cfg(),
    askMaker: async (m, body, signal) => {
      const r = replies[m.maker];
      if (!r) throw new Error("no such maker");
      return typeof r === "function" ? r(body, signal) : r;
    },
    makerHealth: async () => ({ ok: true, seeded: true, bankroll: "1", perMarket: { secret: "1" } }),
    signerOf: (maker) => SIGNER[maker.toLowerCase()],
    now: () => NOW,
    randomId: () => `0x${"ab".repeat(32)}` as Hex,
    recordRfq: async (r) => void journal.push(r),
    metrics: newRelayMetrics(),
    journal,
    ...overrides,
  };
}

/** A real EIP-712 quote from `maker`, signed by `key` so bad-sig is a genuine recovery failure. */
async function quoteFrom(maker: Address, key: Hex, over: Partial<ParlayQuote> = {}, c = cfg()): Promise<{ status: number; json: unknown }> {
  const quote: ParlayQuote = {
    taker: TAKER, maker, legs: goodBody.legs, premium: 1_000_000n, maxPayout: 4_000_000n,
    deadline: BigInt(Math.floor((NOW + 15_000) / 1000)), quoteId: `0x${maker.slice(-2).repeat(32)}` as Hex, ...over,
  };
  const sig = await signQuote(key, c.chainId, c.parlayVault, quote);
  return {
    status: 200,
    json: {
      quote: { ...quote, premium: quote.premium.toString(), maxPayout: quote.maxPayout.toString(), deadline: quote.deadline.toString() },
      sig,
      breakdown: { jointProbWad: "250000000000000000" },
    },
  };
}

type Quoted = { quote: { maker: Address; maxPayout: string; quoteId: Hex }; sig: string; breakdown: unknown; makers: { asked: number; quoted: number } };

test("pickBest: max payout wins, ties go to the lowest address", () => {
  assert.equal(pickBest([{ maker: MAKER_B, maxPayout: 5n }, { maker: MAKER_A, maxPayout: 4n }]), 0);
  assert.equal(pickBest([{ maker: MAKER_B, maxPayout: 5n }, { maker: MAKER_A, maxPayout: 5n }]), 1);
  assert.equal(pickBest([{ maker: MAKER_A, maxPayout: 1n }]), 0);
});

test("two valid quotes: the higher maxPayout wins, both journaled with latency", async () => {
  const d = deps({ [MAKER_A]: await quoteFrom(MAKER_A, KEY_A), [MAKER_B]: await quoteFrom(MAKER_B, KEY_B, { maxPayout: 5_000_000n }) });
  const r = await handleIntent(d, goodBody);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const j = r.json as Quoted;
  assert.equal(j.quote.maker, MAKER_B);
  assert.equal(j.quote.maxPayout, "5000000");
  assert.deepEqual(j.makers, { asked: 2, quoted: 2 });
  assert.equal(JSON.stringify(r.json).includes(MAKER_A), false); // losers never leak
  assert.equal(d.metrics.quoted, 1);
  assert.equal(d.metrics.makers[MAKER_A].quoted, 1);
  assert.equal(d.journal.length, 1);
  const rec = d.journal[0];
  assert.equal(rec.result, "quoted");
  assert.deepEqual(rec.winner, { maker: MAKER_B, quoteId: j.quote.quoteId });
  assert.deepEqual(rec.responses.map((x) => [x.maker, x.outcome]), [[MAKER_A, "lost"], [MAKER_B, "won"]]);
  for (const x of rec.responses) assert.equal(typeof x.latencyMs, "number");
  assert.equal(rec.responses[0].maxPayout, "4000000");
  assert.equal(rec.quotaKey.length, 66);
  assert.equal(JSON.stringify(rec).includes("beta-test"), false); // makers and journal see the hash, not the code
});

test("equal maxPayout: lowest address wins", async () => {
  const d = deps({ [MAKER_A]: await quoteFrom(MAKER_A, KEY_A), [MAKER_B]: await quoteFrom(MAKER_B, KEY_B) });
  const r = await handleIntent(d, goodBody);
  assert.equal((r.json as Quoted).quote.maker, MAKER_A);
});

async function invalidCase(replies: Record<string, Reply>, bad: Address, reason: string, winner: Address) {
  const d = deps(replies);
  const r = await handleIntent(d, goodBody);
  assert.equal(r.status, 200, `${reason}: ${JSON.stringify(r.json)}`);
  assert.equal((r.json as Quoted).quote.maker, winner, reason);
  assert.deepEqual((r.json as Quoted).makers, { asked: 2, quoted: 1 }, reason);
  const resp = d.journal[0].responses.find((x) => x.maker === bad)!;
  assert.deepEqual([resp.outcome, resp.reason], ["invalid", reason]);
  assert.equal(d.metrics.makers[bad].invalid, 1, reason);
}

test("filters: each reason journals invalid and the other maker still wins", async () => {
  const B = await quoteFrom(MAKER_B, KEY_B);
  await invalidCase({ [MAKER_A]: { status: 200, json: { quote: "nope" } }, [MAKER_B]: B }, MAKER_A, "bad-shape", MAKER_B);
  await invalidCase({ [MAKER_A]: await quoteFrom(MAKER_A, KEY_B), [MAKER_B]: B }, MAKER_A, "bad-sig", MAKER_B);
  await invalidCase({ [MAKER_A]: await quoteFrom(MAKER_A, KEY_A, { maker: MAKER_B }), [MAKER_B]: B }, MAKER_A, "wrong-maker", MAKER_B);
  await invalidCase({ [MAKER_A]: await quoteFrom(MAKER_A, KEY_A, { legs: [...goodBody.legs].reverse() }), [MAKER_B]: B }, MAKER_A, "mismatch", MAKER_B);
  await invalidCase({ [MAKER_A]: await quoteFrom(MAKER_A, KEY_A, { premium: 999_999n }), [MAKER_B]: B }, MAKER_A, "mismatch", MAKER_B);
  await invalidCase({ [MAKER_A]: await quoteFrom(MAKER_A, KEY_A, { deadline: BigInt(Math.floor((NOW + 5_000) / 1000)) }), [MAKER_B]: B }, MAKER_A, "short-ttl", MAKER_B);
  await invalidCase({ [MAKER_A]: await quoteFrom(MAKER_A, KEY_A, { maxPayout: 1_000_000n }), [MAKER_B]: B }, MAKER_A, "bad-premium", MAKER_B);
  await invalidCase({ [MAKER_A]: await quoteFrom(MAKER_A, KEY_A, { maxPayout: 200_000_000n }), [MAKER_B]: B }, MAKER_A, "bad-premium", MAKER_B);
  // B answers second, so a shared quoteId lands on B.
  await invalidCase({ [MAKER_A]: await quoteFrom(MAKER_A, KEY_A), [MAKER_B]: await quoteFrom(MAKER_B, KEY_B, { quoteId: `0x${"01".repeat(32)}` }) }, MAKER_B, "dup-quote-id", MAKER_A);
});

test("unanimous at-capacity forwards the reason with the most generous maxStake", async () => {
  const d = deps({
    [MAKER_A]: { status: 409, json: { error: "at-capacity", maxStake: "5" } },
    [MAKER_B]: { status: 409, json: { error: "at-capacity", maxStake: "7" } },
  });
  assert.deepEqual(await handleIntent(d, goodBody), { status: 409, json: { error: "at-capacity", maxStake: "7" } });
  assert.equal(d.metrics.rejected["at-capacity"], 1);
  assert.equal(d.journal[0].result, "at-capacity");
  assert.deepEqual(d.journal[0].responses.map((x) => [x.outcome, x.reason]), [["rejected", "at-capacity"], ["rejected", "at-capacity"]]);
});

test("disagreeing refusals collapse to no-quotes", async () => {
  const d = deps({
    [MAKER_A]: { status: 409, json: { error: "at-capacity", maxStake: "5" } },
    [MAKER_B]: { status: 503, json: { error: "stale-book" } },
  });
  assert.deepEqual(await handleIntent(d, goodBody), { status: 503, json: { error: "no-quotes", asked: 2, answered: 2 } });
  assert.equal(d.metrics.noQuotes, 1);
  assert.equal(d.journal[0].result, "no-quotes");
});

test("a throwing maker is unreachable; the other still wins", async () => {
  const d = deps({ [MAKER_A]: async () => { throw new Error("ECONNREFUSED"); }, [MAKER_B]: await quoteFrom(MAKER_B, KEY_B) });
  const r = await handleIntent(d, goodBody);
  assert.equal(r.status, 200);
  assert.deepEqual((r.json as Quoted).makers, { asked: 2, quoted: 1 });
  assert.equal(d.metrics.makers[MAKER_A].unreachable, 1);
  assert.equal(d.journal[0].responses[0].outcome, "unreachable");
});

test("a maker slower than the window is cut off; the answer does not wait for it", async () => {
  const late = await quoteFrom(MAKER_A, KEY_A, { maxPayout: 9_000_000n });
  const d = deps({
    [MAKER_A]: (_body, signal) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason));
      setTimeout(() => resolve(late), 500); // ref'd: AbortSignal.timeout alone would not keep the loop alive
    }),
    [MAKER_B]: await quoteFrom(MAKER_B, KEY_B),
  });
  const t0 = Date.now();
  const r = await handleIntent(d, goodBody);
  assert.ok(Date.now() - t0 < 400);
  assert.equal((r.json as Quoted).quote.maker, MAKER_B);
  assert.equal(d.journal[0].responses[0].outcome, "unreachable");
});

test("nobody answers: no-quotes with answered 0", async () => {
  const d = deps({});
  assert.deepEqual(await handleIntent(d, goodBody), { status: 503, json: { error: "no-quotes", asked: 2, answered: 0 } });
});

test("journal failure: 503 and no signature leaves", async () => {
  const d = deps({ [MAKER_A]: await quoteFrom(MAKER_A, KEY_A) }, { recordRfq: async () => { throw new Error("disk full"); } });
  const r = await handleIntent(d, goodBody);
  assert.deepEqual(r, { status: 503, json: { error: "journal-failed" } });
  assert.equal(d.metrics.quoted, 0);
});

test("intent validation runs before fan-out", async () => {
  let asked = 0;
  const d = deps({ [MAKER_A]: async () => { asked++; return { status: 200, json: {} }; } });
  assert.deepEqual(await handleIntent(d, { ...goodBody, stake: "0" }), { status: 400, json: { error: "bad-stake" } });
  assert.equal(asked, 0);
  assert.equal(d.metrics.rejected["bad-stake"], 1);
});

test("quote without invite code is 403", async () => {
  const d = deps({ [MAKER_A]: await quoteFrom(MAKER_A, KEY_A) });
  const { inviteCode: _drop, ...withoutInvite } = goodBody;
  const r = await handleIntent(d, withoutInvite);
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, { error: "bad-invite" });
  assert.equal(d.metrics.rejected["bad-invite"], 1);
});

test("quote with unknown invite code is 403", async () => {
  const r = await handleIntent(deps({ [MAKER_A]: await quoteFrom(MAKER_A, KEY_A) }), { ...goodBody, inviteCode: "wrong" });
  assert.equal(r.status, 403);
});

test("bad-invite attempts over the limit are 429; valid codes never consume a slot", async () => {
  const d = deps({ [MAKER_A]: await quoteFrom(MAKER_A, KEY_A) }, { badInviteLimiter: new RateLimiter(2, 1000, () => 0) });
  assert.equal((await handleIntent(d, goodBody)).status, 200);
  assert.equal((await handleIntent(d, { ...goodBody, inviteCode: "wrong" })).status, 403);
  assert.equal((await handleIntent(d, { ...goodBody, inviteCode: "wrong" })).status, 403);
  assert.equal((await handleIntent(d, { ...goodBody, inviteCode: "wrong" })).status, 429);
  assert.equal((await handleIntent(d, goodBody)).status, 200);
});

test("quote limiter caps all quotes per IP, keyed separately", async () => {
  const d = deps({ [MAKER_A]: await quoteFrom(MAKER_A, KEY_A) }, { quoteLimiter: new RateLimiter(1, 1000, () => 0) });
  assert.equal((await handleIntent(d, goodBody, "1.2.3.4")).status, 200);
  const r = await handleIntent(d, goodBody, "1.2.3.4");
  assert.equal(r.status, 429);
  assert.deepEqual(r.json, { error: "rate-limited" });
  assert.equal((await handleIntent(d, goodBody, "5.6.7.8")).status, 200);
});

test("waitlist-issued code passes the invite gate", async () => {
  const wl = new Waitlist(file());
  const { code } = wl.signup("a@b.co");
  const body = { ...goodBody, inviteCode: code };
  assert.equal((await handleIntent(deps({ [MAKER_A]: await quoteFrom(MAKER_A, KEY_A) }), body)).status, 403);
  assert.equal((await handleIntent(deps({ [MAKER_A]: await quoteFrom(MAKER_A, KEY_A) }, { waitlist: wl }), body)).status, 200);
});

// --- HTTP ---

/** Stands in for a loopback maker on the proxied GET routes; /rfq goes through the askMaker fake. */
async function stubMaker(): Promise<{ url: string; close(): void }> {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/limits") return res.end(JSON.stringify({ maxStake: "10000000", edgeBps: "725", legEdgeBps: "150", quoteTtlMs: 15000 }));
    if (req.url?.startsWith("/parlays?")) {
      const taker = new URL(req.url, "http://m").searchParams.get("taker");
      if (taker?.toLowerCase() !== TAKER.toLowerCase()) { res.statusCode = 400; return res.end(JSON.stringify({ error: "taker must be an address" })); }
      return res.end(JSON.stringify([{ id: "7", block: "120" }]));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

async function relayUp(d: RelayDeps): Promise<{ base: string; server: http.Server }> {
  const server = startRelay(d, 0, () => ({ ok: true }));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

async function oneMakerDeps(url: string, overrides: Partial<RelayDeps> = {}): Promise<Deps> {
  return deps({ [MAKER_A]: await quoteFrom(MAKER_A, KEY_A) }, { cfg: cfg({ makers: [{ maker: MAKER_A, url }] }), ...overrides });
}

test("HTTP smoke: /quote, /health, /metrics, /limits, /parlays, bad-json, unknown route", async () => {
  const maker = await stubMaker();
  const d = await oneMakerDeps(maker.url);
  const { base, server } = await relayUp(d);
  try {
    const badJson = await fetch(`${base}/quote`, { method: "POST", body: "{not json" });
    assert.equal(badJson.status, 400);
    assert.deepEqual(await badJson.json(), { error: "bad-json" });

    const quoteRes = await fetch(`${base}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(goodBody) });
    assert.equal(quoteRes.status, 200);
    const qj = (await quoteRes.json()) as Quoted;
    assert.match(qj.sig, /^0x[0-9a-f]{130}$/);
    assert.deepEqual(qj.makers, { asked: 1, quoted: 1 });

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const hj = (await health.json()) as { ok: boolean; makers: Record<string, unknown>[] };
    assert.equal(hj.ok, true);
    assert.deepEqual(hj.makers, [{ maker: MAKER_A, ok: true, seeded: true, bankroll: "1" }]); // perMarket stays private

    const metrics = await fetch(`${base}/metrics`);
    assert.equal(metrics.status, 200);
    assert.equal(((await metrics.json()) as { quoted: number }).quoted, 1);

    const limits = await fetch(`${base}/limits`, { headers: { origin: "https://overround.xyz" } });
    assert.equal(limits.status, 200);
    assert.equal(limits.headers.get("access-control-allow-origin"), "https://overround.xyz");
    assert.deepEqual(await limits.json(), { maxStake: "10000000", edgeBps: "725", legEdgeBps: "150", quoteTtlMs: 15000, makers: 1 });

    const parlays = await fetch(`${base}/parlays?taker=${TAKER}`);
    assert.equal(parlays.status, 200);
    assert.deepEqual(await parlays.json(), [{ id: "7", block: "120" }]);
    assert.equal((await fetch(`${base}/parlays?taker=nope`)).status, 400);
    assert.equal((await fetch(`${base}/parlays`)).status, 404);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    server.close();
    maker.close();
  }
});

test("HTTP: unreachable maker on a proxied route is 503 maker-unreachable; /health reports it down", async () => {
  const d = await oneMakerDeps("http://127.0.0.1:1", { makerHealth: async () => null });
  const { base, server } = await relayUp(d);
  try {
    const limits = await fetch(`${base}/limits`);
    assert.equal(limits.status, 503);
    assert.deepEqual(await limits.json(), { error: "maker-unreachable" });
    const hj = (await (await fetch(`${base}/health`)).json()) as { makers: { ok: boolean }[] };
    assert.equal(hj.makers[0].ok, false);
  } finally {
    server.close();
  }
});

test("GET /markets serves registry verbatim with CORS", async () => {
  const registryJson = '{"markets":[{"vault":"0x1111111111111111111111111111111111111111","title":"T","category":"c","coinYes":"#10","coinNo":"#11","underlying":"game-1","cluster":"sports"}]}';
  const { base, server } = await relayUp(deps({}, { cfg: cfg({ registryJson }) }));
  try {
    const r = await fetch(`${base}/markets`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.equal(await r.text(), registryJson);
  } finally {
    server.close();
  }
});

test("OPTIONS preflight returns 204 with CORS headers for an allowed origin", async () => {
  const { base, server } = await relayUp(deps({}));
  try {
    const r = await fetch(`${base}/quote`, { method: "OPTIONS", headers: { origin: "https://overround.xyz" } });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), "https://overround.xyz");
    assert.match(r.headers.get("access-control-allow-headers") ?? "", /content-type/i);
  } finally {
    server.close();
  }
});

test("OPTIONS preflight still 204s with no Origin header (no ACAO to echo)", async () => {
  const { base, server } = await relayUp(deps({}));
  try {
    const r = await fetch(`${base}/quote`, { method: "OPTIONS" });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  } finally {
    server.close();
  }
});

test("OPTIONS /markets preflight stays open (*), not locked to the allowlist", async () => {
  const { base, server } = await relayUp(deps({}));
  try {
    const r = await fetch(`${base}/markets`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
  } finally {
    server.close();
  }
});

test("POST /quote CORS: allowed origin echoed, disallowed or absent origin gets none but still Vary: Origin and a 200", async () => {
  const d = await oneMakerDeps("http://a");
  const { base, server } = await relayUp(d);
  const post = (headers: Record<string, string>) =>
    fetch(`${base}/quote`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(goodBody) });
  try {
    const ok = await post({ origin: "https://overround.xyz" });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://overround.xyz");
    const evil = await post({ origin: "https://evil.example" });
    assert.equal(evil.status, 200); // CORS is browser-enforcement only — fetch() here ignores it, like curl would.
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
    assert.equal(evil.headers.get("vary"), "Origin");
    const cli = await post({});
    assert.equal(cli.status, 200);
    assert.equal(cli.headers.get("access-control-allow-origin"), null);
  } finally {
    server.close();
  }
});

test("HTTP smoke: oversized body rejected with 413, server keeps serving", async () => {
  const d = await oneMakerDeps("http://a");
  const { base, server } = await relayUp(d);
  try {
    const huge = "a".repeat(65 * 1024);
    let big: Response | undefined;
    try {
      big = await fetch(`${base}/quote`, { method: "POST", body: huge });
    } catch {
    }
    if (big) {
      assert.equal(big.status, 413);
      assert.deepEqual(await big.json(), { error: "body-too-large" });
    }
    const quoteRes = await fetch(`${base}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(goodBody) });
    assert.equal(quoteRes.status, 200);
  } finally {
    server.close();
  }
});

// --- waitlist ---

function waitlistDeps(over: Partial<RelayDeps>): RelayDeps {
  // handleWaitlist touches only these fields; the quote-path deps stay unused.
  return { now: () => 0, ...over } as RelayDeps;
}

test("handleWaitlist: signup persists even when the email send fails", async () => {
  const wl = new Waitlist(file());
  const d = waitlistDeps({
    waitlist: wl,
    sendInvite: async () => {
      throw new Error("resend down");
    },
  });
  const r = await handleWaitlist(d, { email: "a@b.co" }, "1.2.3.4");
  assert.equal(r.status, 502);
  assert.equal(wl.size(), 1); // retry re-sends the same code

  const sent: string[] = [];
  d.sendInvite = async (email, code) => void sent.push(`${email}:${code}`);
  const ok = await handleWaitlist(d, { email: "a@b.co" }, "1.2.3.4");
  assert.equal(ok.status, 200);
  assert.equal(wl.size(), 1);
  assert.equal(sent.length, 1);
});

test("handleWaitlist: bad email, rate limit, unavailable", async () => {
  const wl = new Waitlist(file());
  const limiter = new RateLimiter(1, 1000, () => 0);
  const d = waitlistDeps({ waitlist: wl, sendInvite: async () => {}, signupLimiter: limiter });

  assert.equal((await handleWaitlist(d, { email: "nope" }, "ip")).status, 400);
  assert.equal((await handleWaitlist(d, {}, "ip")).status, 400);
  assert.equal((await handleWaitlist(d, { email: "a@b.co" }, "ip")).status, 200);
  assert.equal((await handleWaitlist(d, { email: "c@d.co" }, "ip")).status, 429);

  assert.equal((await handleWaitlist(waitlistDeps({}), { email: "a@b.co" }, "ip")).status, 503);
});

test("POST /waitlist over HTTP", async () => {
  const wl = new Waitlist(file());
  const { base, server } = await relayUp(deps({}, { waitlist: wl, sendInvite: async () => {} }));
  try {
    const r = await fetch(`${base}/waitlist`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@b.co" }) });
    assert.equal(r.status, 200);
    assert.equal(wl.size(), 1);
  } finally {
    server.close();
  }
});
