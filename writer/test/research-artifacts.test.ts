import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { MarketInfo } from "../src/config.js";
import { parseCorrelationArtifact, promoteCandidate, validateArtifact } from "../src/research/artifacts.js";
import type { ValidationReport } from "../src/research/replay.js";
import { canonicalJson, sha256 } from "../src/research/store.js";
import type { CorrelationArtifact, DataManifest, DerivedManifestV2, SourceEntry, SourceRegistry } from "../src/research/types.js";
import { researchRootIdentity, type LoadedResearchNetworkProfile } from "../src/research/network.js";
import { fittedArtifact } from "./fixtures/research/fitted.js";

const NOW = Date.parse("2026-08-28T18:00:00.000Z");
const VALID = JSON.parse(readFileSync(new URL("./fixtures/research/artifact-valid.json", import.meta.url), "utf8")) as CorrelationArtifact;
const STALE = JSON.parse(readFileSync(new URL("./fixtures/research/artifact-stale.json", import.meta.url), "utf8")) as CorrelationArtifact;
const VAULT = "0x1111111111111111111111111111111111111111" as const;
const UNMAPPED_VAULT = "0x2222222222222222222222222222222222222222" as const;

const source = (underlying: string, fallbackEligible = false): SourceEntry => ({
  schemaVersion: 1, underlying, sourceNetwork: "testnet", sourceCoin: underlying, cluster: "crypto",
  calendar: "continuous", measurementEnabled: true, fallbackEligible,
});

