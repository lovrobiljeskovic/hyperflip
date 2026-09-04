import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Address, Hex } from "viem";
import { currentModelStatus, handleQuote, sameGameLeg, validateQuoteRequest, newMetrics, startServer, type QuoteDeps } from "../src/server.js";
import { ExposureBook } from "../src/exposure.js";
import { RateLimiter } from "../src/waitlist.js";
import { jointProbWad, parseCorrelations } from "../src/correlation.js";
import { WAD } from "../src/pure.js";
import type { WriterConfig } from "../src/config.js";
import { quoteDigest } from "../src/quotes.js";
import { loadResearchNetworkProfile } from "../src/research/network.js";
import type { QuoteDecision } from "../src/research/types.js";

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
const RESEARCH_PROFILE = loadResearchNetworkProfile(new URL("../../registry/research-network.testnet.json", import.meta.url).pathname);
const UNDERLYINGS = ["BTC", "ETH", "NVDA", "SP500", "GOLD"];
const pair = (a: string, b: string) => [a, b].sort().join(":");
const MODEL: WriterConfig["model"] = {
  artifactKind: "champion", network: "testnet", profileSha256: RESEARCH_PROFILE.profileSha256,
  version: "fixture", dataAsOf: "2026-08-28T00:00:00.000Z", dataManifestSha256: "a".repeat(64), sourceRegistrySha256: "b".repeat(64),
  marketRegistrySha256: RESEARCH_PROFILE.marketRegistrySha256, deploymentRegistrySha256: RESEARCH_PROFILE.deploymentRegistrySha256,
  baselineCorrelationSha256: RESEARCH_PROFILE.baselineCorrelationSha256, artifactSha256: "d".repeat(64), validationSha256: "e".repeat(64), validationState: "Supported", identityFailureReason: null,
  ageMs: 0, multiAssetEnabled: true, eligibleUnderlyings: new Set(UNDERLYINGS), quarantinedUnderlyings: new Map(), fallbackEligible: new Set(),
  pairEligibility: new Map(UNDERLYINGS.flatMap((left, index) => UNDERLYINGS.slice(index + 1).map((right) => [pair(left, right), { status: "direct" as const, reason: "fixture", correlation: 0.1 }]))),
};

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
    pricingMode: "correlated",
    rpcUrl: "", parlayVault: V1, writerAddress: TAKER,
    quoteSignerKey: `0x${"11".repeat(32)}` as `0x${string}`,
    pokerKey: `0x${"22".repeat(32)}` as `0x${string}`,
    infoApiUrl: "", researchRoot: "/tmp", researchProfile: RESEARCH_PROFILE, researchPersistence: {} as WriterConfig["researchPersistence"], port: 0, edgeBps: 0n, minPremiumBps: 100n, minLegs: 2,
    maxStake: 10_000_000n, perMarketCap: 1_000_000_000n, perClusterCap: 1_000_000_000n,
    perCodeReservedCap: 1_000_000_000n,
    rhoBandPct: 0.2, correlations: CORRELATIONS, model: MODEL, legEdgeBps: 0n, quoteTtlMs: 30_000,
    spotPxStaleMs: 60_000,
    minBookDepthWad: 0n,
    lockoutMs: 600_000, pokerIntervalMs: 15_000, deployBlock: 0n,
    inviteCodes: new Set(["beta-test"]),
    waitlistFile: "/dev/null",
    corsOrigins: ["https://overround.xyz"],
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
    fetchLegPrice: async () => ({ priceWad: WAD / 2n, source: "l2Book", observedAtMs: 1_000_000, depthWad: WAD, vwapWad: WAD / 2n, freshnessMs: null }),
    recordQuote: async () => {},
    bestEstimateJointProbWad: (legs) => Promise.resolve(jointProbWad(legs, c.correlations, 0)),
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

test("best-estimate worker failure returns pricing-unavailable before reservation or signing", async () => {
  let signed = false;
  const d = deps({
    bestEstimateJointProbWad: async () => { throw new Error("worker down"); },
    sign: async () => { signed = true; return "0xsig" as Hex; },
  });
  const r = await handleQuote(d, goodBody);
  assert.deepEqual(r, { status: 503, json: { error: "pricing-unavailable" } });
  assert.equal(signed, false);
  assert.equal(d.exposure.reservedGlobal(d.now()), 0n);
});

