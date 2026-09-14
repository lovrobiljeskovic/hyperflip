import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { hashTypedData, type Address, type Hex } from "viem";
import { ExposureBook } from "../src/exposure.js";
import { WAD } from "../src/pure.js";
import { handleQuote, newMetrics, type QuoteDeps } from "../src/server.js";
import { parseCorrelationArtifact, promoteCandidate } from "../src/research/artifacts.js";
import { collectSources } from "../src/research/candles.js";
import { bindResearchRootIdentity, loadResearchNetworkProfile } from "../src/research/network.js";
import { openResearchPersistence } from "../src/research/persistence.js";
import { runDaily } from "../src/research/daily.js";
import { appendQuoteDecision, initializeQuoteJournal, joinEvents, type JoinDeps } from "../src/research/journal.js";
import { canonicalJson, sha256 } from "../src/research/store.js";
import type { CorrelationArtifact, DataManifest, JoinedEventRecord, SourceEntry, SourceRegistry } from "../src/research/types.js";
import type { MarketInfo } from "../src/markets.js";

const NOW = Date.parse("2026-08-28T18:00:00.000Z");
const PARLAY_VAULT = "0x9999999999999999999999999999999999999999" as Address;
const BTC_VAULT = "0x1111111111111111111111111111111111111111" as Address;
const ETH_VAULT = "0x2222222222222222222222222222222222222222" as Address;
const TAKER = "0x3333333333333333333333333333333333333333" as Address;
const QUOTE_ID = `0x${"ab".repeat(32)}` as Hex;

const source = (underlying: string): SourceEntry => ({
  schemaVersion: 1,
  underlying,
  sourceNetwork: "testnet",
  sourceCoin: underlying,
  cluster: "crypto",
  calendar: "continuous",
  measurementEnabled: true,
  fallbackEligible: false,
});

function profile(root: string, sources: SourceRegistry) {
  const value = { schemaVersion: 1, network: "testnet", infoApiUrl: "https://api.hyperliquid-testnet.xyz/info", evmChainId: 998, sourceRegistryFile: "sources.json", marketRegistryFile: "markets.json", deploymentRegistryFile: "deployment.json", baselineCorrelationFile: "correlations.json" };
  writeFileSync(join(root, "profile.json"), JSON.stringify(value));
  writeFileSync(join(root, "sources.json"), JSON.stringify(sources));
  writeFileSync(join(root, "markets.json"), canonicalJson({ schemaVersion: 1, network: "testnet", markets: [
    { vault: BTC_VAULT, coinYes: "+1", coinNo: "+2", underlying: "BTC", cluster: "crypto", direction: "up", title: "BTC", category: "crypto" },
    { vault: ETH_VAULT, coinYes: "+3", coinNo: "+4", underlying: "ETH", cluster: "crypto", direction: "up", title: "ETH", category: "crypto" },
  ] }));
  writeFileSync(join(root, "deployment.json"), canonicalJson({ schemaVersion: 1, network: "testnet", evmChainId: 998, parlayVault: PARLAY_VAULT, parlayDeployBlock: "0" }));
  writeFileSync(join(root, "correlations.json"), readFileSync(new URL("../../registry/correlations.json", import.meta.url)));
  return loadResearchNetworkProfile(join(root, "profile.json"));
}

const fixturePartition = (price: string): Buffer => gzipSync(`${canonicalJson({
  schemaVersion: 1,
  source: "hyperliquid-info",
  sourceNetwork: "testnet",
  underlying: "BTC",
  sourceCoin: "BTC",
  interval: "1h",
  openTimeMs: NOW - 3_600_000,
  closeTimeMs: NOW - 1,
  open: price,
  high: price,
  low: price,
  close: price,
  volume: "1",
  tradeCount: 1,
  retrievedAtMs: NOW,
})}\n`);

