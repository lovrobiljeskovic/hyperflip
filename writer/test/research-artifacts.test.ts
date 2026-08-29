import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { MarketInfo } from "../src/config.js";
import { promoteCandidate, validateArtifact } from "../src/research/artifacts.js";
import type { ValidationReport } from "../src/research/replay.js";
import { canonicalJson, sha256 } from "../src/research/store.js";
import type { CorrelationArtifact, DataManifest, SourceEntry, SourceRegistry } from "../src/research/types.js";
import type { LoadedResearchNetworkProfile } from "../src/research/network.js";

const NOW = Date.parse("2026-08-28T18:00:00.000Z");
const VALID = JSON.parse(readFileSync(new URL("./fixtures/research/artifact-valid.json", import.meta.url), "utf8")) as CorrelationArtifact;
const STALE = JSON.parse(readFileSync(new URL("./fixtures/research/artifact-stale.json", import.meta.url), "utf8")) as CorrelationArtifact;
const VAULT = "0x1111111111111111111111111111111111111111" as const;

const source = (underlying: string, fallbackEligible = false): SourceEntry => ({
  schemaVersion: 1, underlying, sourceNetwork: "testnet", sourceCoin: underlying, cluster: "crypto",
  calendar: "continuous", measurementEnabled: true, fallbackEligible,
});

