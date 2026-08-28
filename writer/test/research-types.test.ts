import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertCandleRecord,
  assertDataManifest,
  assertQuoteDecision,
  parseSourceRegistry,
  sourceFor,
} from "../src/research/types.js";
import type { CandleRecord, DataManifest } from "../src/research/types.js";

const fixture = (name: string) => new URL(`./fixtures/research/${name}`, import.meta.url);

const btcSource = {
  schemaVersion: 1,
  underlying: "BTC",
  sourceNetwork: "mainnet",
  sourceCoin: "BTC",
  cluster: "crypto",
  calendar: "continuous",
  eligible: true,
  fallbackEligible: false,
};

test("source registry rejects duplicates and more than twenty underlyings", () => {
  assert.throws(() => parseSourceRegistry(readFileSync(fixture("sources-invalid-over-cap.json"), "utf8")), /at most 20/);
  assert.throws(() => parseSourceRegistry(JSON.stringify({ schemaVersion: 1, sources: [btcSource, btcSource] })), /duplicate underlying/);
});

test("source registry maps the active logical set and looks it up by underlying", () => {
  const registry = parseSourceRegistry(readFileSync(new URL("../../registry/correlation-sources.json", import.meta.url), "utf8"));
  assert.deepEqual(registry.sources.map((source) => source.underlying), ["BTC", "ETH", "SOL", "HYPE", "ZEC", "NVDA", "SP500", "SNDK", "TSLA", "AAPL", "GOLD"]);
  assert.deepEqual(sourceFor(registry, "BTC"), btcSource);
  assert.equal(sourceFor(registry, "NVDA")?.sourceCoin, "xyz:NVDA");
  assert.equal(sourceFor(registry, "DOGE"), undefined);
});

test("source registry rejects unknown versions, duplicate source coins, and malformed sessions", () => {
  assert.throws(() => parseSourceRegistry(JSON.stringify({ schemaVersion: 2, sources: [btcSource] })), /schemaVersion/);
  assert.throws(() => parseSourceRegistry(JSON.stringify({ schemaVersion: 1, sources: [{ ...btcSource, cluster: "rates" }] })), /cluster/);
  assert.throws(
    () => parseSourceRegistry(JSON.stringify({ schemaVersion: 1, sources: [btcSource, { ...btcSource, underlying: "WBTC" }] })),
    /duplicate source coin/,
  );
  assert.throws(
    () => parseSourceRegistry(JSON.stringify({ schemaVersion: 1, sources: [{ ...btcSource, calendar: "session", session: { timeZone: "UTC", weekdays: [1], openLocal: "09:00", closeLocal: "09:00", closedDates: [] } }] })),
    /session/,
  );
});

test("CandleRecord validation blocks unsafe millisecond timestamps before persistence", () => {
  assert.throws(
    () => assertCandleRecord({ openTimeMs: 9007199254740992 } as CandleRecord),
    /openTimeMs must be a safe integer millisecond timestamp/,
  );
});

test("DataManifest validation blocks noncanonical SHA-256 hashes before persistence", () => {
  assert.throws(
    () => assertDataManifest({ sourceRegistrySha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } as DataManifest),
    /sourceRegistrySha256 must be a lowercase 64-character hex hash/,
  );
});

test("QuoteDecision validation blocks raw signature hashes before persistence", () => {
  assert.throws(
    () => assertQuoteDecision({
      schemaVersion: 1,
      recordedAtMs: 0,
      quoteId: "quote-1",
      quoteDigest: "digest",
      chainId: 1,
      parlayVault: "vault",
      taker: "taker",
      legs: [],
      bookInputs: [],
      modelVersion: "model-1",
      dataAsOf: "2026-08-28T00:00:00.000Z",
      dataManifestSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sourceRegistrySha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      bestEstimateJointProbWad: "1",
      riskAdjustedJointProbWad: "1",
      rhoBandPct: 0,
      edge: { baseBps: "0", legBps: "0", totalBps: "0" },
      premium: "1",
      maxPayout: "1",
      deadline: "2026-08-28T00:00:00.000Z",
      signatureHash: "raw signature",
    }),
    /signatureHash must be a lowercase 64-character hex hash/,
  );
});
