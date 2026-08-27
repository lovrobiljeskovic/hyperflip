import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Address, Hex } from "viem";
import { handleQuote, validateQuoteRequest, newMetrics, startServer, type QuoteDeps } from "../src/server.js";
import { ExposureBook } from "../src/exposure.js";
import { RateLimiter } from "../src/waitlist.js";
import { parseCorrelations } from "../src/correlation.js";
import { WAD } from "../src/pure.js";
import type { WriterConfig } from "../src/config.js";

const V1 = "0x1111111111111111111111111111111111111111" as Address;
const V2 = "0x2222222222222222222222222222222222222222" as Address;
const TAKER = "0x3333333333333333333333333333333333333333" as Address;

// Distinct from V1/V2/TAKER above — the brief's suggested 0x1111../0x2222../0x3333..
// addresses collide with those and would silently clobber the V2 (ETH) fixture.
const BTC_VAULT_A = "0x5555555555555555555555555555555555555555" as const;
const BTC_VAULT_B = "0x6666666666666666666666666666666666666666" as const;
const NVDA_VAULT = "0x7777777777777777777777777777777777777777" as const;
const SP500_VAULT = "0x8888888888888888888888888888888888888888" as const;
/** direction "band": wins if the underlying stays inside a range, so neither
 * side is bullish or bearish. */
const BAND_VAULT = "0x9999999999999999999999999999999999999999" as Address;

const CORRELATIONS = parseCorrelations(readFileSync(new URL("../../registry/correlations.json", import.meta.url), "utf8"));

const FIXTURE_MARKETS = new Map(
  (
    [
      [BTC_VAULT_A, "BTC", "crypto", "BTC above 69192.75 on Aug 22?"],
      [BTC_VAULT_B, "BTC", "crypto", "BTC above 72000 on Aug 22?"],
      [NVDA_VAULT, "NVDA", "equity", "NVDA above 230 on Aug 28?"],
      [SP500_VAULT, "SP500", "equity", "SP500 above 8000 on Aug 31?"],
    ] as const
  ).map(([vault, underlying, cluster, title]) => [
    vault.toLowerCase(),
    {
      vault,
      coinYes: "+1",
      coinNo: "+2",
      underlying,
      cluster,
      direction: "up" as const,
      title,
      category: cluster,
    },
  ]),
);

