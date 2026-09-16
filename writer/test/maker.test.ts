import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Address, Hex } from "viem";
import { handleQuote, sameGameLeg, validateIntent, newMetrics, startMaker, type QuoteDeps } from "../src/maker.js";
import { ExposureBook } from "../src/exposure.js";
import { WAD } from "../src/pure.js";
import type { WriterConfig } from "../src/config.js";
import { quoteDigest, type QuoteRecord } from "../src/quotes.js";

const V1 = "0x1111111111111111111111111111111111111111" as Address;
const V2 = "0x2222222222222222222222222222222222222222" as Address;
const TAKER = "0x3333333333333333333333333333333333333333" as Address;

function cfg(overrides: Partial<WriterConfig> = {}): WriterConfig {
  return {
    chainId: 998, rpcUrl: "", parlayVault: V1, writerAddress: TAKER,
    quoteSignerKey: `0x${"11".repeat(32)}` as `0x${string}`,
    pokerKey: `0x${"22".repeat(32)}` as `0x${string}`,
    infoApiUrl: "", quoteJournalFile: "/dev/null", port: 0, makerToken: "t", edgeBps: 0n, minPremiumBps: 100n, minLegs: 2,
    maxStake: 10_000_000n, perMarketCap: 1_000_000_000n, perClusterCap: 1_000_000_000n,
    perCodeReservedCap: 1_000_000_000n,
    legEdgeBps: 0n, quoteTtlMs: 30_000,
    spotPxStaleMs: 60_000,
    minBookDepthWad: 0n,
    lockoutMs: 600_000, pokerIntervalMs: 15_000, deployBlock: 0n,
    inviteCodes: new Set(["beta-test"]),
    waitlistFile: "/dev/null",
    corsOrigins: ["https://overround.xyz"],
    markets: new Map([
      [V1.toLowerCase(), { vault: V1, coinYes: "+10", coinNo: "+11", underlying: "game-1", cluster: "sports", title: "Twins vs Orioles", category: "sports" }],
      [V2.toLowerCase(), { vault: V2, coinYes: "+20", coinNo: "+21", expiryMs: 2_000_000, underlying: "game-2", cluster: "sports", title: "Arsenal vs Chelsea", category: "sports" }],
    ]),
    registryJson: "{}",
    ...overrides,
  };
}

function legOn(vault: Address, isYes: boolean): { vault: Address; isYes: boolean } {
  return { vault, isYes };
}

function body(overrides: { legs: { vault: Address; isYes: boolean }[] }): typeof goodBody {
  return { ...goodBody, ...overrides };
}

function deps(overrides: Partial<QuoteDeps> = {}): QuoteDeps {
  const c = overrides.cfg ?? cfg();
  return {
    cfg: c,
    exposure: new ExposureBook((v) => c.markets.get(v)?.cluster),
    chainId: 31337,
    fetchLegPrice: async () => ({ priceWad: WAD / 2n, source: "l2Book", observedAtMs: 1_000_000, depthWad: WAD, vwapWad: WAD / 2n, freshnessMs: null }),
    recordQuote: async () => {},
    readAllowance: async () => 1_000_000_000n,
    readSettled: async () => new Set(),
    sign: async () => "0xsig" as Hex,
    now: () => 1_000_000,
    randomId: () => `0x${"ab".repeat(32)}` as Hex,
    metrics: newMetrics(),
    ...overrides,
  };
}

const goodBody = { rfqId: "rfq-1", taker: TAKER, legs: [{ vault: V1, isYes: true }, { vault: V2, isYes: false }], stake: "1000000", quotaKey: "k1", respondByMs: 2_000_000 };
const BEARER = { authorization: "Bearer t", "content-type": "application/json" };

test("happy path: returns signed quote, reserves exposure", async () => {
  const d = deps();
  const r = await handleQuote(d, goodBody);
  assert.equal(r.status, 200);
  const j = r.json as { quote: { premium: string; maxPayout: string; deadline: string }; sig: string };
  assert.equal(j.quote.premium, "1000000");
  assert.equal(j.quote.maxPayout, "4000000");
  assert.equal(j.quote.deadline, "1030"); // (1_000_000 + 30_000) ms -> seconds
  assert.equal(j.sig, "0xsig");
  assert.equal(d.exposure.reservedGlobal(d.now()), 3_000_000n); // maxPayout - premium
  assert.equal(d.metrics.quoted, 1);
});