test("same-underlying quote succeeds while the correlation worker is unavailable", async () => {
  let workerCalled = false;
  const d = deps({
    bestEstimateJointProbWad: async () => { workerCalled = true; throw new Error("worker down"); },
  });
  const result = await handleQuote(d, body({ legs: [legOn(BTC_VAULT_A, true), legOn(BTC_VAULT_B, true)] }));
  assert.equal(result.status, 200);
  assert.equal(workerCalled, false);
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
  const skewedPrices = async (l: { vault: Address }) => ({
    priceWad: l.vault.toLowerCase() === NVDA_VAULT.toLowerCase() ? (WAD * 1318n) / 10000n : (WAD * 4405n) / 10000n,
    source: "l2Book" as const, observedAtMs: 1_000_000, depthWad: WAD, vwapWad: WAD / 2n, freshnessMs: null,
  });
  const d = deps({ cfg: cfg({ edgeBps: 500n, legEdgeBps: 300n }), fetchLegPrice: skewedPrices });
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

test("breakdown reports fallback correlation evidence to clients", async () => {
  const model = {
    ...MODEL,
    fallbackEligible: new Set(["BTC", "ETH"]),
    pairEligibility: new Map([[pair("BTC", "ETH"), { status: "fallback" as const, reason: "operator-reviewed", correlation: 0.1 }]]),
  };
  const res = await handleQuote(deps({ cfg: cfg({ model }) }), goodBody);
  assert.equal(res.status, 200);
  assert.deepEqual((res.json as { breakdown: { pairDecisions: unknown } }).breakdown.pairDecisions, [
    { pair: ["BTC", "ETH"], status: "fallback", reason: "operator-reviewed" },
  ]);
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

test("correlation eligibility rejects stale, missing, ineligible, quarantined, and absent pairs through request validation", () => {
  const cases: WriterConfig["model"][] = [
    { ...MODEL, multiAssetEnabled: false },
    { ...MODEL, eligibleUnderlyings: new Set(["BTC"]) },
    { ...MODEL, quarantinedUnderlyings: new Map([["ETH", "stale"]]) },
    { ...MODEL, pairEligibility: new Map() },
    { ...MODEL, pairEligibility: new Map([[pair("BTC", "ETH"), { status: "fallback", reason: "fixture", correlation: 0.1 }]]) },
  ];
  for (const model of cases) {
    assert.deepEqual(validateQuoteRequest(goodBody, cfg({ model }), 1_000_000), { ok: false, status: 400, reason: "correlation-unavailable" });
  }
});

test("model age and multi-asset eligibility advance at request and health time without a restart", () => {
  const model = { ...MODEL, dataAsOf: new Date(0).toISOString(), ageMs: 0, multiAssetEnabled: true };
  const request = body({ legs: [legOn(BTC_VAULT_A, true), legOn(NVDA_VAULT, true)] });
  assert.equal(validateQuoteRequest(request, cfg({ model }), 7 * 86_400_000 - 1).ok, true);
  assert.deepEqual(validateQuoteRequest(request, cfg({ model }), 7 * 86_400_000), { ok: false, status: 400, reason: "correlation-unavailable" });
  assert.deepEqual(currentModelStatus(model, 1), { ageMs: 1, multiAssetEnabled: true });
  assert.deepEqual(currentModelStatus(model, 7 * 86_400_000), { ageMs: 7 * 86_400_000, multiAssetEnabled: false });
});

test("correlation eligibility admits only explicit operator-approved fallback pairs", () => {
  const model = {
    ...MODEL,
    fallbackEligible: new Set(["BTC", "ETH"]),
    pairEligibility: new Map([[pair("BTC", "ETH"), { status: "fallback" as const, reason: "operator-reviewed", correlation: 0.1 }]]),
  };
  assert.equal(validateQuoteRequest(goodBody, cfg({ model }), 1_000_000).ok, true);
});

test("correlation eligibility checks every pair in a multi-underlying ticket", () => {
  const three = body({ legs: [legOn(BTC_VAULT_A, true), legOn(V2, true), legOn(NVDA_VAULT, true)] });
  const pairEligibility = new Map(MODEL.pairEligibility);
  pairEligibility.delete(pair("ETH", "NVDA"));
  assert.deepEqual(validateQuoteRequest(three, cfg({ model: { ...MODEL, pairEligibility } }), 1_000_000), { ok: false, status: 400, reason: "correlation-unavailable" });
});

test("same-underlying tickets remain eligible when multi-asset correlation is disabled", () => {
  const same = body({ legs: [legOn(BTC_VAULT_A, true), legOn(BTC_VAULT_B, false)] });
  assert.equal(validateQuoteRequest(same, cfg({ model: { ...MODEL, multiAssetEnabled: false, eligibleUnderlyings: new Set() } }), 1_000_000).ok, true);
});

test("band markets remain unavailable in cross-underlying correlation tickets", () => {
  const mixed = body({ legs: [legOn(BAND_VAULT, true), legOn(BTC_VAULT_A, true)] });
  assert.deepEqual(validateQuoteRequest(mixed, cfg(), 1_000_000), { ok: false, status: 400, reason: "correlation-unavailable" });
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
  // A traded book resting exactly at 0.5 is a real price.
  const traded = deps({ fetchLegPrice: async () => ({ priceWad: WAD / 2n, source: "l2Book", observedAtMs: 1_000_000, depthWad: WAD, vwapWad: WAD / 2n, freshnessMs: null }) });
  assert.equal((await handleQuote(traded, goodBody)).status, 200);
});

test("at-capacity: 409, metrics counted", async () => {
  const d = deps({ readAllowance: async () => 1_000_000n }); // risk ~7.4M > 1_000_000
  const r = await handleQuote(d, goodBody);
  assert.equal(r.status, 409);
  assert.equal(d.metrics.rejected["at-capacity"], 1);
  assert.equal(d.exposure.reservedGlobal(d.now()), 0n);
});

test("quota-cap: 409 once one invite code's unminted reservations hit their cap; a second code is unaffected", async () => {
  const OTHER_TAKER = "0x4444444444444444444444444444444444444444" as Address;
  // goodBody's risk is 7_422_341n (see the happy-path test); cap it just under
  // that so a second quote on the same code trips the quota gate.
  const d = deps({ cfg: cfg({ perCodeReservedCap: 7_422_341n, inviteCodes: new Set(["beta-test", "beta-test-2"]) }) });
  const first = await handleQuote(d, goodBody);
  assert.equal(first.status, 200);
  const second = await handleQuote(d, goodBody);
  assert.equal(second.status, 409);
  assert.deepEqual(second.json, { error: "quota-cap", maxStake: "0" });
  assert.equal(d.metrics.rejected["quota-cap"], 1);
  // Rotating the taker address does NOT reset the budget — the code is the
  // quota identity (mainnet-hardening P0-4 re-key: address rotation is free,
  // codes are not).
  const spoofed = await handleQuote(d, { ...goodBody, taker: OTHER_TAKER });
  assert.equal(spoofed.status, 409);
  // A different valid invite code, same market/cluster headroom, is unaffected.
  const otherCode = await handleQuote(d, { ...goodBody, inviteCode: "beta-test-2" });
  assert.equal(otherCode.status, 200);
});

test("quota-cap: reservation expiry frees the taker's budget for a new quote", async () => {
  const d = deps({ cfg: cfg({ perCodeReservedCap: 7_422_341n }) });
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
  const response = r.json as { quote: { quoteId: Hex; premium: string; maxPayout: string; deadline: string; legs: { vault: Address; isYes: boolean }[] } };
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
  const decision = recorded as QuoteDecision;
  const btc = CORRELATIONS.underlyings.BTC;
  const eth = CORRELATIONS.underlyings.ETH;
  const nominalPricingCorrelation = btc.global * eth.global + btc.cluster * eth.cluster;
  assert.notEqual(nominalPricingCorrelation, 0.1, "fixture must distinguish fitted pricing correlation from evidence correlation");
  assert.deepEqual({
    artifactKind: decision.artifactKind,
    artifactSha256: decision.artifactSha256,
    validationSha256: decision.validationSha256,
    validationState: decision.validationState,
    pairDecisions: decision.pairDecisions,
  }, {
    artifactKind: "champion",
    artifactSha256: MODEL.artifactSha256,
    validationSha256: MODEL.validationSha256,
    validationState: "Supported",
    pairDecisions: [{ pair: ["BTC", "ETH"], status: "direct", reason: "fixture", correlation: nominalPricingCorrelation, evidenceCorrelation: 0.1 }],
  });
  assert.equal(
    (recorded as { quoteDigest: string }).quoteDigest,
    quoteDigest(d.chainId, d.cfg.parlayVault, {
      taker: TAKER,
      legs: response.quote.legs,
      premium: BigInt(response.quote.premium),
      maxPayout: BigInt(response.quote.maxPayout),
      deadline: BigInt(response.quote.deadline),
      quoteId: response.quote.quoteId,
    }),
  );
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

test("OPTIONS preflight returns 204 with CORS headers for an allowed origin", async () => {
  const server = startServer(deps(), 0, () => ({ ok: true }));
  const port = (server.address() as AddressInfo).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/quote`, {
      method: "OPTIONS",
      headers: { origin: "https://overround.xyz" },
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), "https://overround.xyz");
    assert.match(r.headers.get("access-control-allow-headers") ?? "", /content-type/i);
  } finally {
    server.close();
  }
});

test("OPTIONS preflight still 204s with no Origin header (no ACAO to echo)", async () => {
  const server = startServer(deps(), 0, () => ({ ok: true }));
  const port = (server.address() as AddressInfo).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/quote`, { method: "OPTIONS" });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  } finally {
    server.close();
  }
});

test("OPTIONS /markets preflight stays open (*), not locked to the allowlist", async () => {
  const server = startServer(deps(), 0, () => ({ ok: true }));
  const port = (server.address() as AddressInfo).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/markets`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
  } finally {
    server.close();
  }
});

test("POST /quote: disallowed origin still gets Vary: Origin (response is origin-dependent either way)", async () => {
  const d = deps();
  const server = startServer(d, 0, () => ({ ok: true }));
  const port = (server.address() as AddressInfo).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify(goodBody),
    });
    assert.equal(r.headers.get("access-control-allow-origin"), null);
    assert.equal(r.headers.get("vary"), "Origin");
  } finally {
    server.close();
  }
});

test("POST /quote: allowed origin gets ACAO echo", async () => {
  const d = deps();
  const server = startServer(d, 0, () => ({ ok: true }));
  const port = (server.address() as AddressInfo).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://overround.xyz" },
      body: JSON.stringify(goodBody),
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), "https://overround.xyz");
  } finally {
    server.close();
  }
});

test("POST /quote: disallowed origin gets no ACAO (browser would block) but request still succeeds server-side", async () => {
  const d = deps();
  const server = startServer(d, 0, () => ({ ok: true }));
  const port = (server.address() as AddressInfo).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify(goodBody),
    });
    assert.equal(r.status, 200); // CORS is browser-enforcement only — fetch() here ignores it, like curl would.
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  } finally {
    server.close();
  }
});

test("POST /quote: no Origin header (CLI/curl caller) is unaffected — no ACAO, request proceeds", async () => {
  const d = deps();
  const server = startServer(d, 0, () => ({ ok: true }));
  const port = (server.address() as AddressInfo).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(goodBody),
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), null);
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

// ---------------------------------------------------------------------------
// Independent pricing mode (sports beta): legs multiply, cross-game tickets
// never wait on a correlation model, same-game / same-question legs refuse.

const MATCH_A = "0xaaaa000000000000000000000000000000000001" as Address; // q844: Saudi Arabia
const MATCH_DRAW = "0xaaaa000000000000000000000000000000000002" as Address; // q844: Draw
const MATCH_B_OTHER = "0xaaaa000000000000000000000000000000000003" as Address; // q845: Iran
const GAME_OU = "0xaaaa000000000000000000000000000000000004" as Address; // standalone O/U on the q844 game
const GAME_STANDALONE = "0xaaaa000000000000000000000000000000000005" as Address; // MLB winner, 2-way

const SPORTS_MARKETS = new Map<string, WriterConfig["markets"] extends Map<string, infer M> ? M : never>([
  [MATCH_A.toLowerCase(), { vault: MATCH_A, coinYes: "#1", coinNo: "#2", underlying: "q844", cluster: "WC2026", direction: "up" as const, title: "Saudi Arabia", category: "sports", question: 844, group: "q844", groupTitle: "Saudi Arabia vs Uruguay", startMs: 5_000_000, expiryMs: 9_000_000 }],
  [MATCH_DRAW.toLowerCase(), { vault: MATCH_DRAW, coinYes: "#3", coinNo: "#4", underlying: "q844", cluster: "WC2026", direction: "up" as const, title: "Draw", category: "sports", question: 844, group: "q844", groupTitle: "Saudi Arabia vs Uruguay" }],
  [MATCH_B_OTHER.toLowerCase(), { vault: MATCH_B_OTHER, coinYes: "#5", coinNo: "#6", underlying: "q845", cluster: "WC2026", direction: "up" as const, title: "Iran", category: "sports", question: 845, group: "q845", groupTitle: "Iran vs New Zealand" }],
  [GAME_OU.toLowerCase(), { vault: GAME_OU, coinYes: "#7", coinNo: "#8", underlying: "q844", cluster: "WC2026", direction: "up" as const, title: "Over 1.5 goals", category: "sports", sideYes: "Over", sideNo: "Under" }],
  [GAME_STANDALONE.toLowerCase(), { vault: GAME_STANDALONE, coinYes: "#9", coinNo: "#10", underlying: "MIN-BAL-20260812", cluster: "MLB", direction: "up" as const, title: "Twins vs Orioles", category: "sports", sideYes: "Twins", sideNo: "Orioles" }],
]);

function sportsCfg(overrides: Partial<WriterConfig> = {}): WriterConfig {
  // Model deliberately disabled and empty: independent mode must not consult it.
  return cfg({ pricingMode: "independent", rhoBandPct: 0, markets: SPORTS_MARKETS, model: { ...MODEL, multiAssetEnabled: false, eligibleUnderlyings: new Set(), pairEligibility: new Map() }, ...overrides });
}

test("independent mode: cross-game legs quote as the product of their prices without a correlation model", async () => {
  const d = deps({ cfg: sportsCfg(), bestEstimateJointProbWad: async () => { throw new Error("must not be called"); } });
  const r = await handleQuote(d, body({ legs: [legOn(MATCH_A, true), legOn(GAME_STANDALONE, false)] }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const j = r.json as { quote: { maxPayout: string }; breakdown: { jointProbWad: string; bestEstimateJointProbWad: string; pairDecisions: unknown[] } };
  // 0.5 * 0.5 = 0.25, zero edge -> 4x on a 1 USDC stake
  assert.equal(j.breakdown.jointProbWad, (WAD / 4n).toString());
  assert.equal(j.breakdown.bestEstimateJointProbWad, j.breakdown.jointProbWad);
  assert.equal(j.quote.maxPayout, "4000000");
  assert.deepEqual(j.breakdown.pairDecisions, []);
});

test("independent mode: two legs on one question (A + Draw) are refused as same-game", () => {
  const c = sportsCfg();
  assert.deepEqual(validateQuoteRequest(body({ legs: [legOn(MATCH_A, true), legOn(MATCH_DRAW, true)] }), c, 0), { ok: false, status: 400, reason: "same-game" });
  // Opposite sides of two outcomes in one question are near-redundant, not independent: still refused.
  assert.deepEqual(validateQuoteRequest(body({ legs: [legOn(MATCH_A, true), legOn(MATCH_DRAW, false)] }), c, 0), { ok: false, status: 400, reason: "same-game" });
  assert.equal(sameGameLeg([legOn(MATCH_A, true), legOn(MATCH_DRAW, true)], c), MATCH_DRAW);
});

test("independent mode: a winner leg plus an over/under on the same game is refused as same-game", () => {
  const c = sportsCfg();
  assert.deepEqual(validateQuoteRequest(body({ legs: [legOn(MATCH_A, true), legOn(GAME_OU, true)] }), c, 0), { ok: false, status: 400, reason: "same-game" });
  // Different games in the same competition are fine.
  assert.equal(validateQuoteRequest(body({ legs: [legOn(MATCH_A, true), legOn(MATCH_B_OTHER, true)] }), c, 0).ok, true);
});

test("independent mode: quoting locks out at kickoff (startMs), not at the resolution deadline", () => {
  const c = sportsCfg();
  const ticket = body({ legs: [legOn(MATCH_A, true), legOn(GAME_STANDALONE, true)] });
  // startMs 5_000_000, lockout 600_000 -> refuse from 4_400_000 even though expiryMs is 9_000_000
  assert.equal(validateQuoteRequest(ticket, c, 4_399_999).ok, true);
  assert.deepEqual(validateQuoteRequest(ticket, c, 4_400_000), { ok: false, status: 400, reason: "expiry-lockout" });
});

test("correlated mode still refuses cross-underlying tickets without model evidence (independence is opt-in)", () => {
  const c = cfg({ markets: SPORTS_MARKETS, model: { ...MODEL, multiAssetEnabled: false, eligibleUnderlyings: new Set(), pairEligibility: new Map() } });
  assert.deepEqual(validateQuoteRequest(body({ legs: [legOn(MATCH_A, true), legOn(GAME_STANDALONE, true)] }), c, 0), { ok: false, status: 400, reason: "correlation-unavailable" });
});