function setup(artifactInput: CorrelationArtifact = VALID): {
  root: string; artifact: CorrelationArtifact; raw: string; candidate: string; manifest: DataManifest;
  sources: SourceRegistry; markets: Map<string, MarketInfo>; profile: LoadedResearchNetworkProfile; validation: ValidationReport;
} {
  const root = mkdtempSync(join(tmpdir(), "hype-artifact-"));
  const sources: SourceRegistry = { schemaVersion: 2, network: "testnet", sources: [source("BTC"), source("ETH")] };
  const sourceBytes = canonicalJson(sources);
  const sourceRegistrySha256 = sha256(sourceBytes);
  const sourcePath = join(root, "facts", "source-registries", `${sourceRegistrySha256}.json`);
  mkdirSync(join(root, "facts", "source-registries"), { recursive: true });
  writeFileSync(sourcePath, sourceBytes);
  const artifact = structuredClone(artifactInput);
  artifact.schemaVersion = 2;
  artifact.quality.pairEligibility = artifact.quality.pairEligibility.map((entry) => entry.status === "direct" ? { ...entry, reason: "testnet-quality-passed" } : entry);
  artifact.directPairs = artifact.quality.pairEligibility.flatMap((entry) => entry.status === "direct" ? [{ pair: entry.pair, correlation: 0.05, reason: "testnet-quality-passed" as const }] : []);
  artifact.fallbackPairs = [];
  artifact.quarantinedPairs = artifact.quality.pairEligibility.flatMap((entry) => entry.status === "quarantined" ? [{ pair: entry.pair, reason: entry.reason }] : []);
  artifact.sourceRegistrySha256 = sourceRegistrySha256;
  const profileValue = { schemaVersion: 1, network: "testnet", infoApiUrl: "https://api.hyperliquid-testnet.xyz/info", evmChainId: 998, sourceRegistryFile: "sources.json", marketRegistryFile: "markets.json", deploymentRegistryFile: "deployment.json", baselineCorrelationFile: "correlations.json" } as const;
  const marketRegistryRaw = canonicalJson({ schemaVersion: 1, network: "testnet", markets: [] });
  const deployment = { schemaVersion: 1, network: "testnet", evmChainId: 998, parlayVault: VAULT, parlayDeployBlock: "1" } as const;
  const baselineCorrelationRaw = canonicalJson({ network: "testnet", fallbackReason: "operator-reviewed-testnet-bootstrap", clusters: artifact.clusters });
  const profile: LoadedResearchNetworkProfile = {
    profile: profileValue, profileSha256: sha256(canonicalJson(profileValue)), sources, sourceRegistrySha256,
    marketRegistryRaw, marketRegistrySha256: sha256(marketRegistryRaw), deployment, deploymentRegistrySha256: sha256(canonicalJson(deployment)),
    baselineCorrelationRaw, baselineCorrelationSha256: sha256(baselineCorrelationRaw),
  };
  artifact.network = "testnet";
  artifact.profileSha256 = profile.profileSha256;
  artifact.marketRegistrySha256 = profile.marketRegistrySha256;
  artifact.deploymentRegistrySha256 = profile.deploymentRegistrySha256;
  artifact.baselineCorrelationSha256 = profile.baselineCorrelationSha256;
  const manifest: DataManifest = {
    schemaVersion: 1,
    createdAt: artifact.createdAt,
    sourceRegistrySha256,
    sourceRange: { fromMs: Date.parse(artifact.dataAsOf) - 180 * 86_400_000, toMs: Date.parse(artifact.dataAsOf) },
    underlyings: Object.fromEntries(sources.sources.map((entry) => [entry.underlying, { rows: 1, firstUsableObservationMs: artifact.quality.lastUsableObservationMs[entry.underlying], lastUsableObservationMs: artifact.quality.lastUsableObservationMs[entry.underlying], missingIntervals: [] }])),
    files: [{ path: `facts/source-registries/${sourceRegistrySha256}.json`, bytes: statSync(sourcePath).size, sha256: sourceRegistrySha256, rows: 1, schemaVersion: 1 }],
  };
  artifact.dataManifestSha256 = sha256(canonicalJson(manifest));
  const raw = `${canonicalJson(artifact)}\n`;
  const candidate = join(root, "artifacts", "candidates", `${artifact.modelVersion}.json`);
  mkdirSync(join(root, "artifacts", "candidates"), { recursive: true });
  mkdirSync(join(root, "manifests"), { recursive: true });
  writeFileSync(candidate, raw);
  writeFileSync(join(root, "manifests", `${artifact.dataManifestSha256}.json`), canonicalJson(manifest));
  const baseline = canonicalJson({ clusters: artifact.clusters });
  const baselineSha256 = sha256(baseline);
  mkdirSync(join(root, "facts", "baselines"), { recursive: true });
  writeFileSync(join(root, "facts", "baselines", `${baselineSha256}.json`), baseline);
  const validation = {
    schemaVersion: 1, modelVersion: artifact.modelVersion, candidateSha256: sha256(raw), inputManifestSha256: artifact.dataManifestSha256,
    baselineSha256, baselineSnapshotPath: `facts/baselines/${baselineSha256}.json`, seed: "fixture", drawCount: 20_000, originStrideHours: 24 as const,
    policy: { maxProjectionError: 0.10 as const, bootstrapBlockHours: 96 as const, bootstrapSamples: 2_000 as const }, ticketCounts: {}, selectedTicketKeys: [], modelScores: {} as ValidationReport["modelScores"],
    bootstrap: { point: -0.01, lower: -0.02, upper: 0, groups: [], samples: 2_000, blockHours: 96 }, stressThresholds: [], degreeOfFreedomSelections: [], exclusions: [], decision: "Supported" as const,
    deterministicRerunMatches: true, resourcePolicy: { maxWallClockMs: 30_000 as const, maxPeakRssBytes: 536_870_912 as const }, limitations: [],
  } satisfies ValidationReport;
  writeFileSync(join(root, "artifacts", "candidates", `${artifact.modelVersion}.validation.json`), `${canonicalJson(validation)}\n`);
  const markets = new Map<string, MarketInfo>([[VAULT, { vault: VAULT, coinYes: "+1", coinNo: "+2", underlying: "BTC", cluster: "crypto", direction: "up", title: "BTC", category: "crypto" }]]);
  return { root, artifact, raw, candidate, manifest, sources, markets, profile, validation };
}

function validate(fixture: ReturnType<typeof setup>, artifact = fixture.artifact, validation = fixture.validation): void {
  validateArtifact(`${canonicalJson(artifact)}\n`, { manifest: fixture.manifest, sources: fixture.sources, markets: fixture.markets, profile: fixture.profile, validation }, NOW);
}