test("cluster cap: 409 when cluster exposure would exceed perClusterCap", async () => {
  const d = deps({ cfg: cfg({ perClusterCap: 1n }) }); // any non-zero risk exceeds a 1-wei cap
  const r = await handleQuote(d, goodBody);
  assert.equal(r.status, 409);
  assert.equal(d.metrics.rejected["cluster-cap"], 1);
  assert.equal(d.exposure.reservedGlobal(d.now()), 0n);
});


test("bad-rfq: empty rfqId or quotaKey is 400 and reserves nothing; intent errors win first", async () => {
  const d = deps();
  assert.deepEqual(await handleQuote(d, { ...goodBody, rfqId: "" }), { status: 400, json: { error: "bad-rfq" } });
  const { quotaKey: _drop, ...noKey } = goodBody;
  assert.equal((await handleQuote(d, noKey)).status, 400);
  assert.equal(d.metrics.rejected["bad-rfq"], 2);
  assert.equal(d.exposure.reservedGlobal(d.now()), 0n);
  assert.deepEqual(await handleQuote(d, { ...goodBody, rfqId: "", stake: "0" }), { status: 400, json: { error: "bad-stake" } });
});

test("validation: unknown vault, leg count, stake cap, lockout", () => {
  const c = cfg();
  const unknown = { ...goodBody, legs: [{ vault: TAKER, isYes: true }, { vault: V2, isYes: false }] };
  assert.equal((validateIntent(unknown, c, 0) as { reason: string }).reason, "unknown-vault");
  const one = { ...goodBody, legs: [{ vault: V1, isYes: true }] };
  assert.equal((validateIntent(one, c, 0) as { reason: string }).reason, "bad-leg-count");
  const fat = { ...goodBody, stake: "10000001" };
  assert.equal((validateIntent(fat, c, 0) as { reason: string }).reason, "stake-too-big");
  assert.equal((validateIntent(goodBody, c, 1_500_000) as { reason: string }).reason, "expiry-lockout");
});

test("settled leg: 409", async () => {
  const d = deps({ readSettled: async () => new Set([V1.toLowerCase()]) });
  const r = await handleQuote(d, goodBody);
  assert.equal(r.status, 409);
});

test("book fetch failure: 503, nothing reserved", async () => {
  const d = deps({ fetchLegPrice: async () => { throw new Error("down"); } });
  const r = await handleQuote(d, goodBody);
  assert.equal(r.status, 503);
  assert.equal(d.exposure.reservedGlobal(d.now()), 0n);
});

test("empty book at the 0.5 spotPx placeholder: 503 unpriced-leg, nothing reserved", async () => {
  const d = deps({ fetchLegPrice: async () => ({ priceWad: WAD / 2n, source: "spotPx", observedAtMs: 1_000_000, depthWad: null, vwapWad: null, freshnessMs: null }) });
  const r = await handleQuote(d, goodBody);
  assert.equal(r.status, 503);
  assert.equal((r.json as { error: string }).error, "unpriced-leg");
  assert.equal(d.metrics.rejected["unpriced-leg"], 1);
  assert.equal(d.exposure.reservedGlobal(d.now()), 0n);
  const traded = deps({ fetchLegPrice: async () => ({ priceWad: WAD / 2n, source: "l2Book", observedAtMs: 1_000_000, depthWad: WAD, vwapWad: WAD / 2n, freshnessMs: null }) });
  assert.equal((await handleQuote(traded, goodBody)).status, 200);
});

test("at-capacity: 409, metrics counted", async () => {
  const d = deps({ readAllowance: async () => 1_000_000n }); // risk 3_000_000 > 1_000_000
  const r = await handleQuote(d, goodBody);
  assert.equal(r.status, 409);
  assert.equal(d.metrics.rejected["at-capacity"], 1);
  assert.equal(d.exposure.reservedGlobal(d.now()), 0n);
});

test("quota-cap: 409 once one quotaKey's unminted reservations hit their cap; a second key is unaffected", async () => {
  const OTHER_TAKER = "0x4444444444444444444444444444444444444444" as Address;
  const d = deps({ cfg: cfg({ perCodeReservedCap: 3_000_000n }) });
  const first = await handleQuote(d, goodBody);
  assert.equal(first.status, 200);
  const second = await handleQuote(d, goodBody);
  assert.equal(second.status, 409);
  assert.deepEqual(second.json, { error: "quota-cap", maxStake: "0" });
  assert.equal(d.metrics.rejected["quota-cap"], 1);
  const spoofed = await handleQuote(d, { ...goodBody, taker: OTHER_TAKER });
  assert.equal(spoofed.status, 409);
  const otherKey = await handleQuote(d, { ...goodBody, quotaKey: "k2" });
  assert.equal(otherKey.status, 200);
});