function cfg(overrides: Partial<WriterConfig> = {}): WriterConfig {
  return {
    rpcUrl: "", parlayVault: V1, writerAddress: TAKER,
    quoteSignerKey: `0x${"11".repeat(32)}` as `0x${string}`,
    pokerKey: `0x${"22".repeat(32)}` as `0x${string}`,
    infoApiUrl: "", port: 0, edgeBps: 0n, minPremiumBps: 100n, minLegs: 2,
    maxStake: 10_000_000n, perMarketCap: 1_000_000_000n, perClusterCap: 1_000_000_000n,
    rhoBandPct: 0.2, correlations: CORRELATIONS, legEdgeBps: 0n, quoteTtlMs: 30_000,
    spotPxStaleMs: 60_000,
    minBookDepthWad: 0n,
    lockoutMs: 600_000, pokerIntervalMs: 15_000, deployBlock: 0n,
    inviteCodes: new Set(["beta-test"]),
    waitlistFile: "/dev/null",
    markets: new Map([
      [V1.toLowerCase(), { vault: V1, coinYes: "+10", coinNo: "+11", underlying: "BTC", cluster: "crypto", direction: "up" as const, title: "Will BTC close above X?", category: "crypto" }],
      [V2.toLowerCase(), { vault: V2, coinYes: "+20", coinNo: "+21", expiryMs: 2_000_000, underlying: "ETH", cluster: "crypto", direction: "up" as const, title: "Will ETH close above X?", category: "crypto" }],
      ...FIXTURE_MARKETS,
      [BAND_VAULT.toLowerCase(), { vault: BAND_VAULT, coinYes: "+30", coinNo: "+31", underlying: "GOLD", cluster: "commodity", direction: "band" as const, title: "GOLD between 4000 and 4250 on Aug 31?", category: "commodity" }],
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
    fetchLegPriceWad: async () => WAD / 2n,
    readAllowance: async () => 1_000_000_000n,
    readSettled: async () => new Set(),
    sign: async () => "0xsig" as Hex,
    now: () => 1_000_000,
    randomId: () => `0x${"ab".repeat(32)}` as Hex,
    metrics: newMetrics(),
    ...overrides,
  };
}

const goodBody = { taker: TAKER, legs: [{ vault: V1, isYes: true }, { vault: V2, isYes: false }], stake: "1000000", inviteCode: "beta-test" };

test("happy path: returns signed quote, reserves exposure", async () => {
  const d = deps();
  const r = await handleQuote(d, goodBody);
  assert.equal(r.status, 200);
  const j = r.json as { quote: { premium: string; maxPayout: string; deadline: string }; sig: string };
  assert.equal(j.quote.premium, "1000000");
  // V1 (BTC, bull) and V2 (ETH, bear) sit in the same cluster but bet opposite
  // directions, so real correlation pushes the joint probability below the
  // naive 0.5*0.5 product — a higher payout than the old independence math gave.
  assert.equal(j.quote.maxPayout, "8422341");
  assert.equal(j.quote.deadline, "1030"); // (1_000_000 + 30_000) ms -> seconds
  assert.equal(j.sig, "0xsig");
  assert.equal(d.exposure.reservedGlobal(d.now()), 7_422_341n); // maxPayout - premium
  assert.equal(d.metrics.quoted, 1);
});

test("same-cluster same-direction legs now quote instead of 400", async () => {
  const res = await handleQuote(deps(), body({ legs: [legOn(NVDA_VAULT, true), legOn(SP500_VAULT, true)] }));
  assert.equal(res.status, 200);
});

test("two markets on the same underlying now quote", async () => {
  const res = await handleQuote(deps(), body({ legs: [legOn(BTC_VAULT_A, true), legOn(BTC_VAULT_B, true)] }));
  assert.equal(res.status, 200);
});

test("the same vault twice, opposite sides, is refused as cannot-win", async () => {
  const res = await handleQuote(deps(), body({ legs: [legOn(BTC_VAULT_A, true), legOn(BTC_VAULT_A, false)] }));
  assert.equal(res.status, 400);
  assert.equal((res.json as { error: string }).error, "cannot-win");
});

test("correlated legs pay less than the same legs priced independently", async () => {
  const correlated = await handleQuote(deps(), body({ legs: [legOn(NVDA_VAULT, true), legOn(SP500_VAULT, true)] }));
  const crossCluster = await handleQuote(deps(), body({ legs: [legOn(NVDA_VAULT, true), legOn(BTC_VAULT_A, true)] }));
  const payout = (r: typeof correlated) => BigInt((r.json as { quote: { maxPayout: string } }).quote.maxPayout);
  // No slack factor. Baseline is 7.25x against 12.54x; with every cluster
  // loading zeroed — correlation pricing dead — the same-cluster payout is
  // 13.77x, which a "* 3n" tolerance would have waved through.
  assert.ok(payout(correlated) < payout(crossCluster), "same-cluster legs must be materially tighter");
});

// The user's real ticket: NVDA>230 (p=0.1318) + SP500>8000 (p=0.4405). At the
// house end of the rho band the equity cluster collapses the joint to ~P(NVDA),
// and edge then pushes the payout below NVDA alone on Core — a ticket with
// strictly fewer ways to win AND a lower payout. Must be refused, not signed.
test("a quote dominated by one leg's Core fair payout is refused", async () => {
  const skewedPrices = async (l: { vault: Address }) =>
    l.vault.toLowerCase() === NVDA_VAULT.toLowerCase() ? (WAD * 1318n) / 10000n : (WAD * 4405n) / 10000n;
  const d = deps({ cfg: cfg({ edgeBps: 500n, legEdgeBps: 300n }), fetchLegPriceWad: skewedPrices });
  const r = await handleQuote(d, body({ legs: [legOn(NVDA_VAULT, true), legOn(SP500_VAULT, true)] }));
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: "dominated", vault: NVDA_VAULT });
  assert.equal(d.metrics.rejected["dominated"], 1);
  // Same legs, cross-cluster: correlation is near-zero, the second leg earns its
  // keep, and the identical edge settings quote fine.
  const ok = await handleQuote(d, body({ legs: [legOn(NVDA_VAULT, true), legOn(BTC_VAULT_A, true)] }));
  assert.equal(ok.status, 200);
});

