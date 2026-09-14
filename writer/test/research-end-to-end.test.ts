import assert from "node:assert/strict";
import { readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import type { Address, Hex } from "viem";
import { applyWriterProfileIdentity, loadConfig, parseMarkets, type WriterConfig } from "../src/config.js";
import { ExposureBook } from "../src/exposure.js";
import { WAD } from "../src/pure.js";
import { handleQuote, newMetrics, type QuoteDeps } from "../src/server.js";
import { promoteCandidate } from "../src/research/artifacts.js";
import { backupResearch } from "../src/research/backup.js";
import { calibrate } from "../src/research/calibration.js";
import { collectSources } from "../src/research/candles.js";
import { appendQuoteDecision, joinEvents, type JoinDeps } from "../src/research/journal.js";
import { bindResearchRootIdentity, loadResearchNetworkProfile, type LoadedResearchNetworkProfile } from "../src/research/network.js";
import { writeOperationRecord } from "../src/research/operations.js";
import { openResearchPersistence } from "../src/research/persistence.js";
import { generateReport } from "../src/research/report.js";
import { runReplay } from "../src/research/replay.js";
import { deriveReturns } from "../src/research/returns.js";
import { canonicalJson, readCurrentManifest, sha256 } from "../src/research/store.js";
import type { JoinedEventRecord, SourceEntry, SourceRegistry } from "../src/research/types.js";

const AS_OF = Date.parse("2026-08-28T12:00:00.000Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const TAKER = "0x3333333333333333333333333333333333333333" as Address;
const QUOTE_ID = `0x${"ab".repeat(32)}` as Hex;
const source = (underlying: string, cluster: SourceEntry["cluster"], measurementEnabled: boolean, fallbackEligible: boolean): SourceEntry => ({
  schemaVersion: 1, underlying, sourceNetwork: "testnet", sourceCoin: underlying, cluster, calendar: "session",
  session: { timeZone: "UTC", weekdays: [1, 2, 3, 4], openLocal: "11:00", closeLocal: "12:00", closedDates: [] },
  measurementEnabled, fallbackEligible,
});
const sources: SourceRegistry = { schemaVersion: 2, network: "testnet", sources: [source("BTC", "crypto", true, true), source("ETH", "equity", true, false), source("SOL", "crypto", false, true)] };

function candles(coin: string): string {
  const times = Array.from({ length: 181 }, (_, index) => AS_OF - HOUR - (180 - index) * DAY).filter((time) => [1, 2, 3, 4].includes(new Date(time).getUTCDay()));
  return JSON.stringify(times.map((openTimeMs, index) => {
    const close = coin === "BTC" ? 120 + index * 0.05 + Math.sin(index * 0.71) * 8 : 140 + index * 0.04 + Math.cos(index * 1.13) * 9;
    return { t: openTimeMs, T: openTimeMs + HOUR - 1, s: coin, i: "1h", o: String(close - 0.2), h: String(close + 0.5), l: String(close - 0.5), c: String(close), v: "10", n: 2 };
  }));
}

function profile(root: string): { file: string; loaded: LoadedResearchNetworkProfile } {
  const value = { schemaVersion: 1, network: "testnet", infoApiUrl: "https://api.hyperliquid-testnet.xyz/info", evmChainId: 998, sourceRegistryFile: "sources.json", marketRegistryFile: "markets.json", deploymentRegistryFile: "deployment.json", baselineCorrelationFile: "correlations.json" };
  const file = join(root, "profile.json");
  writeFileSync(file, canonicalJson(value));
  writeFileSync(join(root, "sources.json"), canonicalJson(sources));
  const markets = {
    network: "testnet",
    markets: sources.sources.map(({ underlying, cluster }, index) => ({
      vault: `0x${(index + 1).toString(16).padStart(40, "0")}`,
      coinYes: `#${index * 10 + 1}`, coinNo: `#${index * 10 + 2}`,
      underlying, cluster, direction: "up", title: underlying, category: cluster,
      expiryMs: AS_OF + DAY,
    })),
    archived: [],
  };
  writeFileSync(join(root, "markets.json"), canonicalJson(markets));
  writeFileSync(join(root, "deployment.json"), canonicalJson({
    schemaVersion: 1, network: "testnet", evmChainId: 998,
    parlayVault: "0x9999999999999999999999999999999999999999", parlayDeployBlock: "1",
  }));
  const baseline = {
    network: "testnet", fallbackReason: "operator-reviewed-testnet-bootstrap",
    clusters: {
      crypto: {
        BTC: { global: 0.30, cluster: 0.90, underlying: 0.29 },
        SOL: { global: 0.2954828964376993, cluster: 0.9061475490756113, underlying: 0.2856334665564427 },
      },
      equity: { ETH: { global: 0.30, cluster: 0.92, underlying: 0.20 } },
    },
  };
  writeFileSync(join(root, "correlations.json"), canonicalJson(baseline));
  return { file, loaded: loadResearchNetworkProfile(file) };
}

function filesBelow(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function withWriterEnv<T>(root: string, profileFile: string, run: () => T): T {
  const values: Record<string, string> = {
    PRICING_MODE: "correlated", RESEARCH_REQUIRE_ANCHORED_FS: "0",
    RESEARCH_ROOT: root, RESEARCH_NETWORK_PROFILE_FILE: profileFile, TESTNET_RPC: "http://localhost.invalid", WRITER_ADDRESS: TAKER,
    QUOTE_SIGNER_PRIVATE_KEY: `0x${"11".repeat(32)}`, POKER_PRIVATE_KEY: `0x${"22".repeat(32)}`, MAX_STAKE: "1000000",
    PER_MARKET_CAP: "1000000000", PER_CLUSTER_CAP: "1000000000", PER_CODE_RESERVED_CAP: "1000000000", INVITE_CODES: "fixture",
    EDGE_BPS: "0", LEG_EDGE_BPS: "0", MIN_BOOK_DEPTH: "0", SPOT_PX_STALE_MS: "0",
  };
  const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try { Object.assign(process.env, values); return run(); }
  finally { for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value; }
}

function quoteDeps(config: WriterConfig): QuoteDeps {
  return {
    cfg: config,
    exposure: new ExposureBook((vault) => config.markets.get(vault)?.cluster),
    chainId: 998,
    fetchLegPrice: async () => ({ priceWad: WAD / 2n, source: "l2Book", observedAtMs: AS_OF, depthWad: WAD, vwapWad: WAD / 2n, freshnessMs: null }),
    bestEstimateJointProbWad: async () => WAD / 4n,
    readAllowance: async () => 1_000_000_000n,
    readSettled: async () => new Set(),
    sign: async () => "0x1234",
    recordQuote: async (decision) => appendQuoteDecision(config.researchPersistence!, decision),
    now: () => AS_OF,
    randomId: () => QUOTE_ID,
    metrics: newMetrics(),
  };
}

type ReturnedQuote = { quoteId: Hex; premium: string; maxPayout: string; legs: { vault: Address; isYes: boolean }[] };
const hash = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`;

class FixtureChain {
  constructor(private readonly quote: ReturnedQuote, private readonly deployBlock: bigint) {}
  async getBlockNumber(): Promise<bigint> { return this.deployBlock + 5n; }
  async getChainId(): Promise<number> { return 998; }
  async getBlock({ blockNumber }: { blockNumber: bigint }): Promise<{ hash: Hex }> { return { hash: hash(blockNumber) }; }
  async getLogs({ event }: { event: { name: string } }): Promise<Record<string, unknown>[]> {
    return event.name === "ParlayMinted"
      ? [{ blockNumber: this.deployBlock + 1n, blockHash: hash(this.deployBlock + 1n), transactionHash: hash(101n), logIndex: 0, args: { id: 7n, quoteId: this.quote.quoteId, taker: TAKER, premium: BigInt(this.quote.premium), maxPayout: BigInt(this.quote.maxPayout) } }]
      : [{ blockNumber: this.deployBlock + 2n, blockHash: hash(this.deployBlock + 2n), transactionHash: hash(102n), logIndex: 1, args: { id: 7n, status: 3n } }];
  }
  async readContract({ functionName }: { functionName: string }): Promise<unknown> {
    if (functionName === "parlay") return { legs: this.quote.legs, premium: BigInt(this.quote.premium), maxPayout: BigInt(this.quote.maxPayout), status: 3 };
    if (functionName === "settled") return true;
    if (functionName === "settleFractionWad") return WAD / 2n;
    throw new Error(`unexpected read: ${functionName}`);
  }
}

function recordFailedThenSuccessfulCollect(root: string): void {
  const storage = openResearchPersistence(root);
  const starts = [
    { runId: "20260828T113000000Z-00000000-0000-4000-8000-000000000001", startedAt: "2026-08-28T11:30:00.000Z" },
    { runId: "20260828T114000000Z-00000000-0000-4000-8000-000000000002", startedAt: "2026-08-28T11:40:00.000Z" },
  ];
  for (const start of starts) writeOperationRecord(storage, { schemaVersion: 1, network: "testnet", operation: "collect", phase: "start", ...start });
  writeOperationRecord(storage, { schemaVersion: 1, network: "testnet", operation: "collect", phase: "terminal", ...starts[0], endedAt: "2026-08-28T11:31:00.000Z", status: "failure", stage: "collect", error: "fixture collector failed" });
  writeOperationRecord(storage, { schemaVersion: 1, network: "testnet", operation: "collect", phase: "terminal", ...starts[1], endedAt: "2026-08-28T11:41:00.000Z", status: "success", stage: "collect", detail: { accepted: 300, conflicts: 0, failures: 0 } });
}

async function backUpFixture(root: string): Promise<{ summary: string; objects: Map<string, Buffer> }> {
  const objects = new Map<string, Buffer>();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const key = decodeURIComponent(url.pathname.replace(/^\/fixture\//, ""));
    if (init?.method === "HEAD") {
      const bytes = objects.get(key);
      return new Response(null, { status: bytes ? 200 : 404, headers: bytes ? { "x-amz-meta-sha256": sha256(bytes) } : undefined });
    }
    const bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
    objects.set(key, bytes);
    return new Response(null, { status: 200 });
  };
  const summary = await backupResearch(root, { endpoint: "https://backup.invalid", region: "fixture-1", bucket: "fixture", accessKey: "fixture-access", secret: "fixture-secret" }, { now: () => AS_OF, fetch });
  return { summary: canonicalJson(summary), objects };
}

async function fixtureFlow(root: string): Promise<Record<string, Buffer>> {
  const selected = profile(root);
  const collection = await collectSources({ root, profile: selected.loaded, nowMs: AS_OF, fetch: async (_url, init) => new Response(candles(JSON.parse(String(init?.body)).req.coin)) });
  assert.equal(collection.failures.length, 0);
  const current = readCurrentManifest(root);
  const manifest = current.manifest;
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  const derived = deriveReturns(root, manifest, { asOfMs: manifest.sourceRange.toMs, lookbackMs: 180 * DAY });
  assert.match(derived.manifestPath, /derived\/returns-v2\//);
  const candidate = calibrate({ root, manifest, derivedManifestPath: derived.manifestPath, profile: selected.loaded, now: () => AS_OF });
  assert.deepEqual(candidate.quality.pairEligibility.map(({ pair, status, reason }) => [pair.join(":"), status, reason]), [["BTC:ETH", "direct", "testnet-quality-passed"], ["BTC:SOL", "fallback", "operator-reviewed-testnet-bootstrap"], ["ETH:SOL", "quarantined", "ineligible-source"]]);
  const candidatePath = join(root, "artifacts", "candidates", `${candidate.modelVersion}.json`);
  const validation = runReplay({ root, profile: selected.loaded, candidate, candidateBytes: readFileSync(candidatePath, "utf8"), inputManifestSha256: current.manifestSha256, derivedManifestPath: derived.manifestPath, seed: "end-to-end" });
  assert.equal(validation.decision, "Supported", canonicalJson({ bootstrap: validation.bootstrap, deterministicRerunMatches: validation.deterministicRerunMatches, maxProjectionError: candidate.quality.maxProjectionError, exclusions: validation.exclusions }));
  const receipt = promoteCandidate(root, candidatePath, selected.loaded, parseMarkets(selected.loaded.marketRegistryRaw), AS_OF);
  assert.equal(receipt.validationState, "Supported");

  const startup = withWriterEnv(root, selected.file, () => loadConfig(AS_OF));
  assert.equal(applyWriterProfileIdentity(startup, 998), null);
  const btc = [...startup.markets.values()].find((market) => market.underlying === "BTC")!.vault;
  const eth = [...startup.markets.values()].find((market) => market.underlying === "ETH")!.vault;
  const response = await handleQuote(quoteDeps(startup), { taker: TAKER, legs: [{ vault: btc, isYes: true }, { vault: eth, isYes: false }], stake: "1000000", inviteCode: "fixture" });
  assert.equal(response.status, 200, canonicalJson(response.json));
  const quote = (response.json as { quote: ReturnedQuote }).quote;
  const quoteRecord = JSON.parse(readFileSync(filesBelow(join(root, "journal", "quotes"))[0], "utf8"));
  assert.equal(quoteRecord.quoteId, quote.quoteId);
  assert.deepEqual(quoteRecord.pairDecisions.map(({ pair, status }: { pair: string[]; status: string }) => [pair.join(":"), status]), [["BTC:ETH", "direct"]]);

  const deployBlock = BigInt(selected.loaded.deployment.parlayDeployBlock);
  const joined = await joinEvents(root, { client: new FixtureChain(quote, deployBlock) as unknown as JoinDeps["client"], vault: selected.loaded.deployment.parlayVault, deployBlock, profile: selected.loaded, now: () => AS_OF });
  assert.deepEqual(joined.resolutions[quote.quoteId], { status: "void", allLegsFinal: true });
  const events = filesBelow(join(root, "journal", "events")).flatMap((file) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as JoinedEventRecord));
  const minted = events.find((event) => event.kind === "minted");
  const resolved = events.find((event) => event.kind === "resolved");
  assert.ok(minted?.kind === "minted");
  assert.ok(resolved?.kind === "resolved");
  assert.equal(minted.quoteId, quote.quoteId);
  assert.equal(resolved.quoteId, quote.quoteId);

  recordFailedThenSuccessfulCollect(root);
  const report = generateReport(root, candidatePath, derived.manifestPath, selected.loaded, AS_OF);
  assert.match(report.bytes, /collect terminal: success/);
  assert.match(report.bytes, /collect failure: fixture collector failed/);
  const backup = await backUpFixture(root);
  assert.ok(backup.objects.has(`artifacts/candidates/${candidate.modelVersion}.json`));
  assert.ok(backup.objects.has(report.path.slice(root.length + 1)));

  const restarted = withWriterEnv(root, selected.file, () => loadConfig(AS_OF));
  assert.notEqual(restarted.researchPersistence, startup.researchPersistence);
  assert.equal(applyWriterProfileIdentity(restarted, 998), null);
  const marker = readFileSync(join(root, "network-profile.json"));
  const markets = JSON.parse(readFileSync(join(root, "markets.json"), "utf8"));
  markets.markets[0].title = "fixture nightly rotation";
  writeFileSync(join(root, "markets.json"), canonicalJson(markets));
  const rotated = loadResearchNetworkProfile(selected.file);
  bindResearchRootIdentity(openResearchPersistence(root), rotated);
  assert.deepEqual(readFileSync(join(root, "network-profile.json")), marker);
  const afterRotation = withWriterEnv(root, selected.file, () => loadConfig(AS_OF));
  assert.equal(afterRotation.model.multiAssetEnabled, false);
  assert.match(afterRotation.model.identityFailureReason!, /artifact profile identity mismatch/);

  const allOutput = filesBelow(root).flatMap((file) => [file.slice(root.length + 1), file.endsWith(".gz") ? gunzipSync(readFileSync(file)).toString("utf8") : readFileSync(file, "utf8")]).join("\n");
  for (const forbidden of ["api.hyperliquid.xyz", '"network":"mainnet"', "returns-v1"]) assert.doesNotMatch(allOutput, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  return {
    candidate: readFileSync(candidatePath), validation: readFileSync(join(root, "artifacts", "candidates", `${candidate.modelVersion}.validation.json`)),
    manifest: manifestBytes, report: Buffer.from(report.bytes), quote: Buffer.from(canonicalJson(quoteRecord)), events: Buffer.from(canonicalJson(events)),
    champion: readFileSync(join(root, "artifacts", "champion.json")), backup: Buffer.from(backup.summary), marker,
  };
}

function shippedResearchConfiguration(): Record<string, unknown> {
  const env = Object.fromEntries(readFileSync(new URL("../.env.example", import.meta.url), "utf8").split("\n").filter((line) => /^[A-Z_]+=/.test(line)).map((line) => line.split(/=(.*)/s).slice(0, 2)));
  const services = ["collector", "daily", "backup"].map((name) => readFileSync(new URL(`../../ops/systemd/hype-research-${name}.service`, import.meta.url), "utf8"));
  return {
    profile: env.RESEARCH_NETWORK_PROFILE_FILE,
    root: env.RESEARCH_ROOT,
    legacyInfoUrl: env.RESEARCH_INFO_API_URL,
    anchoredServices: services.filter((unit) => unit.includes("Environment=RESEARCH_REQUIRE_ANCHORED_FS=1")).length,
    testnetLocks: services.filter((unit) => unit.includes("/opt/hype/research/testnet/state/job.lock")).length,
  };
}

test("research end-to-end fixture proves the deterministic testnet-only operational pipeline twice", async () => {
  const roots = [mkdtempSync(join(tmpdir(), "hype-e2e-a-")), mkdtempSync(join(tmpdir(), "hype-e2e-b-"))];
  try {
    assert.deepEqual(await fixtureFlow(roots[1]), await fixtureFlow(roots[0]));
    assert.deepEqual(shippedResearchConfiguration(), { profile: "/opt/hype/registry/research-network.testnet.json", root: "/opt/hype/research/testnet", legacyInfoUrl: undefined, anchoredServices: 3, testnetLocks: 3 });
  } finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
});
