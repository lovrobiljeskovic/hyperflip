import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Address, Hex } from "viem";
import { handleQuote, validateQuoteRequest, newMetrics, startServer, type QuoteDeps } from "../src/server.js";
import { ExposureBook } from "../src/exposure.js";
import { WAD } from "../src/pure.js";
import type { WriterConfig } from "../src/config.js";

const V1 = "0x1111111111111111111111111111111111111111" as Address;
const V2 = "0x2222222222222222222222222222222222222222" as Address;
const TAKER = "0x3333333333333333333333333333333333333333" as Address;

function cfg(overrides: Partial<WriterConfig> = {}): WriterConfig {
  return {
    rpcUrl: "", parlayVault: V1, writerAddress: TAKER,
    quoteSignerKey: `0x${"11".repeat(32)}` as `0x${string}`,
    pokerKey: `0x${"22".repeat(32)}` as `0x${string}`,
    infoApiUrl: "", port: 0, edgeBps: 0n, minPremiumBps: 100n, minLegs: 2,
    maxStake: 10_000_000n, perMarketCap: 1_000_000_000n, quoteTtlMs: 30_000,
    lockoutMs: 600_000, pokerIntervalMs: 15_000, deployBlock: 0n,
    markets: new Map([
      [V1.toLowerCase(), { vault: V1, coinYes: "+10", coinNo: "+11" }],
      [V2.toLowerCase(), { vault: V2, coinYes: "+20", coinNo: "+21", expiryMs: 2_000_000 }],
    ]),
    ...overrides,
  };
}

function deps(overrides: Partial<QuoteDeps> = {}): QuoteDeps {
  return {
    cfg: cfg(),
    exposure: new ExposureBook(),
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

const goodBody = { taker: TAKER, legs: [{ vault: V1, isYes: true }, { vault: V2, isYes: false }], stake: "1000000" };

test("happy path: returns signed quote, reserves exposure", async () => {
  const d = deps();
  const r = await handleQuote(d, goodBody);
  assert.equal(r.status, 200);
  const j = r.json as { quote: { premium: string; maxPayout: string; deadline: string }; sig: string };
  assert.equal(j.quote.premium, "1000000");
  assert.equal(j.quote.maxPayout, "4000000"); // 0.5 * 0.5, zero edge
  assert.equal(j.quote.deadline, "1030"); // (1_000_000 + 30_000) ms -> seconds
  assert.equal(j.sig, "0xsig");
  assert.equal(d.exposure.reservedGlobal(d.now()), 3_000_000n); // maxPayout - premium
  assert.equal(d.metrics.quoted, 1);
});

test("validation: duplicate vault rejected", () => {
  const r = validateQuoteRequest(
    { taker: TAKER, legs: [{ vault: V1, isYes: true }, { vault: V1, isYes: false }], stake: "1000000" },
    cfg(), 0,
  );
  assert.deepEqual(r, { ok: false, status: 400, reason: "duplicate-vault" });
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
  const d = deps({ readAllowance: async () => 1_000_000n }); // risk 3_000_000 > 1_000_000
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