test("a band market's two sides on one vault are refused as cannot-win", async () => {
  // Both sides of a band market are non-directional, so `bullish` is null on
  // each. Collapsing on stance rather than side would sell ~1.9x on a ticket
  // that cannot win.
  const res = await handleQuote(deps(), body({ legs: [legOn(BAND_VAULT, true), legOn(BAND_VAULT, false)] }));
  assert.equal(res.status, 400);
  assert.equal((res.json as { error: string }).error, "cannot-win");
});

test("breakdown reports the joint probability, not a correlation surcharge", async () => {
  const res = await handleQuote(deps(), body({ legs: [legOn(NVDA_VAULT, true), legOn(SP500_VAULT, true)] }));
  const bd = (res.json as { breakdown: Record<string, unknown> }).breakdown;
  assert.equal(bd.corrBps, undefined);
  assert.ok(typeof bd.jointProbWad === "string");
  const legs = (bd.legPricesWad as string[]).map((w) => BigInt(w));
  const product = legs.reduce((a, p) => (a * p) / 10n ** 18n, 10n ** 18n);
  assert.ok(BigInt(bd.jointProbWad as string) > product, "correlated joint must exceed the naive product");
});

test("the same vault twice, same side, collapses to one event and prices identically to the deduplicated ticket", async () => {
  // resolveSameMarket (correlation.ts) collapses this before pricing; this
  // exercises that collapse through the whole quote path, not just the model.
  const duplicated = await handleQuote(
    deps(),
    body({ legs: [legOn(BTC_VAULT_A, true), legOn(BTC_VAULT_A, true), legOn(NVDA_VAULT, true)] }),
  );
  const deduped = await handleQuote(deps(), body({ legs: [legOn(BTC_VAULT_A, true), legOn(NVDA_VAULT, true)] }));
  assert.equal(duplicated.status, 200);
  assert.equal(deduped.status, 200);
  const payout = (r: typeof duplicated) => (r.json as { quote: { maxPayout: string } }).quote.maxPayout;
  assert.equal(payout(duplicated), payout(deduped), "a duplicated same-side leg must not change the price");
});

test("cluster cap: 409 when cluster exposure would exceed perClusterCap", async () => {
  const d = deps({ cfg: cfg({ perClusterCap: 1n }) }); // any non-zero risk exceeds a 1-wei cap
  const r = await handleQuote(d, goodBody);
  assert.equal(r.status, 409);
  assert.equal(d.metrics.rejected["cluster-cap"], 1);
  assert.equal(d.exposure.reservedGlobal(d.now()), 0n);
});

test("quote without invite code is 403", async () => {
  const d = deps();
  const { inviteCode: _drop, ...withoutInvite } = goodBody;
  const r = await handleQuote(d, withoutInvite);
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, { error: "bad-invite" });
  assert.equal(d.metrics.rejected["bad-invite"], 1);
});

test("quote with unknown invite code is 403", async () => {
  const r = await handleQuote(deps(), { ...goodBody, inviteCode: "wrong" });
  assert.equal(r.status, 403);
});

test("bad-invite attempts over the limit are 429; valid codes never consume a slot", async () => {
  const d = deps({ badInviteLimiter: new RateLimiter(2, 1000, () => 0) });
  // Valid-code quotes don't touch the bad-invite limiter.
  assert.equal((await handleQuote(d, goodBody)).status, 200);
  assert.equal((await handleQuote(d, { ...goodBody, inviteCode: "wrong" })).status, 403);
  assert.equal((await handleQuote(d, { ...goodBody, inviteCode: "wrong" })).status, 403);
  assert.equal((await handleQuote(d, { ...goodBody, inviteCode: "wrong" })).status, 429);
  // A valid code from the same IP still quotes fine after the 429.
  assert.equal((await handleQuote(d, goodBody)).status, 200);
});

test("quote limiter caps all quotes per IP, keyed separately", async () => {
  const d = deps({ quoteLimiter: new RateLimiter(1, 1000, () => 0) });
  assert.equal((await handleQuote(d, goodBody, "1.2.3.4")).status, 200);
  const r = await handleQuote(d, goodBody, "1.2.3.4");
  assert.equal(r.status, 429);
  assert.deepEqual(r.json, { error: "rate-limited" });
  assert.equal((await handleQuote(d, goodBody, "5.6.7.8")).status, 200);
});

