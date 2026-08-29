import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertCandleRecord,
  assertDataManifest,
  assertJoinedEventRecord,
  assertQuoteDecision,
  parseSourceRegistry,
  sourceFor,
} from "../src/research/types.js";
import type { CandleRecord, DataManifest, JoinedEventRecord, SourceEntry } from "../src/research/types.js";

const fixture = (name: string) => new URL(`./fixtures/research/${name}`, import.meta.url);

const btcSource = {
  schemaVersion: 1,
  underlying: "BTC",
  sourceNetwork: "testnet",
  sourceCoin: "BTC",
  cluster: "crypto",
  calendar: "continuous",
  measurementEnabled: true,
  fallbackEligible: true,
} satisfies SourceEntry;

test("source registry rejects duplicates and more than twenty underlyings", () => {
  assert.throws(() => parseSourceRegistry(readFileSync(fixture("sources-invalid-over-cap.json"), "utf8")), /at most 20/);
  assert.throws(() => parseSourceRegistry(JSON.stringify({ schemaVersion: 2, network: "testnet", sources: [btcSource, btcSource] })), /duplicate underlying/);
});

test("source registry maps the active logical set and looks it up by underlying", () => {
  const registry = parseSourceRegistry(readFileSync(new URL("../../registry/correlation-sources.json", import.meta.url), "utf8"));
  assert.deepEqual(registry.sources.map((source) => source.underlying), ["BTC", "ETH", "SOL", "HYPE", "ZEC", "NVDA", "SP500", "SNDK", "TSLA", "AAPL", "GOLD"]);
  assert.deepEqual(sourceFor(registry, "BTC"), btcSource);
  assert.equal(sourceFor(registry, "NVDA")?.sourceCoin, "xyz:NVDA");
  assert.equal(sourceFor(registry, "DOGE"), undefined);
});

test("source registry rejects unknown versions, duplicate source coins, and malformed sessions", () => {
  assert.throws(() => parseSourceRegistry(JSON.stringify({ schemaVersion: 3, network: "testnet", sources: [btcSource] })), /schemaVersion/);
  assert.throws(() => parseSourceRegistry(JSON.stringify({ schemaVersion: 2, network: "testnet", sources: [{ ...btcSource, cluster: "rates" }] })), /cluster/);
  assert.throws(
    () => parseSourceRegistry(JSON.stringify({ schemaVersion: 2, network: "testnet", sources: [btcSource, { ...btcSource, underlying: "WBTC" }] })),
    /duplicate source coin/,
  );
  assert.throws(
    () => parseSourceRegistry(JSON.stringify({ schemaVersion: 2, network: "testnet", sources: [{ ...btcSource, calendar: "session", session: { timeZone: "UTC", weekdays: [1], openLocal: "09:00", closeLocal: "09:00", closedDates: [] } }] })),
    /session/,
  );
  assert.throws(
    () => parseSourceRegistry(JSON.stringify({ schemaVersion: 2, network: "testnet", sources: [{ ...btcSource, underlying: "../escape" }] })),
    /underlying.*safe filename/i,
  );
});

test("CandleRecord validation blocks unsafe millisecond timestamps before persistence", () => {
  assert.throws(
    () => assertCandleRecord({ openTimeMs: 9007199254740992 } as CandleRecord),
    /openTimeMs must be a safe integer millisecond timestamp/,
  );
});

test("CandleRecord validation rejects foreign or mismatched source identities", () => {
  const candle: CandleRecord = {
    schemaVersion: 1, source: "hyperliquid-info", sourceNetwork: "testnet", underlying: "BTC", sourceCoin: "BTC", interval: "1h",
    openTimeMs: 3_600_000, closeTimeMs: 7_199_999, open: "100", high: "110", low: "90", close: "105", volume: "1", tradeCount: 1, retrievedAtMs: 7_200_000,
  };
  for (const mutation of [
    { sourceNetwork: "mainnet" },
    { underlying: "ETH" },
    { sourceCoin: "ETH" },
    { interval: "4h" },
    { source: "foreign" },
    { high: "99" },
  ]) assert.throws(() => assertCandleRecord({ ...candle, ...mutation } as CandleRecord, btcSource), /candle record/i);
});