test("artifact validation accepts the exact schema and immutable reference closure", () => {
  const fixture = setup();
  try {
    const result = validateArtifact(fixture.raw, fixture, NOW);
    assert.equal(result.artifact.modelVersion, "fixture");
    assert.equal((result.artifact as unknown as Record<string, unknown>).schemaVersion, 2);
    for (const key of ["network", "profileSha256", "marketRegistrySha256", "deploymentRegistrySha256", "baselineCorrelationSha256", "directPairs", "fallbackPairs", "quarantinedPairs"]) {
      assert.notEqual((result.artifact as unknown as Record<string, unknown>)[key], undefined, key);
    }
    assert.deepEqual([...result.model.eligibleUnderlyings], ["BTC", "ETH"]);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("artifact validation rejects malformed schema, model family, hashes, timestamps, diagnostics, and loadings", () => {
  const fixture = setup();
  try {
    const cases: [string, (artifact: Record<string, any>) => void][] = [
      ["schemaVersion", (a) => { a.schemaVersion = 1; }],
      ["modelFamily", (a) => { a.modelFamily = "other"; }],
      ["dataManifestSha256", (a) => { a.dataManifestSha256 = "bad"; }],
      ["createdAt", (a) => { a.createdAt = "2026-08-28"; }],
      ["policy", (a) => { a.policy.halfLifeDays = 44; }],
      ["finite", (a) => { a.quality.maxProjectionError = null; }],
      ["loadings explain", (a) => { a.clusters.crypto.BTC = { global: 0.8, cluster: 0.8, underlying: 0.1, underlyingBasis: "structural-underlying" }; }],
    ];
    for (const [message, mutate] of cases) {
      const artifact = structuredClone(fixture.artifact) as unknown as Record<string, any>;
      mutate(artifact);
      assert.throws(() => validate(fixture, artifact as unknown as CorrelationArtifact), new RegExp(message));
    }
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("artifact validation rejects manifest, source, market, and validation identity disagreement", () => {
  const fixture = setup();
  try {
    const manifestMismatch = structuredClone(fixture.artifact); manifestMismatch.dataManifestSha256 = "c".repeat(64);
    assert.throws(() => validate(fixture, manifestMismatch), /manifest hash mismatch/);
    const sourceMismatch = structuredClone(fixture.artifact); sourceMismatch.sourceRegistrySha256 = "c".repeat(64);
    assert.throws(() => validate(fixture, sourceMismatch), /source registry hash mismatch/);
    for (const key of ["profileSha256", "marketRegistrySha256", "deploymentRegistrySha256", "baselineCorrelationSha256"] as const) {
      const mismatch = structuredClone(fixture.artifact); mismatch[key] = "c".repeat(64);
      assert.throws(() => validate(fixture, mismatch), /profile identity mismatch/);
    }
    const badMarkets = new Map([...fixture.markets].map(([key, market]) => [key, { ...market, cluster: "equity" }]));
    assert.throws(() => validateArtifact(fixture.raw, { ...fixture, markets: badMarkets }, NOW), /cluster disagreement/);
    assert.throws(() => validate(fixture, fixture.artifact, { ...fixture.validation, candidateSha256: "d".repeat(64) }), /candidate hash mismatch/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("artifact validation requires exact eligible entries and every canonical pair once", () => {
  const fixture = setup();
  try {
    const missingEntry = structuredClone(fixture.artifact); delete missingEntry.clusters.crypto.ETH;
    assert.throws(() => validate(fixture, missingEntry), /eligible entries/);
    const missingPair = structuredClone(fixture.artifact); missingPair.quality.pairEligibility = [];
    assert.throws(() => validate(fixture, missingPair), /pair eligibility/);
    const duplicate = structuredClone(fixture.artifact); duplicate.quality.pairEligibility.push(duplicate.quality.pairEligibility[0]);
    assert.throws(() => validate(fixture, duplicate), /duplicate pair/);
    const reversed = structuredClone(fixture.artifact); reversed.quality.pairEligibility[0].pair = ["ETH", "BTC"];
    assert.throws(() => validate(fixture, reversed), /canonical pair/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("artifact validation requires operator approval for fallback pairs and quarantine reasons", () => {
  const fixture = setup();
  try {
    const fallback = structuredClone(fixture.artifact); fallback.quality.pairEligibility[0] = { pair: ["BTC", "ETH"], status: "fallback", reason: "operator-reviewed-testnet-bootstrap" }; fallback.directPairs = []; fallback.fallbackPairs = [{ pair: ["BTC", "ETH"], correlation: 0.05, reason: "operator-reviewed-testnet-bootstrap" }];
    assert.throws(() => validate(fixture, fallback), /fallback.*operator-approved/);
    const quarantined = structuredClone(fixture.artifact); quarantined.quality.quarantinedUnderlyings = [{ underlying: "ETH", reason: "" }]; quarantined.quality.eligibleUnderlyings = ["BTC"]; delete quarantined.clusters.crypto.ETH; quarantined.quality.pairEligibility[0] = { pair: ["BTC", "ETH"], status: "quarantined", reason: "missing" }; quarantined.directPairs = []; quarantined.quarantinedPairs = [{ pair: ["BTC", "ETH"], reason: "missing" }];
    assert.throws(() => validate(fixture, quarantined), /quarantine reason/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("artifact validation keeps measurement eligibility independent from approved fallback eligibility", () => {
  const fixture = setup();
  try {
    const sources = structuredClone(fixture.sources);
    sources.sources = sources.sources.map((entry) => ({ ...entry, measurementEnabled: entry.underlying === "ETH" ? false : entry.measurementEnabled, fallbackEligible: true }));
    const sourceRegistrySha256 = sha256(canonicalJson(sources));
    const profile = { ...fixture.profile, sources, sourceRegistrySha256 };
    const artifact = structuredClone(fixture.artifact);
    artifact.sourceRegistrySha256 = sourceRegistrySha256;
    artifact.quality.pairEligibility = [{ pair: ["BTC", "ETH"], status: "fallback", reason: "operator-reviewed-testnet-bootstrap" }];
    artifact.directPairs = [];
    artifact.fallbackPairs = [{ pair: ["BTC", "ETH"], correlation: 0.05, reason: "operator-reviewed-testnet-bootstrap" }];
    const manifest = { ...fixture.manifest, sourceRegistrySha256 };
    artifact.dataManifestSha256 = sha256(canonicalJson(manifest));
    const raw = `${canonicalJson(artifact)}\n`;
    const validation = { ...fixture.validation, inputManifestSha256: artifact.dataManifestSha256, candidateSha256: sha256(raw) };
    const result = validateArtifact(raw, { manifest, sources, markets: fixture.markets, profile, validation }, NOW);
    assert.deepEqual([...result.model.eligibleUnderlyings], ["BTC", "ETH"]);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("artifact validation repeats schedule-aware trailing freshness", () => {
  const fixture = setup();
  try {
    const session = structuredClone(fixture.sources);
    session.sources[1] = { ...session.sources[1], calendar: "session", session: { timeZone: "UTC", weekdays: [1, 2, 3, 4, 5], openLocal: "09:00", closeLocal: "17:00", closedDates: [] } };
    const weekend = structuredClone(fixture.artifact);
    weekend.dataAsOf = "2026-08-30T12:00:00.000Z";
    weekend.createdAt = "2026-08-30T12:00:00.000Z";
    weekend.quality.lastUsableObservationMs.BTC = Date.parse("2026-08-30T11:00:00.000Z");
    weekend.quality.lastUsableObservationMs.ETH = Date.parse("2026-08-28T16:00:00.000Z");
    const now = Date.parse("2026-08-30T18:00:00.000Z");
    const manifest = { ...fixture.manifest, sourceRegistrySha256: sha256(canonicalJson(session)), createdAt: weekend.createdAt };
    weekend.sourceRegistrySha256 = manifest.sourceRegistrySha256;
    weekend.dataManifestSha256 = sha256(canonicalJson(manifest));
    const profile = { ...fixture.profile, sources: session, sourceRegistrySha256: weekend.sourceRegistrySha256 };
    const validation = { ...fixture.validation, candidateSha256: sha256(`${canonicalJson(weekend)}\n`), inputManifestSha256: weekend.dataManifestSha256 };
    assert.doesNotThrow(() => validateArtifact(`${canonicalJson(weekend)}\n`, { manifest, sources: session, markets: fixture.markets, profile, validation }, now));
    weekend.quality.lastUsableObservationMs.BTC = Date.parse("2026-08-30T04:00:00.000Z");
    validation.candidateSha256 = sha256(`${canonicalJson(weekend)}\n`);
    assert.throws(() => validateArtifact(`${canonicalJson(weekend)}\n`, { manifest, sources: session, markets: fixture.markets, profile, validation }, now), /trailing freshness/);
    weekend.quality.lastUsableObservationMs.BTC = Date.parse("2026-08-30T11:00:00.000Z");
    weekend.quality.lastUsableObservationMs.ETH = Date.parse("2026-08-28T15:00:00.000Z");
    validation.candidateSha256 = sha256(`${canonicalJson(weekend)}\n`);
    assert.throws(() => validateArtifact(`${canonicalJson(weekend)}\n`, { manifest, sources: session, markets: fixture.markets, profile, validation }, now), /trailing freshness/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("artifact validation rejects a last usable observation after dataAsOf", () => {
  const fixture = setup();
  try {
    const future = structuredClone(fixture.artifact);
    future.quality.lastUsableObservationMs.BTC = Date.parse("2026-08-28T13:00:00.000Z");
    const validation = { ...fixture.validation, candidateSha256: sha256(`${canonicalJson(future)}\n`) };
    assert.throws(() => validate(fixture, future, validation), /future.*observation|trailing freshness/i);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("promotion refuses stale, rejected, unverified, and baseline-mismatched candidates", () => {
  for (const kind of ["stale", "rejected", "manifest", "baseline"] as const) {
    const fixture = setup(kind === "stale" ? STALE : VALID);
    try {
      if (kind === "rejected") {
        const rejected = { ...fixture.validation, decision: "Rejected" as const };
        writeFileSync(join(fixture.root, "artifacts", "candidates", `${fixture.artifact.modelVersion}.validation.json`), `${canonicalJson(rejected)}\n`);
      } else if (kind === "manifest") {
        writeFileSync(join(fixture.root, fixture.manifest.files[0].path), "changed");
      } else if (kind === "baseline") {
        writeFileSync(join(fixture.root, fixture.validation.baselineSnapshotPath), "changed");
      }
      assert.throws(() => promoteCandidate(fixture.root, fixture.candidate, fixture.profile, fixture.markets, NOW), new RegExp(kind === "stale" ? "30 hours" : kind, "i"));
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test("promotion writes the exact candidate bytes and a forced pre-rename failure preserves the old champion", () => {
  const fixture = setup();
  try {
    const artifacts = join(fixture.root, "artifacts");
    const champion = join(artifacts, "champion.json");
    writeFileSync(champion, "old champion\n");
    assert.throws(() => promoteCandidate(fixture.root, fixture.candidate, fixture.profile, fixture.markets, NOW, { beforeRename: () => { throw new Error("forced"); } }), /forced/);
    assert.equal(readFileSync(champion, "utf8"), "old champion\n");
    const receipt = promoteCandidate(fixture.root, fixture.candidate, fixture.profile, fixture.markets, NOW);
    assert.equal(readFileSync(champion, "utf8"), fixture.raw);
    assert.equal(receipt.championSha256, sha256(fixture.raw));
    assert.equal(receipt.validationState, "Supported");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("promotion CLI refuses automatic latest selection and requires an explicit candidate path", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/research/cli.ts", "promote", "--latest"], {
    cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", env: { RESEARCH_ROOT: "/tmp", CORRELATION_SOURCES_FILE: "/tmp/sources", MARKETS_FILE: "/tmp/markets" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--candidate/);
});

test("research CLI never loads a working-directory dotenv file", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-research-dotenv-"));
  const dotenv = join(root, ".env");
  const { RESEARCH_ROOT: _, ...env } = process.env;
  try {
    writeFileSync(dotenv, `RESEARCH_ROOT=${root}\n`);
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/research/cli.ts", "backup"], {
      cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", env: { ...env, DOTENV_CONFIG_PATH: dotenv },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /RESEARCH_ROOT is required/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