function setup(artifactInput: CorrelationArtifact = VALID, fallbackEligible = false, legacy = false): {
  root: string; artifact: CorrelationArtifact; raw: string; candidate: string; manifest: DataManifest;
  sources: SourceRegistry; markets: Map<string, MarketInfo>; profile: LoadedResearchNetworkProfile; validation: ValidationReport; derivedManifestPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "hype-artifact-"));
  const sources: SourceRegistry = { schemaVersion: 2, network: "testnet", sources: [source("BTC", fallbackEligible), source("ETH", fallbackEligible)] };
  const sourceBytes = canonicalJson(sources);
  const sourceRegistrySha256 = sha256(sourceBytes);
  const sourcePath = join(root, "facts", "source-registries", `${sourceRegistrySha256}.json`);
  mkdirSync(join(root, "facts", "source-registries"), { recursive: true });
  writeFileSync(sourcePath, sourceBytes);
  const legacyArtifact = structuredClone(artifactInput);
  (legacyArtifact as unknown as Record<string, unknown>).schemaVersion = 2;
  const artifact = legacy ? legacyArtifact : fittedArtifact(legacyArtifact);
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
  writeFileSync(join(root, "network-profile.json"), `${canonicalJson(researchRootIdentity(profile))}\n`);
  mkdirSync(join(root, "facts", "market-registries"), { recursive: true });
  writeFileSync(join(root, "facts", "market-registries", `${profile.marketRegistrySha256}.json`), profile.marketRegistryRaw);
  artifact.network = "testnet";
  artifact.profileSha256 = profile.profileSha256;
  artifact.marketRegistrySha256 = profile.marketRegistrySha256;
  artifact.deploymentRegistrySha256 = profile.deploymentRegistrySha256;
  artifact.baselineCorrelationSha256 = profile.baselineCorrelationSha256;
  const manifest: DataManifest = {
    schemaVersion: 2,
    network: "testnet",
    profileSha256: profile.profileSha256,
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
  const baseline = profile.baselineCorrelationRaw;
  const baselineSha256 = sha256(baseline);
  mkdirSync(join(root, "facts", "baselines"), { recursive: true });
  writeFileSync(join(root, "facts", "baselines", `${baselineSha256}.json`), baseline);
  const returnsBytes = gzipSync("");
  const exclusionsBytes = gzipSync("");
  const returnsPath = "derived/returns-v2/returns/fixture.jsonl.gz";
  const exclusionsPath = "derived/returns-v2/exclusions/fixture.jsonl.gz";
  mkdirSync(join(root, "derived", "returns-v2", "returns"), { recursive: true });
  mkdirSync(join(root, "derived", "returns-v2", "exclusions"), { recursive: true });
  writeFileSync(join(root, returnsPath), returnsBytes);
  writeFileSync(join(root, exclusionsPath), exclusionsBytes);
  const derivedManifest: DerivedManifestV2 = {
    schemaVersion: 2, network: "testnet", transformationVersion: "returns-v2",
    dataManifestSha256: artifact.dataManifestSha256, sourceRegistrySha256: artifact.sourceRegistrySha256,
    window: { asOfMs: Date.parse(artifact.dataAsOf), lookbackMs: 180 * 86_400_000 },
    returns: { path: returnsPath, sha256: sha256(returnsBytes), rows: 0 },
    exclusions: { path: exclusionsPath, sha256: sha256(exclusionsBytes), rows: 0 },
  };
  const derivedManifestPath = "derived/returns-v2/fixture.manifest.json";
  const derivedManifestBytes = canonicalJson(derivedManifest);
  writeFileSync(join(root, derivedManifestPath), derivedManifestBytes);
  const validation = {
    schemaVersion: 3, network: profile.profile.network, profileSha256: profile.profileSha256, modelVersion: artifact.modelVersion, candidateSha256: sha256(raw), inputManifestSha256: artifact.dataManifestSha256,
    derivedManifestPath, derivedManifestSha256: sha256(derivedManifestBytes), returnsSha256: derivedManifest.returns.sha256, exclusionsSha256: derivedManifest.exclusions.sha256, derivationWindow: derivedManifest.window,
    sourceRegistrySha256: artifact.sourceRegistrySha256, marketRegistrySha256: artifact.marketRegistrySha256,
    deploymentRegistrySha256: artifact.deploymentRegistrySha256, baselineCorrelationSha256: artifact.baselineCorrelationSha256,
    baselineSha256, baselineSnapshotPath: `facts/baselines/${baselineSha256}.json`, seed: "fixture", drawCount: 20_000, originStrideHours: 24 as const,
    policy: { maxProjectionError: 0.10 as const, bootstrapBlockHours: 96 as const, bootstrapSamples: 2_000 as const }, ticketCounts: {}, selectedTicketKeys: [], modelScores: {} as ValidationReport["modelScores"],
    bootstrap: { point: -0.01, lower: -0.02, upper: 0, groups: [], samples: 2_000, blockHours: 96 }, stressThresholds: [], degreeOfFreedomSelections: [], exclusions: [], decision: "Supported" as const,
    deterministicRerunMatches: true, resourcePolicy: { maxWallClockMs: 30_000 as const, maxPeakRssBytes: 536_870_912 as const }, limitations: [],
  } satisfies ValidationReport;
  writeFileSync(join(root, "artifacts", "candidates", `${artifact.modelVersion}.validation.json`), `${canonicalJson(validation)}\n`);
  const markets = new Map<string, MarketInfo>([[VAULT, { vault: VAULT, coinYes: "+1", coinNo: "+2", underlying: "BTC", cluster: "crypto", direction: "up", title: "BTC", category: "crypto" }]]);
  return { root, artifact, raw, candidate, manifest, sources, markets, profile, validation, derivedManifestPath };
}

function validate(fixture: ReturnType<typeof setup>, artifact = fixture.artifact, validation = fixture.validation): void {
  validateArtifact(`${canonicalJson(artifact)}\n`, { manifest: fixture.manifest, sources: fixture.sources, markets: fixture.markets, profile: fixture.profile, validation }, NOW);
}