test("waitlist-issued code passes the invite gate", () => {
  const c = cfg();
  const body = { ...goodBody, inviteCode: "OVR-ABC123" };
  assert.equal((validateQuoteRequest(body, c, 0) as { reason: string }).reason, "bad-invite");
  const v = validateQuoteRequest(body, c, 0, new Set(["OVR-ABC123"]));
  assert.ok(v.ok);
});

test("validation: unknown vault, leg count, stake cap, lockout", () => {
  const c = cfg();
  const unknown = { ...goodBody, legs: [{ vault: TAKER, isYes: true }, { vault: V2, isYes: false }] };
  assert.equal((validateQuoteRequest(unknown, c, 0) as { reason: string }).reason, "unknown-vault");
  const one = { ...goodBody, legs: [{ vault: V1, isYes: true }] };
  assert.equal((validateQuoteRequest(one, c, 0) as { reason: string }).reason, "bad-leg-count");
  const fat = { ...goodBody, stake: "10000001" };
  assert.equal((validateQuoteRequest(fat, c, 0) as { reason: string }).reason, "stake-too-big");
  // V2 expiryMs = 2_000_000, lockout 600_000 -> refuse from t = 1_400_000
  assert.equal((validateQuoteRequest(goodBody, c, 1_500_000) as { reason: string }).reason, "expiry-lockout");
});

test("settled leg: 409", async () => {
  const d = deps({ readSettled: async () => new Set([V1.toLowerCase()]) });
  const r = await handleQuote(d, goodBody);
  assert.equal(r.status, 409);
});

test("book fetch failure: 503, nothing reserved", async () => {
  const d = deps({ fetchLegPriceWad: async () => { throw new Error("down"); } });
  const r = await handleQuote(d, goodBody);
  assert.equal(r.status, 503);
  assert.equal(d.exposure.reservedGlobal(d.now()), 0n);
});

test("at-capacity: 409, metrics counted", async () => {
  const d = deps({ readAllowance: async () => 1_000_000n }); // risk ~7.4M > 1_000_000
  const r = await handleQuote(d, goodBody);
  assert.equal(r.status, 409);
  assert.equal(d.metrics.rejected["at-capacity"], 1);
  assert.equal(d.exposure.reservedGlobal(d.now()), 0n);
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

test("HTTP smoke: /quote, /health, /metrics, bad-json, unknown route", async () => {
  const d = deps();
  const server = startServer(d, 0, () => ({ ok: true }));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const badJson = await fetch(`${base}/quote`, { method: "POST", body: "{not json" });
    assert.equal(badJson.status, 400);
    assert.deepEqual(await badJson.json(), { error: "bad-json" });

    const quoteRes = await fetch(`${base}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(goodBody),
    });
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
  } finally {
    server.close();
  }
});

test("GET /markets serves registry verbatim with CORS", async () => {
  const registryJson = '{"markets":[{"vault":"0x1111111111111111111111111111111111111111","title":"T","category":"c","coinYes":"#10","coinNo":"#11","underlying":"BTC","cluster":"crypto"}]}';
  const d = deps({ cfg: cfg({ registryJson }) });
  const server = startServer(d, 0, () => ({ ok: true }));
  const port = (server.address() as AddressInfo).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/markets`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.equal(await r.text(), registryJson);
  } finally {
    server.close();
  }
});

test("OPTIONS preflight returns 204 with CORS headers", async () => {
  const server = startServer(deps(), 0, () => ({ ok: true }));
  const port = (server.address() as AddressInfo).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/quote`, { method: "OPTIONS" });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.match(r.headers.get("access-control-allow-headers") ?? "", /content-type/i);
  } finally {
    server.close();
  }
});

test("HTTP smoke: oversized body rejected with 413, server keeps serving", async () => {
  const d = deps();
  const server = startServer(d, 0, () => ({ ok: true }));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const huge = "a".repeat(65 * 1024);
    let big: Response | undefined;
    try {
      big = await fetch(`${base}/quote`, { method: "POST", body: huge });
    } catch {
      // Destroying the socket mid-request can also surface as a fetch failure — acceptable.
    }
    if (big) {
      assert.equal(big.status, 413);
      assert.deepEqual(await big.json(), { error: "body-too-large" });
    }

    const quoteRes = await fetch(`${base}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(goodBody),
    });
    assert.equal(quoteRes.status, 200);
  } finally {
    server.close();
  }
});