test("quota-cap: reservation expiry frees the taker's budget for a new quote", async () => {
  const d = deps({ cfg: cfg({ perCodeReservedCap: 3_000_000n }) });
  let now = 1_000_000;
  const dWithClock = { ...d, now: () => now };
  assert.equal((await handleQuote(dWithClock, goodBody)).status, 200);
  assert.equal((await handleQuote(dWithClock, goodBody)).status, 409);
  now += 30_001; // past the 30s quoteTtlMs default -> reservation expired
  assert.equal((await handleQuote(dWithClock, goodBody)).status, 200);
});

test("sign failure: 503, reservation released, metrics counted", async () => {
  const d = deps({
    sign: async () => {
      throw new Error("hsm down");
    },
  });
  const r = await handleQuote(d, goodBody);
  assert.equal(r.status, 503);
  assert.equal(d.exposure.reservedGlobal(d.now()), 0n);
  assert.equal(d.metrics.rejected["sign-failed"], 1);
});

test("journal failure: 503 releases reservation and never returns a signature", async () => {
  const d = deps({
    recordQuote: async () => { throw new Error("disk full"); },
  } as Partial<QuoteDeps>);
  const r = await handleQuote(d, goodBody);
  assert.deepEqual(r, { status: 503, json: { error: "journal-failed" } });
  assert.equal(d.exposure.reservedGlobal(d.now()), 0n);
  assert.equal(d.metrics.quoted, 0);
  assert.equal(d.metrics.rejected["journal-failed"], 1);
  assert.equal(JSON.stringify(r.json).includes("0xsig"), false);
});

test("journal: records the returned quote identity and economics before returning", async () => {
  let recorded: unknown;
  const d = deps({
    recordQuote: async (decision: unknown) => { recorded = decision; },
  } as Partial<QuoteDeps>);
  const r = await handleQuote(d, goodBody);
  assert.equal(r.status, 200);
  const response = r.json as { quote: { quoteId: Hex; maker: Address; premium: string; maxPayout: string; deadline: string; legs: { vault: Address; isYes: boolean }[] } };
  assert.deepEqual(recorded && {
    quoteId: (recorded as { quoteId: string }).quoteId,
    premium: (recorded as { premium: string }).premium,
    maxPayout: (recorded as { maxPayout: string }).maxPayout,
  }, {
    quoteId: response.quote.quoteId,
    premium: response.quote.premium,
    maxPayout: response.quote.maxPayout,
  });
  assert.equal(typeof (recorded as { quoteDigest?: unknown }).quoteDigest, "string");
  const decision = recorded as QuoteRecord;
  assert.equal(decision.schemaVersion, 1);
  assert.equal(decision.maker, d.cfg.writerAddress);
  assert.equal(decision.rfqId, "rfq-1");
  assert.equal(decision.jointProbWad, (WAD / 4n).toString());
  assert.equal(decision.bookInputs.length, 2);
  assert.equal(
    (recorded as { quoteDigest: string }).quoteDigest,
    quoteDigest(d.chainId, d.cfg.parlayVault, {
      taker: TAKER,
      maker: d.cfg.writerAddress,
      legs: response.quote.legs,
      premium: BigInt(response.quote.premium),
      maxPayout: BigInt(response.quote.maxPayout),
      deadline: BigInt(response.quote.deadline),
      quoteId: response.quote.quoteId,
    }),
  );
});