function filesBelow(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function artifactFixture(root: string): {
  artifact: CorrelationArtifact;
  candidateRaw: string;
  champion: string;
  markets: Map<string, MarketInfo>;
  partition: string;
  sources: SourceRegistry;
  profile: ReturnType<typeof profile>;
} {
  const sources: SourceRegistry = { schemaVersion: 2, network: "testnet", sources: [source("BTC"), source("ETH")] };
  const loadedProfile = profile(root, sources);
  bindResearchRootIdentity(openResearchPersistence(root), loadedProfile);
  const sourceBytes = canonicalJson(sources);
  const sourceHash = sha256(sourceBytes);
  const sourcePath = join(root, "facts", "source-registries", `${sourceHash}.json`);
  mkdirSync(join(root, "facts", "source-registries"), { recursive: true });
  writeFileSync(sourcePath, sourceBytes);

  const partitionRelative = "raw/candles/2026/08/28/BTC/fixture.jsonl.gz";
  const partition = join(root, partitionRelative);
  const expectedPartition = fixturePartition("100");
  const provenanceBytes = canonicalJson({ schemaVersion: 2, sourceRegistrySha256: sourceHash, network: "testnet", profileSha256: loadedProfile.profileSha256, startTimeMs: NOW - 3_600_000, endTimeMs: NOW - 1, ignoredBefore: 0, ignoredAfter: 0 });
  const manifest: DataManifest = {
    schemaVersion: 2,
    network: "testnet",
    profileSha256: loadedProfile.profileSha256,
    createdAt: "2026-08-28T12:00:00.000Z",
    sourceRegistrySha256: sourceHash,
    sourceRange: { fromMs: NOW - 3_600_000, toMs: NOW - 1 },
    underlyings: {
      BTC: { rows: 1, firstUsableObservationMs: NOW - 3_600_000, lastUsableObservationMs: NOW - 3_600_000, missingIntervals: [] },
      ETH: { rows: 0, firstUsableObservationMs: null, lastUsableObservationMs: null, missingIntervals: [] },
    },
    files: [
      { path: relative(root, sourcePath), bytes: Buffer.byteLength(sourceBytes), sha256: sourceHash, rows: 1, schemaVersion: 1 },
      { path: partitionRelative, bytes: expectedPartition.length, sha256: sha256(expectedPartition), rows: 1, schemaVersion: 1 },
      { path: `${partitionRelative}.provenance.json`, bytes: Buffer.byteLength(provenanceBytes), sha256: sha256(provenanceBytes), rows: 1, schemaVersion: 1 },
    ],
  };
  const manifestHash = sha256(canonicalJson(manifest));
  mkdirSync(join(root, "manifests"), { recursive: true });
  mkdirSync(resolve(partition, ".."), { recursive: true });
  writeFileSync(`${partition}.provenance.json`, provenanceBytes);
  writeFileSync(join(root, "manifests", `${manifestHash}.json`), canonicalJson(manifest));

  const artifact = JSON.parse(readFileSync(new URL("./fixtures/research/artifact-valid.json", import.meta.url), "utf8")) as CorrelationArtifact;
  artifact.schemaVersion = 2;
  artifact.network = "testnet";
  artifact.profileSha256 = loadedProfile.profileSha256;
  artifact.marketRegistrySha256 = loadedProfile.marketRegistrySha256;
  artifact.deploymentRegistrySha256 = loadedProfile.deploymentRegistrySha256;
  artifact.baselineCorrelationSha256 = loadedProfile.baselineCorrelationSha256;
  artifact.quality.pairEligibility = artifact.quality.pairEligibility.map((entry) => ({ ...entry, reason: "testnet-quality-passed" }));
  artifact.directPairs = [{ pair: ["BTC", "ETH"], correlation: 0.05, reason: "testnet-quality-passed" }];
  artifact.fallbackPairs = [];
  artifact.quarantinedPairs = [];
  artifact.modelVersion = "acceptance-fixture";
  artifact.dataManifestSha256 = manifestHash;
  artifact.sourceRegistrySha256 = sourceHash;
  const candidateRaw = `${canonicalJson(artifact)}\n`;
  mkdirSync(join(root, "artifacts", "candidates"), { recursive: true });
  const candidate = join(root, "artifacts", "candidates", `${artifact.modelVersion}.json`);
  writeFileSync(candidate, candidateRaw);
  const champion = join(root, "artifacts", "champion.json");
  writeFileSync(champion, "prior champion bytes\n");

  const markets = new Map<string, MarketInfo>([
    [BTC_VAULT.toLowerCase(), { vault: BTC_VAULT, coinYes: "+1", coinNo: "+2", underlying: "BTC", cluster: "crypto", direction: "up", title: "BTC", category: "crypto" }],
    [ETH_VAULT.toLowerCase(), { vault: ETH_VAULT, coinYes: "+3", coinNo: "+4", underlying: "ETH", cluster: "crypto", direction: "up", title: "ETH", category: "crypto" }],
  ]);
  return { artifact, candidateRaw, champion, markets, partition, sources, profile: loadedProfile };
}

function quoteDeps(root: string, artifact: ReturnType<typeof artifactFixture>): QuoteDeps {
  const parsed = parseCorrelationArtifact(artifact.candidateRaw, NOW, artifact.sources, artifact.markets, artifact.profile);
  parsed.model.validationSha256 = "e".repeat(64);
  parsed.model.validationState = "Supported";
  const quoteJournal = initializeQuoteJournal(root, artifact.profile);
  const cfg: QuoteDeps["cfg"] = {
    pricingMode: "correlated",
    rpcUrl: "",
    parlayVault: PARLAY_VAULT,
    writerAddress: TAKER,
    quoteSignerKey: `0x${"11".repeat(32)}`,
    pokerKey: `0x${"22".repeat(32)}`,
    infoApiUrl: "",
    researchRoot: root,
    researchProfile: artifact.profile,
    researchPersistence: quoteJournal,
    port: 0,
    edgeBps: 0n,
    minPremiumBps: 100n,
    minLegs: 2,
    maxStake: 10_000_000n,
    perMarketCap: 1_000_000_000n,
    perClusterCap: 1_000_000_000n,
    perCodeReservedCap: 1_000_000_000n,
    rhoBandPct: 0.2,
    correlations: parsed.table,
    model: parsed.model,
    legEdgeBps: 0n,
    quoteTtlMs: 30_000,
    spotPxStaleMs: 60_000,
    minBookDepthWad: 0n,
    lockoutMs: 600_000,
    pokerIntervalMs: 0,
    deployBlock: 0n,
    markets: artifact.markets,
    registryJson: "{}",
    inviteCodes: new Set(["acceptance"]),
    waitlistFile: join(root, "waitlist.jsonl"),
    corsOrigins: [],
  };
  return {
    cfg,
    exposure: new ExposureBook((vault) => cfg.markets.get(vault)?.cluster),
    chainId: 31337,
    fetchLegPrice: async () => ({ priceWad: WAD / 2n, source: "l2Book", observedAtMs: NOW, depthWad: WAD, vwapWad: WAD / 2n, freshnessMs: null }),
    bestEstimateJointProbWad: async () => WAD / 4n,
    readAllowance: async () => 1_000_000_000n,
    readSettled: async () => new Set(),
    sign: async () => "0x1234",
    recordQuote: async (decision) => appendQuoteDecision(quoteJournal, decision),
    now: () => NOW,
    randomId: () => QUOTE_ID,
    metrics: newMetrics(),
  };
}

type FakeLog = { blockNumber: bigint; blockHash: Hex; transactionHash: Hex; logIndex: number; args: Record<string, bigint | string> };

class FixtureChain {
  readonly minted: FakeLog[];
  readonly resolved: FakeLog[];

  constructor(private readonly quote: { quoteId: Hex; premium: string; maxPayout: string; legs: { vault: Address; isYes: boolean }[] }) {
    this.minted = [{ blockNumber: 1n, blockHash: hash(1n), transactionHash: hash(101n), logIndex: 0, args: { id: 7n, quoteId: quote.quoteId, taker: TAKER, premium: BigInt(quote.premium), maxPayout: BigInt(quote.maxPayout) } }];
    this.resolved = [{ blockNumber: 2n, blockHash: hash(2n), transactionHash: hash(102n), logIndex: 1, args: { id: 7n, status: 3n } }];
  }

  async getBlockNumber(): Promise<bigint> { return 5n; }
  async getChainId(): Promise<number> { return 998; }
  async getBlock({ blockNumber }: { blockNumber: bigint }): Promise<{ hash: Hex }> { return { hash: hash(blockNumber) }; }
  async getLogs({ event, fromBlock, toBlock }: { event: { name: string }; fromBlock: bigint; toBlock: bigint }): Promise<FakeLog[]> {
    const logs = event.name === "ParlayMinted" ? this.minted : this.resolved;
    return logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock);
  }
  async readContract({ functionName }: { functionName: string }): Promise<unknown> {
    if (functionName === "parlay") return { legs: this.quote.legs, premium: BigInt(this.quote.premium), maxPayout: BigInt(this.quote.maxPayout), status: 3 };
    if (functionName === "settled") return true;
    if (functionName === "settleFractionWad") return WAD / 2n;
    throw new Error(`unexpected read: ${functionName}`);
  }
}