test("artifact validation accepts the exact schema and immutable reference closure", () => {
  const fixture = setup();
  try {
    const result = validateArtifact(fixture.raw, fixture, NOW);
    assert.equal(result.artifact.modelVersion, "fixture");
    assert.equal((result.artifact as unknown as Record<string, unknown>).schemaVersion, 3);
    for (const key of ["network", "profileSha256", "marketRegistrySha256", "deploymentRegistrySha256", "baselineCorrelationSha256", "directPairs", "fallbackPairs", "quarantinedPairs"]) {
      assert.notEqual((result.artifact as unknown as Record<string, unknown>)[key], undefined, key);
    }
    assert.deepEqual([...result.model.eligibleUnderlyings], ["BTC", "ETH"]);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("artifact validation accepts an exact market registry with an unmapped underlying", () => {
  const fixture = setup();
  try {
    const markets = new Map(fixture.markets);
    markets.set(UNMAPPED_VAULT, {
      vault: UNMAPPED_VAULT, coinYes: "+3", coinNo: "+4", underlying: "XYZ100", cluster: "legacy-index",
      direction: "up", title: "XYZ100 above 100?", category: "index",
    });
    const marketRegistryRaw = canonicalJson({ schemaVersion: 1, network: "testnet", markets: [...markets.values()] });
    const marketRegistrySha256 = sha256(marketRegistryRaw);
    const profile = { ...fixture.profile, marketRegistryRaw, marketRegistrySha256 };
    const artifact = { ...fixture.artifact, marketRegistrySha256 };
    const raw = `${canonicalJson(artifact)}\n`;
    const validation = { ...fixture.validation, marketRegistrySha256, candidateSha256: sha256(raw) };

    const result = validateArtifact(raw, { ...fixture, markets, profile, validation }, NOW);

    assert.equal(result.model.marketRegistrySha256, marketRegistrySha256);
    assert.equal(result.model.version, "fixture");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("default parsing and promotion reject over-policy projection error", () => {
  const fixture = setup();
  try {
    const artifact = structuredClone(fixture.artifact);
    artifact.quality.maxProjectionError = 0.314324004721122;
    const raw = `${canonicalJson(artifact)}\n`;
    assert.throws(() => parseCorrelationArtifact(raw, NOW, fixture.sources, fixture.markets, fixture.profile), /maxProjectionError exceeds policy/);
    writeFileSync(fixture.candidate, raw);
    writeFileSync(join(fixture.root, "artifacts", "candidates", `${artifact.modelVersion}.validation.json`), `${canonicalJson({ ...fixture.validation, candidateSha256: sha256(raw), decision: "Rejected" })}\n`);
    assert.throws(() => promoteCandidate(fixture.root, fixture.candidate, fixture.profile, fixture.markets, NOW), /maxProjectionError exceeds policy/);
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
      ["inside \\[-1, 1\\]", (a) => { a.clusters.crypto.BTC.global = 1.5; }],
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
    assert.throws(() => validateArtifact(fixture.raw, { ...fixture, markets: badMarkets }, NOW), /source\/market cluster disagreement for BTC/);
    assert.throws(() => validate(fixture, fixture.artifact, { ...fixture.validation, candidateSha256: "d".repeat(64) }), /candidate hash mismatch/);
    assert.throws(() => validate(fixture, fixture.artifact, { ...fixture.validation, network: "mainnet" }), /validation network mismatch/);
    assert.throws(() => validate(fixture, fixture.artifact, { ...fixture.validation, deploymentRegistrySha256: "d".repeat(64) }), /validation deployment registry mismatch/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("promotion requires Supported validation and the root profile marker", () => {
  const fixture = setup();
  try {
    writeFileSync(join(fixture.root, "network-profile.json"), `${canonicalJson({ ...researchRootIdentity(fixture.profile), network: "mainnet", profileSha256: "0".repeat(64) })}\n`);
    assert.throws(() => promoteCandidate(fixture.root, fixture.candidate, fixture.profile, fixture.markets, NOW), /research root network\/profile marker mismatch/);
    writeFileSync(join(fixture.root, "network-profile.json"), `${canonicalJson(researchRootIdentity(fixture.profile))}\n`);
    writeFileSync(join(fixture.root, "artifacts", "candidates", `${fixture.artifact.modelVersion}.validation.json`), `${canonicalJson({ ...fixture.validation, decision: "Inconclusive" })}\n`);
    assert.throws(() => promoteCandidate(fixture.root, fixture.candidate, fixture.profile, fixture.markets, NOW), /Supported validation/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("promotion rejects mutated derived returns, exclusions, and derivation window", () => {
  for (const kind of ["returns", "exclusions", "window"] as const) {
    const fixture = setup();
    try {
      const manifestFile = join(fixture.root, fixture.derivedManifestPath);
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as DerivedManifestV2;
      if (kind === "window") {
        manifest.window.lookbackMs += 1;
        writeFileSync(manifestFile, canonicalJson(manifest));
      } else {
        writeFileSync(join(fixture.root, manifest[kind].path), gzipSync(`${canonicalJson({ mutated: true })}\n`));
      }
      assert.throws(() => promoteCandidate(fixture.root, fixture.candidate, fixture.profile, fixture.markets, NOW), /derived manifest/);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
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
    const fallback = structuredClone(fixture.artifact); fallback.quality.pairEligibility[0] = { pair: ["BTC", "ETH"], status: "fallback", reason: "operator-reviewed-testnet-bootstrap" }; fallback.directPairs = []; fallback.fallbackPairs = [{ pair: ["BTC", "ETH"], correlation: 0.05000000000000001, reason: "operator-reviewed-testnet-bootstrap" }];
    assert.throws(() => validate(fixture, fittedArtifact(fallback)), /fallback.*operator-approved/);
    const quarantined = structuredClone(fixture.artifact); quarantined.quality.quarantinedUnderlyings = [{ underlying: "ETH", reason: "" }]; quarantined.quality.eligibleUnderlyings = ["BTC"]; delete quarantined.clusters.crypto.ETH; quarantined.quality.pairEligibility[0] = { pair: ["BTC", "ETH"], status: "quarantined", reason: "missing" }; quarantined.directPairs = []; quarantined.quarantinedPairs = [{ pair: ["BTC", "ETH"], reason: "missing" }];
    assert.throws(() => validate(fixture, fittedArtifact(quarantined)), /quarantine reason/);
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
    artifact.fallbackPairs = [{ pair: ["BTC", "ETH"], correlation: 0.05000000000000001, reason: "operator-reviewed-testnet-bootstrap" }];
    Object.assign(artifact, fittedArtifact(artifact));
    const manifest = { ...fixture.manifest, sourceRegistrySha256 };
    artifact.dataManifestSha256 = sha256(canonicalJson(manifest));
    const raw = `${canonicalJson(artifact)}\n`;
    const validation = { ...fixture.validation, sourceRegistrySha256, inputManifestSha256: artifact.dataManifestSha256, candidateSha256: sha256(raw) };
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
    const validation = { ...fixture.validation, sourceRegistrySha256: weekend.sourceRegistrySha256, candidateSha256: sha256(`${canonicalJson(weekend)}\n`), inputManifestSha256: weekend.dataManifestSha256 };
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

test("promotion rejects fallback values and eligibility reasons that differ from the exact approved baseline", () => {
  for (const kind of ["correlation", "reason", "missing"] as const) {
    const fixture = setup(VALID, true);
    try {
      const artifact = structuredClone(fixture.artifact);
      artifact.quality.pairEligibility = [{ pair: ["BTC", "ETH"], status: "fallback", reason: kind === "reason" ? "wrong-reason" : "operator-reviewed-testnet-bootstrap" }];
      artifact.directPairs = [];
      artifact.fallbackPairs = [{ pair: ["BTC", "ETH"], correlation: kind === "correlation" ? 0.7 : 0.05000000000000001, reason: "operator-reviewed-testnet-bootstrap" }];
      let profile = fixture.profile;
      if (kind === "missing") {
        const baseline = JSON.parse(profile.baselineCorrelationRaw);
        delete baseline.clusters.crypto.ETH;
        const baselineCorrelationRaw = canonicalJson(baseline);
        profile = { ...profile, baselineCorrelationRaw, baselineCorrelationSha256: sha256(baselineCorrelationRaw) };
        artifact.baselineCorrelationSha256 = profile.baselineCorrelationSha256;
        writeFileSync(join(fixture.root, "network-profile.json"), `${canonicalJson(researchRootIdentity(profile))}\n`);
      }
      const raw = `${canonicalJson(artifact)}\n`;
      writeFileSync(fixture.candidate, raw);
      writeFileSync(join(fixture.root, "artifacts", "candidates", `${artifact.modelVersion}.validation.json`), `${canonicalJson({ ...fixture.validation, candidateSha256: sha256(raw) })}\n`);
      assert.throws(() => promoteCandidate(fixture.root, fixture.candidate, profile, fixture.markets, NOW), /fallback|pair eligibility/i);
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
    assert.equal(receipt.schemaVersion, 2);
    assert.equal(receipt.network, "testnet");
    assert.equal(receipt.profileSha256, fixture.profile.profileSha256);
    assert.equal(receipt.deploymentRegistrySha256, fixture.profile.deploymentRegistrySha256);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("promotion CLI refuses automatic latest selection and requires an explicit candidate path", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/research/cli.ts", "promote", "--latest"], {
    cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", env: { RESEARCH_ROOT: "/tmp" },
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
    assert.match(result.stderr, /RESEARCH_ROOT and RESEARCH_NETWORK_PROFILE_FILE are required/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy schemaVersion 2 artifacts stay readable but are never activation-eligible", () => {
  const fixture = setup(VALID, false, true);
  try {
    const parsed = parseCorrelationArtifact(fixture.raw, NOW, fixture.sources, fixture.markets, fixture.profile);
    assert.equal(parsed.artifact.schemaVersion, 2);
    assert.equal(parsed.model.multiAssetEnabled, false);
    assert.equal(parsed.model.version, "fixture");
    assert.throws(() => validateArtifact(fixture.raw, fixture, NOW), /not activation-eligible/);
    const champion = join(fixture.root, "artifacts", "champion.json");
    writeFileSync(champion, "historical champion\n");
    assert.throws(() => promoteCandidate(fixture.root, fixture.candidate, fixture.profile, fixture.markets, NOW), /not activation-eligible/);
    assert.equal(readFileSync(champion, "utf8"), "historical champion\n");
    assert.equal(readFileSync(fixture.candidate, "utf8"), fixture.raw);
    const ambiguous = { ...structuredClone(fixture.artifact), pairEvidence: [] };
    assert.throws(() => parseCorrelationArtifact(`${canonicalJson(ambiguous)}\n`, NOW), /legacy artifacts must not carry pairEvidence/);
    const negative = structuredClone(fixture.artifact); negative.clusters.crypto.BTC.global = -0.1;
    assert.throws(() => parseCorrelationArtifact(`${canonicalJson(negative)}\n`, NOW), /inside \[0, 1\]/, "legacy loadings stay unsigned");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("fitted artifacts fail closed on policy drift, rewritten evidence, and inconsistent gates", () => {
  const fixture = setup();
  try {
    const cases: [string, (artifact: Record<string, any>) => void][] = [
      ["modelFamily must be signed-asset-factor", (a) => { a.modelFamily = "hierarchical-gaussian-factor"; }],
      ["approved fit policy", (a) => { a.policy.maxDirectResidual = 0.1; }],
      ["approved fit policy", (a) => { delete a.policy.omegaFallback; }],
      ["pairEvidence must be an array", (a) => { delete a.pairEvidence; }],
      ["every canonical pair exactly once", (a) => { a.pairEvidence = []; }],
      ["duplicates", (a) => { a.pairEvidence.push(structuredClone(a.pairEvidence[0])); }],
      ["unknown pair", (a) => { a.pairEvidence[0].pair = ["BTC", "SOL"]; }],
      ["disagrees with pair eligibility", (a) => { a.pairEvidence[0].evidence = "fallback"; a.pairEvidence[0].weight = 30; a.pairEvidence[0].mode = null; a.pairEvidence[0].effectiveN = null; a.pairEvidence[0].interval = null; }],
      ["residual is inconsistent", (a) => { a.pairEvidence[0].fitted += 0.2; }],
      ["gate result disagrees", (a) => { a.pairEvidence[0].fitted += 0.2; a.pairEvidence[0].residual = 0.2; }],
      ["fails its residual gate", (a) => { a.pairEvidence[0].fitted += 0.2; a.pairEvidence[0].residual = 0.2; a.pairEvidence[0].gate = { passed: false, reason: "direct-residual-out-of-range" }; }],
      ["gate result disagrees", (a) => { a.pairEvidence[0].gate.passed = false; }],
      ["gate result disagrees", (a) => { a.pairEvidence[0].gate.reason = "relabeled"; }],
      ["target differs", (a) => { a.pairEvidence[0].target = 0.06; a.pairEvidence[0].fitted = 0.06; }],
      ["interval m must equal", (a) => { a.pairEvidence[0].interval.m = 6; }],
      ["nest around the target", (a) => { a.pairEvidence[0].interval.lower = 0.06; }],
      ["positive effectiveN", (a) => { a.pairEvidence[0].effectiveN = 0; }],
      ["invalid fields", (a) => { a.pairEvidence[0].extra = 1; }],
      ["structural residual", (a) => { a.clusters.crypto.BTC.underlying = 0.3; }],
      ["inside \\[-1, 1\\]", (a) => { a.clusters.crypto.BTC.global = -1.2; }],
    ];
    for (const [message, mutate] of cases) {
      const artifact = structuredClone(fixture.artifact) as unknown as Record<string, any>;
      mutate(artifact);
      assert.throws(() => validate(fixture, artifact as unknown as CorrelationArtifact), new RegExp(message), message);
    }
    // R3: signed loadings are valid schemaVersion 3 evidence when the structural residual still matches.
    const signed = structuredClone(fixture.artifact) as unknown as Record<string, any>;
    signed.clusters.crypto.BTC.global = -0.1;
    signed.clusters.crypto.BTC.cluster = -0.2;
    assert.equal(parseCorrelationArtifact(`${canonicalJson(signed)}\n`, NOW, fixture.sources, fixture.markets, fixture.profile).artifact.clusters.crypto.BTC.global, -0.1);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("promotion verifies the candidate-time market registry snapshot bytes", () => {
  const fixture = setup();
  try {
    const snapshot = join(fixture.root, "facts", "market-registries", `${fixture.profile.marketRegistrySha256}.json`);
    rmSync(snapshot, { force: true });
    assert.throws(() => promoteCandidate(fixture.root, fixture.candidate, fixture.profile, fixture.markets, NOW), /market registry snapshot/);
    writeFileSync(snapshot, canonicalJson({ schemaVersion: 1, network: "testnet", markets: [], rewritten: true }));
    assert.throws(() => promoteCandidate(fixture.root, fixture.candidate, fixture.profile, fixture.markets, NOW), /market registry snapshot/);
    writeFileSync(snapshot, fixture.profile.marketRegistryRaw);
    assert.equal(promoteCandidate(fixture.root, fixture.candidate, fixture.profile, fixture.markets, NOW).marketRegistrySha256, fixture.profile.marketRegistrySha256);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