test("DataManifest validation blocks noncanonical SHA-256 hashes before persistence", () => {
  assert.throws(
    () => assertDataManifest({ sourceRegistrySha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } as DataManifest),
    /sourceRegistrySha256 must be a lowercase 64-character hex hash/,
  );
});

test("DataManifest requires schema v2 network and profile identity", () => {
  const manifest = {
    schemaVersion: 1,
    createdAt: "2026-08-29T00:00:00.000Z",
    sourceRegistrySha256: "a".repeat(64),
    sourceRange: { fromMs: 0, toMs: 0 },
    underlyings: {},
    files: [],
  } as unknown as DataManifest;
  assert.throws(() => assertDataManifest(manifest), /schemaVersion must be 2/);
  assert.throws(() => assertDataManifest({ ...manifest, schemaVersion: 2 } as DataManifest), /network/);
  assert.throws(() => assertDataManifest({ ...manifest, schemaVersion: 2, network: "testnet" } as DataManifest), /profileSha256/);
});

test("QuoteDecision validation blocks raw signature hashes before persistence", () => {
  assert.throws(
    () => assertQuoteDecision({
      schemaVersion: 3,
      network: "testnet",
      profileSha256: "a".repeat(64),
      marketRegistrySha256: "a".repeat(64),
      deploymentRegistrySha256: "a".repeat(64),
      baselineCorrelationSha256: "a".repeat(64),
      artifactKind: "champion",
      artifactSha256: "a".repeat(64),
      validationSha256: "a".repeat(64),
      validationState: "Supported",
      pairDecisions: [],
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

test("JoinedEventRecord validation requires the exact persisted union wire shapes", () => {
  const identity = { schemaVersion: 2 as const, network: "testnet" as const, profileSha256: "a".repeat(64), deploymentRegistrySha256: "b".repeat(64) };
  const chain: JoinedEventRecord = {
    ...identity, kind: "minted", eventKey: "0xtx:0", blockNumber: "1", blockHash: "0xblock", transactionHash: "0xtx", logIndex: 0,
    quoteId: "0xquote", parlayId: "1", taker: "0xtaker", premium: "1", maxPayout: "4", status: "open",
    legs: [{ vault: "0xvault", isYes: true, settled: false, settleFractionWad: null, result: "pending" }], recordedAtMs: 0,
  };
  const observation: JoinedEventRecord = {
    ...identity, kind: "leg-finalized", observationKey: "1:0xvault:1:0xblock", observedBlockNumber: "1", observedBlockHash: "0xblock",
    quoteId: "0xquote", parlayId: "1", vault: "0xvault", settleFractionWad: "1000000000000000000", result: "win", recordedAtMs: 0,
  };
  const correction: JoinedEventRecord = {
    ...identity, kind: "orphaned", targetKind: "chain-log", targetKey: "0xtx:0", detectedAtBlockNumber: "2", canonicalBlockHash: "0xnew", recordedAtMs: 0,
  };
  assert.doesNotThrow(() => [chain, observation, correction].forEach(assertJoinedEventRecord));
  assert.throws(() => assertJoinedEventRecord({ ...chain, kind: "unknown" } as unknown as JoinedEventRecord), /kind/);
  const withoutEventKey = { ...chain } as Record<string, unknown>;
  delete withoutEventKey.eventKey;
  assert.throws(() => assertJoinedEventRecord(withoutEventKey as unknown as JoinedEventRecord), /eventKey/);
  assert.throws(() => assertJoinedEventRecord({ ...observation, extra: true } as unknown as JoinedEventRecord), /unknown field/);
});