function hash(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function expectedQuoteDigest(
  chainId: number,
  verifyingContract: Address,
  quote: { taker: Address; legs: { vault: Address; isYes: boolean }[]; premium: bigint; maxPayout: bigint; deadline: bigint; quoteId: Hex },
): Hex {
  return hashTypedData({
    domain: { name: "ParlayVault", version: "1", chainId, verifyingContract },
    types: {
      Quote: [
        { name: "taker", type: "address" },
        { name: "legs", type: "Leg[]" },
        { name: "premium", type: "uint96" },
        { name: "maxPayout", type: "uint96" },
        { name: "deadline", type: "uint256" },
        { name: "quoteId", type: "bytes32" },
      ],
      Leg: [
        { name: "vault", type: "address" },
        { name: "isYes", type: "bool" },
      ],
    },
    primaryType: "Quote",
    message: quote,
  });
}

function runRepositoryGate(root: string): string[] {
  const bin = join(root, "bin");
  const log = join(root, "commands.log");
  const webEnvFile = join(root, "web-env.json");
  const webEnv = {
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_WRITER_URL: "http://127.0.0.1:1",
    NEXT_PUBLIC_INFO_API: "http://127.0.0.1:1",
    NEXT_PUBLIC_RPC_URL: "http://127.0.0.1:1",
    NEXT_PUBLIC_PRIVY_APP_ID: "",
    NEXT_PUBLIC_PARLAY_VAULT: "0x1111111111111111111111111111111111111111",
    NEXT_PUBLIC_PARLAY_DEPLOY_BLOCK: "1",
  };
  mkdirSync(bin);
  for (const command of ["forge", "npm", "node"]) {
    const file = join(bin, command);
    writeFileSync(file, `#!${process.execPath}
const fs = require("node:fs");
const directory = require("node:path").basename(process.cwd());
const command = ${JSON.stringify(command)};
const label = command === "npm" ? command + " " + directory : command;
fs.appendFileSync(process.env.ACCEPTANCE_LOG, label + " " + process.argv.slice(2).join(" ") + "\\n");
if (command === "npm" && directory === "web") {
  const keys = ${JSON.stringify(Object.keys(webEnv))};
  fs.writeFileSync(process.env.ACCEPTANCE_ENV, JSON.stringify(Object.fromEntries(keys.map(key => [key, process.env[key]]))));
}
`);
    chmodSync(file, 0o755);
  }
  const repo = resolve(import.meta.dirname, "../..");
  const result = spawnSync("bash", ["scripts/verify.sh"], {
    cwd: repo,
    env: {
      ...process.env,
      ...Object.fromEntries(Object.keys(webEnv).map((key) => [key, "inherited-value"])),
      ACCEPTANCE_LOG: log, ACCEPTANCE_ENV: webEnvFile, PATH: `${bin}:${process.env.PATH}`,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(webEnvFile, "utf8")), webEnv);
  return readFileSync(log, "utf8").trim().split("\n");
}

test("correlation beta acceptance is deterministic, durable, joined, isolated, and repository-gated", async () => {
  const roots = [mkdtempSync(join(tmpdir(), "hype-acceptance-")), mkdtempSync(join(tmpdir(), "hype-collector-failure-")), mkdtempSync(join(tmpdir(), "hype-gate-"))];
  try {
    const artifact = artifactFixture(roots[0]);
    const priorChampion = readFileSync(artifact.champion);
    const candidate = join(roots[0], "artifacts", "candidates", `${artifact.artifact.modelVersion}.json`);

    assert.throws(() => promoteCandidate(roots[0], candidate, artifact.profile, artifact.markets, NOW), /manifest file mismatch/);
    assert.deepEqual(readFileSync(artifact.champion), priorChampion);
    mkdirSync(resolve(artifact.partition, ".."), { recursive: true });
    writeFileSync(artifact.partition, fixturePartition("101"));
    assert.throws(() => promoteCandidate(roots[0], candidate, artifact.profile, artifact.markets, NOW), /manifest file mismatch/);
    assert.deepEqual(readFileSync(artifact.champion), priorChampion);

    writeFileSync(artifact.champion, artifact.candidateRaw);
    assert.equal(parseCorrelationArtifact(readFileSync(artifact.champion, "utf8"), NOW, artifact.sources, artifact.markets).model.version, "acceptance-fixture");
    const invalid = structuredClone(artifact.artifact);
    invalid.quality.maxProjectionError = 0.2;
    writeFileSync(artifact.champion, canonicalJson(invalid));
    assert.throws(() => parseCorrelationArtifact(readFileSync(artifact.champion, "utf8"), NOW, artifact.sources, artifact.markets), /maxProjectionError exceeds policy/);

    const deps = quoteDeps(roots[0], artifact);
    const response = await handleQuote(deps, {
      taker: TAKER,
      legs: [{ vault: BTC_VAULT, isYes: true }, { vault: ETH_VAULT, isYes: false }],
      stake: "1000000",
      inviteCode: "acceptance",
    });
    assert.equal(response.status, 200);
    const returned = (response.json as { quote: { quoteId: Hex; premium: string; maxPayout: string; deadline: string; legs: { vault: Address; isYes: boolean }[] } }).quote;
    const quoteFile = filesBelow(join(roots[0], "journal", "quotes"))[0];
    const recorded = JSON.parse(readFileSync(quoteFile, "utf8")) as { quoteId: string; quoteDigest: string };
    assert.equal(recorded.quoteId, returned.quoteId);
    assert.equal(recorded.quoteDigest, expectedQuoteDigest(deps.chainId, deps.cfg.parlayVault, { taker: TAKER, legs: returned.legs, premium: BigInt(returned.premium), maxPayout: BigInt(returned.maxPayout), deadline: BigInt(returned.deadline), quoteId: returned.quoteId }));
    assert.ok(statSync(quoteFile).size > 0);

    const chain = new FixtureChain(returned);
    const joined = await joinEvents(roots[0], { client: chain as unknown as JoinDeps["client"], vault: PARLAY_VAULT, deployBlock: 0n, profile: artifact.profile, now: () => NOW });
    assert.deepEqual(joined.resolutions[returned.quoteId], { status: "void", allLegsFinal: true });
    const events = filesBelow(join(roots[0], "journal", "events")).flatMap((file) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as JoinedEventRecord));
    const minted = events.find((event) => event.kind === "minted");
    const resolved = events.find((event) => event.kind === "resolved");
    assert.ok(minted?.kind === "minted");
    assert.ok(resolved?.kind === "resolved");
    assert.equal(minted.quoteId, returned.quoteId);
    assert.equal(resolved.quoteId, returned.quoteId);

    const pipeline = spawnSync(process.execPath, ["--import", "tsx", "src/research/cli.ts", "check"], {
      cwd: resolve(import.meta.dirname, ".."),
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
      encoding: "utf8",
    });
    assert.equal(pipeline.status, 0, pipeline.stderr);
    assert.match(pipeline.stdout, /# pass 1\b/);

    const collectorSources = { schemaVersion: 2 as const, network: "testnet" as const, sources: [source("BTC")] };
    const collector = await collectSources({ root: roots[1], profile: profile(roots[1], collectorSources), nowMs: NOW, sleep: async () => {}, fetch: async () => new Response("unavailable", { status: 503 }) });
    assert.deepEqual(collector.failures.map(({ underlying }) => underlying), ["BTC", "manifest"]);
    const steps: string[] = [];
    const daily = runDaily({}, (step) => {
      steps.push(step);
      return step === "derive"
        ? { status: 0, stdout: '{"dataManifestPath":"/tmp/data.json","manifestPath":"/tmp/fresh.manifest.json"}\n', stderr: "" }
        : { status: 7, stdout: "", stderr: "calibrator failed" };
    });
    assert.equal(daily, 7);
    assert.deepEqual(steps, ["derive", "calibrate"]);

    assert.deepEqual(runRepositoryGate(roots[2]), [
      "forge fmt --check", "forge build --sizes", "forge test",
      "npm keeper run check", "npm writer run check", "npm web run check",
      "node --test tools/rotate-lib.test.mjs",
    ]);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});