test("HTTP smoke: /rfq bearer, /health, /metrics, bad-json, unknown route; loopback only", async () => {
  const d = deps();
  const server = startMaker(d, 0, () => ({ ok: true }));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address() as AddressInfo;
  assert.equal(addr.address, "127.0.0.1");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    for (const headers of [{}, { authorization: "Bearer wrong" }] as Record<string, string>[]) {
      const noAuth = await fetch(`${base}/rfq`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(goodBody) });
      assert.equal(noAuth.status, 401);
      assert.deepEqual(await noAuth.json(), { error: "unauthorized" });
    }
    assert.equal(d.exposure.reservedGlobal(d.now()), 0n);
    assert.equal(d.metrics.quoted, 0);

    const badJson = await fetch(`${base}/rfq`, { method: "POST", headers: BEARER, body: "{not json" });
    assert.equal(badJson.status, 400);
    assert.deepEqual(await badJson.json(), { error: "bad-json" });

    const quoteRes = await fetch(`${base}/rfq`, { method: "POST", headers: BEARER, body: JSON.stringify(goodBody) });
    assert.equal(quoteRes.status, 200);
    const qj = (await quoteRes.json()) as { sig: string };
    assert.equal(qj.sig, "0xsig");

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const metrics = await fetch(`${base}/metrics`);
    assert.equal(metrics.status, 200);
    const mj = (await metrics.json()) as { quoted: number };
    assert.equal(mj.quoted, 1);

    const notFound = await fetch(`${base}/nope`);
    assert.equal(notFound.status, 404);

    d.parlaysOf = (taker) => (taker.toLowerCase() === TAKER.toLowerCase() ? [{ id: 7n, block: 120n }] : []);
    const parlays = await fetch(`${base}/parlays?taker=${TAKER}`);
    assert.equal(parlays.status, 200);
    assert.deepEqual(await parlays.json(), [{ id: "7", block: "120" }]); // bigints serialized as strings
    assert.equal((await fetch(`${base}/parlays?taker=nope`)).status, 400);
    assert.equal((await fetch(`${base}/parlays`)).status, 404); // no query: not this route
  } finally {
    server.close();
  }
});

test("GET /limits exposes configured base and per-leg pricing without authentication", async () => {
  const server = startMaker(deps({ cfg: cfg({ edgeBps: 725n, legEdgeBps: 150n }) }), 0, () => ({ ok: true }));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/limits`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { maxStake: "10000000", edgeBps: "725", legEdgeBps: "150", quoteTtlMs: 30000 });
  } finally {
    server.close();
  }
});


test("HTTP smoke: oversized body rejected with 413, server keeps serving", async () => {
  const d = deps();
  const server = startMaker(d, 0, () => ({ ok: true }));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const huge = "a".repeat(65 * 1024);
    let big: Response | undefined;
    try {
      big = await fetch(`${base}/rfq`, { method: "POST", headers: BEARER, body: huge });
    } catch {
    }
    if (big) {
      assert.equal(big.status, 413);
      assert.deepEqual(await big.json(), { error: "body-too-large" });
    }

    const quoteRes = await fetch(`${base}/rfq`, { method: "POST", headers: BEARER, body: JSON.stringify(goodBody) });
    assert.equal(quoteRes.status, 200);
  } finally {
    server.close();
  }
});

const MATCH_A = "0xaaaa000000000000000000000000000000000001" as Address; // q844: Saudi Arabia
const MATCH_DRAW = "0xaaaa000000000000000000000000000000000002" as Address; // q844: Draw
const MATCH_B_OTHER = "0xaaaa000000000000000000000000000000000003" as Address; // q845: Iran
const GAME_OU = "0xaaaa000000000000000000000000000000000004" as Address; // standalone O/U on the q844 game
const GAME_STANDALONE = "0xaaaa000000000000000000000000000000000005" as Address; // MLB winner, 2-way

const SPORTS_MARKETS = new Map<string, WriterConfig["markets"] extends Map<string, infer M> ? M : never>([
  [MATCH_A.toLowerCase(), { vault: MATCH_A, coinYes: "#1", coinNo: "#2", underlying: "q844", cluster: "WC2026", title: "Saudi Arabia", category: "sports", question: 844, group: "q844", groupTitle: "Saudi Arabia vs Uruguay", startMs: 5_000_000, expiryMs: 9_000_000 }],
  [MATCH_DRAW.toLowerCase(), { vault: MATCH_DRAW, coinYes: "#3", coinNo: "#4", underlying: "q844", cluster: "WC2026", title: "Draw", category: "sports", question: 844, group: "q844", groupTitle: "Saudi Arabia vs Uruguay" }],
  [MATCH_B_OTHER.toLowerCase(), { vault: MATCH_B_OTHER, coinYes: "#5", coinNo: "#6", underlying: "q845", cluster: "WC2026", title: "Iran", category: "sports", question: 845, group: "q845", groupTitle: "Iran vs New Zealand" }],
  [GAME_OU.toLowerCase(), { vault: GAME_OU, coinYes: "#7", coinNo: "#8", underlying: "q844", cluster: "WC2026", title: "Over 1.5 goals", category: "sports", sideYes: "Over", sideNo: "Under" }],
  [GAME_STANDALONE.toLowerCase(), { vault: GAME_STANDALONE, coinYes: "#9", coinNo: "#10", underlying: "MIN-BAL-20260812", cluster: "MLB", title: "Twins vs Orioles", category: "sports", sideYes: "Twins", sideNo: "Orioles" }],
]);

function sportsCfg(overrides: Partial<WriterConfig> = {}): WriterConfig {
  return cfg({ markets: SPORTS_MARKETS, ...overrides });
}

test("sports: cross-game legs quote as the product of their prices", async () => {
  const d = deps({ cfg: sportsCfg() });
  const r = await handleQuote(d, body({ legs: [legOn(MATCH_A, true), legOn(GAME_STANDALONE, false)] }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const j = r.json as { quote: { maxPayout: string }; breakdown: { jointProbWad: string } };
  assert.equal(j.breakdown.jointProbWad, (WAD / 4n).toString());
  assert.equal(j.quote.maxPayout, "4000000");
});

test("sports: two legs on one question (A + Draw) are refused as same-game", () => {
  const c = sportsCfg();
  assert.deepEqual(validateIntent(body({ legs: [legOn(MATCH_A, true), legOn(MATCH_DRAW, true)] }), c, 0), { ok: false, status: 400, reason: "same-game" });
  assert.deepEqual(validateIntent(body({ legs: [legOn(MATCH_A, true), legOn(MATCH_DRAW, false)] }), c, 0), { ok: false, status: 400, reason: "same-game" });
  assert.equal(sameGameLeg([legOn(MATCH_A, true), legOn(MATCH_DRAW, true)], c), MATCH_DRAW);
});

test("sports: a winner leg plus an over/under on the same game is refused as same-game", () => {
  const c = sportsCfg();
  assert.deepEqual(validateIntent(body({ legs: [legOn(MATCH_A, true), legOn(GAME_OU, true)] }), c, 0), { ok: false, status: 400, reason: "same-game" });
  assert.equal(validateIntent(body({ legs: [legOn(MATCH_A, true), legOn(MATCH_B_OTHER, true)] }), c, 0).ok, true);
});

test("sports: quoting stays open in-play, locks at the resolution deadline (expiryMs)", () => {
  const c = sportsCfg();
  const ticket = body({ legs: [legOn(MATCH_A, true), legOn(GAME_STANDALONE, true)] });
  assert.equal(validateIntent(ticket, c, 6_000_000).ok, true);
  assert.equal(validateIntent(ticket, c, 8_399_999).ok, true);
  assert.deepEqual(validateIntent(ticket, c, 8_400_000), { ok: false, status: 400, reason: "expiry-lockout" });
});

test("handleQuote answers 503 warming-up until deps.ready() flips, without consuming quote quota", async () => {
  const d = deps();
  let seeded = false;
  d.ready = () => seeded;
  const cold = await handleQuote(d, goodBody);
  assert.equal(cold.status, 503);
  assert.deepEqual(cold.json, { error: "warming-up" });
  assert.equal(d.metrics.rejected["warming-up"], 1);
  seeded = true;
  const warm = await handleQuote(d, goodBody);
  assert.equal(warm.status, 200);
});

test("duplicate vaults are refused on either side before signing", async () => {
  for (const isYes of [true, false]) {
    let signed = false;
    const d = deps({ sign: async () => { signed = true; return "0x12"; } });
    const result = await handleQuote(d, body({ legs: [legOn(V1, true), legOn(V1, isYes)] }));
    assert.deepEqual(result, { status: 400, json: { error: "same-game" } });
    assert.equal(signed, false);
    assert.equal(d.exposure.reservedGlobal(d.now()), 0n);
  }
});

test("a parlay paying less than one leg alone is refused", async () => {
  const d = deps({
    cfg: cfg({ edgeBps: 500n, legEdgeBps: 300n }),
    fetchLegPrice: async (leg) => ({ priceWad: leg.vault === V1 ? WAD / 5n : WAD * 99n / 100n, source: "l2Book", observedAtMs: 1_000_000, depthWad: WAD, vwapWad: WAD / 2n, freshnessMs: null }),
  });
  assert.deepEqual(await handleQuote(d, goodBody), { status: 400, json: { error: "dominated", vault: V1 } });
  assert.equal(d.exposure.reservedGlobal(d.now()), 0n);
});
