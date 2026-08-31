import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { generateReport, journalFunnel, renderReport, type ReportInput } from "../src/research/report.js";
import { writeOperationRecord } from "../src/research/operations.js";
import { openResearchPersistence } from "../src/research/persistence.js";
import { canonicalJson, sha256 } from "../src/research/store.js";
import { loadResearchNetworkProfile, researchRootIdentity } from "../src/research/network.js";
import type { JoinedEventRecord, QuoteDecision } from "../src/research/types.js";

const testnetProfile = loadResearchNetworkProfile(new URL("../../registry/research-network.testnet.json", import.meta.url).pathname);

const score = {
  overall: { rows: 12, eligibleRows: 10, logLoss: 0.4, brier: 0.2, calibration: [{ lower: 0, upper: 0.1, rows: 2, meanProbability: 0.05, observedRate: 0 }], sharpness: 0.03, exclusions: [{ reason: "band-market" as const, rows: 2 }] },
  byWindow: {}, byHorizon: {}, byTicketSize: {}, byClusterCombination: {}, byDirection: {},
  byStressRegime: { normal: { rows: 10, eligibleRows: 10, logLoss: 0.4, brier: 0.2, calibration: [], sharpness: 0.03, exclusions: [], gateEligible: true, exclusionReason: null } },
};

const input: ReportInput = {
  manifest: {
    schemaVersion: 2 as const, network: "testnet" as const, profileSha256: "b".repeat(64), createdAt: "2026-08-27T03:00:00.000Z", sourceRegistrySha256: "c".repeat(64), sourceRange: { fromMs: 1, toMs: 2 },
    underlyings: {
      "<script>": { rows: 90, firstUsableObservationMs: 1, lastUsableObservationMs: 2, missingIntervals: [3] },
      BTC: { rows: 100, firstUsableObservationMs: 1, lastUsableObservationMs: 2, missingIntervals: [] },
    }, files: [],
  },
  candidate: {
    schemaVersion: 2 as const, network: "testnet" as const, profileSha256: "b".repeat(64), marketRegistrySha256: "d".repeat(64), deploymentRegistrySha256: "e".repeat(64), baselineCorrelationSha256: "f".repeat(64),
    modelVersion: "beta-1", modelFamily: "hierarchical-gaussian-factor" as const,
    createdAt: "2026-08-27T03:00:00.000Z", dataAsOf: "2026-08-27T00:00:00.000Z", dataManifestSha256: "a".repeat(64), sourceRegistrySha256: "c".repeat(64), directPairs: [], fallbackPairs: [], quarantinedPairs: [{ pair: ["<script>", "BTC"] as [string, string], reason: "coverage-below-80pct" }],
    policy: { lookbackDays: 180 as const, halfLifeDays: 45 as const, diagnosticWindowsDays: [30, 90, 180] as [30, 90, 180], minHourly: 1000, minDaily: 90, minCoverage: 0.8, maxProjectionError: 0.10 as const },
    quality: {
      matrixOrder: ["<script>", "BTC"], eligibleUnderlyings: ["BTC"], quarantinedUnderlyings: [{ underlying: "<script>", reason: "coverage-below-80pct" }],
      pairEligibility: [{ pair: ["<script>", "BTC"] as [string, string], status: "quarantined" as const, reason: "coverage-below-80pct" }],
      lastUsableObservationMs: { "<script>": 2, BTC: 2 },
      pairDiagnostics: [{ pair: ["<script>", "BTC"] as [string, string], mode: "daily", observations: 90, expected: 100, coverage: 0.9, effectiveN: 80, raw: -0.4, shrinkTarget: 0, shrinkLambda: 0.1, target: -0.3, implied: -0.2, residual: -0.1, fallbackUsed: false }],
      maxProjectionError: 0.02, highamProjectionDelta: 0.01, clippedNegativePairs: [{ pair: ["<script>", "BTC"] as [string, string], target: -0.3 }],
      signedPsdTarget: [[1, -0.2], [-0.2, 1]], diagnosticMatrices: { "30": [[1, -0.1], [-0.1, 1]], "90": [[1, -0.2], [-0.2, 1]], "180": [[1, -0.3], [-0.3, 1]] },
    }, validation: { status: "pending" as const }, clusters: {},
  },
  validation: {
    schemaVersion: 3 as const, network: "testnet" as const, profileSha256: "b".repeat(64), modelVersion: "beta-1", candidateSha256: "d".repeat(64), inputManifestSha256: "a".repeat(64),
    derivedManifestPath: "derived/returns-v2/fixture.manifest.json", derivedManifestSha256: "1".repeat(64), returnsSha256: "2".repeat(64), exclusionsSha256: "3".repeat(64), derivationWindow: { asOfMs: 2, lookbackMs: 1 },
    sourceRegistrySha256: "c".repeat(64), marketRegistrySha256: "d".repeat(64), deploymentRegistrySha256: "e".repeat(64), baselineCorrelationSha256: "f".repeat(64), baselineSha256: "f".repeat(64), baselineSnapshotPath: "facts/baselines/f.json",
    seed: "fixture", drawCount: 20_000, originStrideHours: 24 as const, policy: { maxProjectionError: 0.10 as const, bootstrapBlockHours: 96 as const, bootstrapSamples: 2_000 as const },
    ticketCounts: {}, selectedTicketKeys: [], modelScores: {
      independence: score, "static-hierarchical-gaussian": score, "measured-hierarchical-gaussian": score, "signed-t-copula": score, "filtered-historical-simulation": score,
    }, bootstrap: { point: -0.01, lower: -0.02, upper: 0, groups: [], samples: 2_000, blockHours: 96 },
    stressThresholds: [], degreeOfFreedomSelections: [], exclusions: [{ originMs: null, ticketKey: null, model: null, reason: "band-market" as const }],
    decision: "Supported" as const, deterministicRerunMatches: true, resourcePolicy: { maxWallClockMs: 30_000 as const, maxPeakRssBytes: 536_870_912 as const }, limitations: [],
  },
  champion: { modelVersion: "beta-1", sha256: "b".repeat(64) },
  candidateSha256: "1".repeat(64),
  validationSha256: "2".repeat(64),
  funnel: { quotes: 4, minted: 3, resolved: 2 },
  failures: [],
  exclusions: [
    { schemaVersion: 1 as const, stage: "returns" as const, underlying: "<missing>", peerUnderlying: null, timestampMs: 3, reason: "missing-interval" as const, sourceKeys: [] },
    { schemaVersion: 1 as const, stage: "returns" as const, underlying: "BTC", peerUnderlying: "ETH", timestampMs: null, reason: "no-synchronized-peer" as const, sourceKeys: [] },
  ],
};

test("research report renders deterministic escaped evidence with every required caveat", () => {
  const html = renderReport(input);
  assert.equal(renderReport(structuredClone(input)), html);
  for (const fragment of readFileSync(new URL("./fixtures/research/report-expected.html", import.meta.url), "utf8").trim().split("\n")) assert.ok(html.includes(fragment), `missing report fragment: ${fragment}`);
  assert.equal(html.includes("<script>"), false);
  assert.match(html, /missing-interval<\/td><td>1/);
  assert.match(html, /no-synchronized-peer<\/td><td>1/);
  assert.equal(html.includes("<missing>"), false);
  assert.match(html, /<style>[\s\S]*<\/style>/);
  assert.equal(/<(?:link|script)\b/i.test(html), false);
  for (const hash of [input.candidateSha256, input.candidate.dataManifestSha256, input.champion!.sha256, input.candidate.profileSha256, input.validationSha256]) assert.ok(html.includes(hash));
});

test("journal funnel joins only quoted canonical mints to their matching parlay resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-report-funnel-"));
  try {
    writeFileSync(join(root, "network-profile.json"), `${canonicalJson(researchRootIdentity(testnetProfile))}\n`);
    const quote: QuoteDecision = {
      schemaVersion: 3, network: "testnet", profileSha256: testnetProfile.profileSha256, marketRegistrySha256: testnetProfile.marketRegistrySha256,
      deploymentRegistrySha256: testnetProfile.deploymentRegistrySha256, baselineCorrelationSha256: testnetProfile.baselineCorrelationSha256,
      artifactKind: "profile-baseline", artifactSha256: testnetProfile.baselineCorrelationSha256, validationSha256: null, validationState: "Unavailable",
      pairDecisions: [], recordedAtMs: 1_725_000_000_000, quoteId: "q1", quoteDigest: "0x02", chainId: testnetProfile.profile.evmChainId,
      parlayVault: testnetProfile.deployment.parlayVault, taker: "0x2222222222222222222222222222222222222222",
      legs: [{ vault: "0x3333333333333333333333333333333333333333", isYes: true, underlying: "BTC", cluster: "crypto", direction: "up", outcomeCoin: "+1" }],
      bookInputs: [{ priceWad: "500000000000000000", source: "l2Book", observedAtMs: 1_725_000_000_000, depthWad: null, vwapWad: null, freshnessMs: null }],
      modelVersion: "profile-baseline", dataAsOf: new Date(0).toISOString(), dataManifestSha256: testnetProfile.baselineCorrelationSha256,
      sourceRegistrySha256: testnetProfile.sourceRegistrySha256, bestEstimateJointProbWad: "1", riskAdjustedJointProbWad: "1", rhoBandPct: 0,
      edge: { baseBps: "0", legBps: "0", totalBps: "0" }, premium: "1", maxPayout: "4", deadline: "1", signatureHash: "c".repeat(64),
    };
    mkdirSync(join(root, "journal", "quotes"), { recursive: true });
    const quotesPath = join(root, "journal", "quotes", "quotes.jsonl");
    writeFileSync(quotesPath, `${canonicalJson(quote)}\n`);
    mkdirSync(join(root, "journal", "events"), { recursive: true });
    const identity = { schemaVersion: 2 as const, network: "testnet" as const, profileSha256: testnetProfile.profileSha256, deploymentRegistrySha256: testnetProfile.deploymentRegistrySha256 };
    const rows: JoinedEventRecord[] = [
      { ...identity, kind: "minted", eventKey: "tx1:0", blockNumber: "1", blockHash: "0xaaa", transactionHash: "0xtx1", logIndex: 0, quoteId: "q1", parlayId: "1", taker: quote.taker, premium: "1", maxPayout: "4", status: "open", legs: [], recordedAtMs: 1 },
      { ...identity, kind: "resolved", eventKey: "tx2:0", blockNumber: "2", blockHash: "0xbbb", transactionHash: "0xtx2", logIndex: 0, quoteId: "q1", parlayId: "1", taker: null, premium: null, maxPayout: null, status: "won", legs: [], recordedAtMs: 2 },
    ];
    const eventsPath = join(root, "journal", "events", "events.jsonl");
    writeFileSync(eventsPath, `${rows.map(canonicalJson).join("\n")}\n`);
    assert.deepEqual(journalFunnel(root, testnetProfile), { quotes: 1, minted: 1, resolved: 1 });

    for (const mixed of [
      { ...quote, profileSha256: "0".repeat(64) },
      { ...quote, sourceRegistrySha256: "0".repeat(64) },
      { ...quote, marketRegistrySha256: "0".repeat(64) },
      { ...quote, deploymentRegistrySha256: "0".repeat(64) },
      { ...quote, baselineCorrelationSha256: "0".repeat(64), artifactSha256: "0".repeat(64) },
    ]) {
      writeFileSync(quotesPath, `${canonicalJson(quote)}\n${canonicalJson(mixed)}\n`);
      assert.throws(() => journalFunnel(root, testnetProfile), /mismatch/);
    }
    writeFileSync(quotesPath, `${canonicalJson(quote)}\nnot-json\n`);
    assert.throws(() => journalFunnel(root, testnetProfile), /journal row is malformed/);
    writeFileSync(quotesPath, `${canonicalJson(quote)}\n`);
    writeFileSync(eventsPath, `${canonicalJson(rows[0])}\n${canonicalJson({ ...rows[1], profileSha256: "0".repeat(64) })}\n`);
    assert.throws(() => journalFunnel(root, testnetProfile), /mismatch/);
    writeFileSync(eventsPath, `${canonicalJson(rows[0])}\n[]\n`);
    assert.throws(() => journalFunnel(root, testnetProfile), /event journal row is invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("generateReport renders exact Rejected projection evidence without a champion", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-report-rejected-"));
  try {
    const candidate = JSON.parse(readFileSync(new URL("./fixtures/research/artifact-valid.json", import.meta.url), "utf8"));
    const sources = {
      schemaVersion: 2, network: "testnet", sources: ["BTC", "ETH"].map((underlying) => ({
        schemaVersion: 1, underlying, sourceNetwork: "testnet", sourceCoin: underlying, cluster: "crypto", calendar: "continuous", measurementEnabled: true, fallbackEligible: true,
      })),
    };
    const profileValue = { schemaVersion: 1, network: "testnet", infoApiUrl: "https://api.hyperliquid-testnet.xyz/info", evmChainId: 998, sourceRegistryFile: "sources.json", marketRegistryFile: "markets.json", deploymentRegistryFile: "deployment.json", baselineCorrelationFile: "baseline.json" };
    const markets = { schemaVersion: 1, network: "testnet", markets: [] };
    const deployment = { schemaVersion: 1, network: "testnet", evmChainId: 998, parlayVault: "0x1111111111111111111111111111111111111111", parlayDeployBlock: "1" };
    const baseline = { network: "testnet", fallbackReason: "operator-reviewed-testnet-bootstrap", clusters: candidate.clusters };
    for (const [file, value] of [["sources.json", sources], ["markets.json", markets], ["deployment.json", deployment], ["baseline.json", baseline], ["profile.json", profileValue]] as const) writeFileSync(join(root, file), canonicalJson(value));
    const profile = loadResearchNetworkProfile(join(root, "profile.json"));
    writeFileSync(join(root, "network-profile.json"), `${canonicalJson(researchRootIdentity(profile))}\n`);
    const sourceBytes = canonicalJson(sources);
    const sourcePath = `facts/source-registries/${profile.sourceRegistrySha256}.json`;
    mkdirSync(join(root, "facts", "source-registries"), { recursive: true });
    writeFileSync(join(root, sourcePath), sourceBytes);
    const manifest = {
      schemaVersion: 2, network: "testnet", profileSha256: profile.profileSha256, createdAt: candidate.createdAt, sourceRegistrySha256: profile.sourceRegistrySha256,
      sourceRange: { fromMs: 1, toMs: 2 }, underlyings: Object.fromEntries(["BTC", "ETH"].map((underlying) => [underlying, { rows: 0, firstUsableObservationMs: null, lastUsableObservationMs: null, missingIntervals: [] }])),
      files: [{ path: sourcePath, bytes: statSync(join(root, sourcePath)).size, sha256: profile.sourceRegistrySha256, rows: 1, schemaVersion: 1 }],
    };
    Object.assign(candidate, {
      modelVersion: "rejected-projection", profileSha256: profile.profileSha256, sourceRegistrySha256: profile.sourceRegistrySha256,
      marketRegistrySha256: profile.marketRegistrySha256, deploymentRegistrySha256: profile.deploymentRegistrySha256,
      baselineCorrelationSha256: profile.baselineCorrelationSha256, dataManifestSha256: sha256(canonicalJson(manifest)),
    });
    candidate.quality.maxProjectionError = 0.314324004721122;
    const candidateBytes = `${canonicalJson(candidate)}\n`;
    mkdirSync(join(root, "manifests"), { recursive: true });
    writeFileSync(join(root, "manifests", `${candidate.dataManifestSha256}.json`), canonicalJson(manifest));
    const returnsPath = "derived/returns-v2/returns/rejected.jsonl.gz";
    const exclusionsPath = "derived/returns-v2/exclusions/rejected.jsonl.gz";
    const returnsBytes = gzipSync("");
    const exclusionsBytes = gzipSync("");
    mkdirSync(join(root, "derived", "returns-v2", "returns"), { recursive: true });
    mkdirSync(join(root, "derived", "returns-v2", "exclusions"), { recursive: true });
    writeFileSync(join(root, returnsPath), returnsBytes);
    writeFileSync(join(root, exclusionsPath), exclusionsBytes);
    const derivedManifestPath = "derived/returns-v2/rejected.manifest.json";
    const derivedManifestBytes = canonicalJson({
      schemaVersion: 2, network: "testnet", transformationVersion: "returns-v2", dataManifestSha256: candidate.dataManifestSha256, sourceRegistrySha256: profile.sourceRegistrySha256,
      window: { asOfMs: Date.parse(candidate.dataAsOf), lookbackMs: 180 * 86_400_000 }, returns: { path: returnsPath, sha256: sha256(returnsBytes), rows: 0 }, exclusions: { path: exclusionsPath, sha256: sha256(exclusionsBytes), rows: 0 },
    });
    writeFileSync(join(root, derivedManifestPath), derivedManifestBytes);
    mkdirSync(join(root, "facts", "baselines"), { recursive: true });
    writeFileSync(join(root, "facts", "baselines", `${profile.baselineCorrelationSha256}.json`), profile.baselineCorrelationRaw);
    const validation = structuredClone(input.validation);
    Object.assign(validation, {
      network: "testnet", profileSha256: profile.profileSha256, modelVersion: candidate.modelVersion, candidateSha256: sha256(candidateBytes), inputManifestSha256: candidate.dataManifestSha256,
      derivedManifestPath, derivedManifestSha256: sha256(derivedManifestBytes), returnsSha256: sha256(returnsBytes), exclusionsSha256: sha256(exclusionsBytes), derivationWindow: { asOfMs: Date.parse(candidate.dataAsOf), lookbackMs: 180 * 86_400_000 },
      sourceRegistrySha256: profile.sourceRegistrySha256, marketRegistrySha256: profile.marketRegistrySha256, deploymentRegistrySha256: profile.deploymentRegistrySha256,
      baselineCorrelationSha256: profile.baselineCorrelationSha256, baselineSha256: profile.baselineCorrelationSha256, baselineSnapshotPath: `facts/baselines/${profile.baselineCorrelationSha256}.json`, decision: "Rejected", deterministicRerunMatches: true,
    });
    mkdirSync(join(root, "artifacts", "candidates"), { recursive: true });
    const candidatePath = join(root, "artifacts", "candidates", `${candidate.modelVersion}.json`);
    const validationPath = join(root, "artifacts", "candidates", `${candidate.modelVersion}.validation.json`);
    writeFileSync(candidatePath, candidateBytes);
    const validationBytes = `${canonicalJson(validation)}\n`;
    writeFileSync(validationPath, validationBytes);

    const report = generateReport(root, candidatePath, join(root, derivedManifestPath), profile, Date.parse("2026-08-28T18:00:00.000Z"));
    assert.match(report.bytes, /<strong>Rejected<\/strong>/);
    assert.match(report.bytes, /0\.314324/);
    assert.match(report.bytes, /not promoted/);
    for (const identity of [sha256(candidateBytes), candidate.dataManifestSha256, profile.profileSha256, sha256(validationBytes)]) assert.match(report.bytes, new RegExp(identity));

    for (const mutation of [{ decision: "Supported" }, { decision: "Inconclusive" }, { candidateSha256: "0".repeat(64) }, { deterministicRerunMatches: false }]) {
      writeFileSync(validationPath, `${canonicalJson({ ...validation, ...mutation })}\n`);
      assert.throws(() => generateReport(root, candidatePath, join(root, derivedManifestPath), profile), /Rejected|inconsistent|mismatch|deterministic/);
    }
    const malformed = structuredClone(candidate);
    malformed.quality.signedPsdTarget = [];
    const malformedBytes = `${canonicalJson(malformed)}\n`;
    writeFileSync(candidatePath, malformedBytes);
    writeFileSync(validationPath, `${canonicalJson({ ...validation, candidateSha256: sha256(malformedBytes) })}\n`);
    assert.throws(() => generateReport(root, candidatePath, join(root, derivedManifestPath), profile), /dimensions do not match/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("research report accepts unmapped markets while verifying every immutable reference", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-report-"));
  try {
    const fixture = structuredClone(input);
    const candidate = JSON.parse(readFileSync(new URL("./fixtures/research/artifact-valid.json", import.meta.url), "utf8"));
    const sources = {
      schemaVersion: 2, network: "testnet", sources: ["BTC", "ETH"].map((underlying) => ({
        schemaVersion: 1, underlying, sourceNetwork: "testnet", sourceCoin: underlying, cluster: "crypto", calendar: "continuous", measurementEnabled: true, fallbackEligible: true,
      })),
    };
    const markets = { schemaVersion: 1, network: "testnet", markets: [{
      vault: "0x4444444444444444444444444444444444444444", coinYes: "+1", coinNo: "+2",
      underlying: "XYZ100", cluster: "legacy-index", direction: "up", title: "XYZ100 above 100?", category: "index",
    }] };
    const deployment = { schemaVersion: 1, network: "testnet", evmChainId: 998, parlayVault: "0x1111111111111111111111111111111111111111", parlayDeployBlock: "1" };
    const baseline = { network: "testnet", fallbackReason: "operator-reviewed-testnet-bootstrap", clusters: candidate.clusters };
    const profileValue = { schemaVersion: 1, network: "testnet", infoApiUrl: "https://api.hyperliquid-testnet.xyz/info", evmChainId: 998, sourceRegistryFile: "sources.json", marketRegistryFile: "markets.json", deploymentRegistryFile: "deployment.json", baselineCorrelationFile: "baseline.json" };
    for (const [file, value] of [["sources.json", sources], ["markets.json", markets], ["deployment.json", deployment], ["baseline.json", baseline], ["profile.json", profileValue]] as const) writeFileSync(join(root, file), canonicalJson(value));
    const profile = loadResearchNetworkProfile(join(root, "profile.json"));
    writeFileSync(join(root, "network-profile.json"), `${canonicalJson(researchRootIdentity(profile))}\n`);
    const sourceBytes = canonicalJson(sources);
    const sourceHash = sha256(sourceBytes);
    const sourceRelative = `facts/source-registries/${sourceHash}.json`;
    mkdirSync(join(root, "facts", "source-registries"), { recursive: true });
    writeFileSync(join(root, sourceRelative), sourceBytes);
    fixture.manifest = {
      schemaVersion: 2, network: "testnet", profileSha256: profile.profileSha256, createdAt: "2026-08-27T03:00:00.000Z", sourceRegistrySha256: sourceHash,
      sourceRange: { fromMs: 1, toMs: 2 }, underlyings: {
        BTC: { rows: 0, firstUsableObservationMs: null, lastUsableObservationMs: null, missingIntervals: [] },
        ETH: { rows: 0, firstUsableObservationMs: null, lastUsableObservationMs: null, missingIntervals: [] },
      }, files: [],
    };
    fixture.manifest.files = [{ path: sourceRelative, bytes: statSync(join(root, sourceRelative)).size, sha256: sourceHash, rows: 1, schemaVersion: 1 }];
    Object.assign(candidate, {
      modelVersion: "beta-1", createdAt: fixture.manifest.createdAt, dataAsOf: fixture.manifest.createdAt,
      network: "testnet", profileSha256: profile.profileSha256, sourceRegistrySha256: sourceHash,
      marketRegistrySha256: profile.marketRegistrySha256, deploymentRegistrySha256: profile.deploymentRegistrySha256,
      baselineCorrelationSha256: profile.baselineCorrelationSha256,
    });
    fixture.candidate = candidate;
    fixture.candidate.dataManifestSha256 = sha256(canonicalJson(fixture.manifest));
    Object.assign(fixture.validation, {
      network: "testnet", profileSha256: profile.profileSha256, modelVersion: fixture.candidate.modelVersion,
      inputManifestSha256: fixture.candidate.dataManifestSha256, sourceRegistrySha256: sourceHash,
      marketRegistrySha256: profile.marketRegistrySha256, deploymentRegistrySha256: profile.deploymentRegistrySha256,
      baselineCorrelationSha256: profile.baselineCorrelationSha256, baselineSha256: profile.baselineCorrelationSha256,
      baselineSnapshotPath: `facts/baselines/${profile.baselineCorrelationSha256}.json`,
    });
    const candidateBytes = `${canonicalJson(fixture.candidate)}\n`;
    fixture.validation.candidateSha256 = sha256(candidateBytes);
    const baselineBytes = profile.baselineCorrelationRaw;
    mkdirSync(join(root, "manifests"), { recursive: true });
    writeFileSync(join(root, "manifests", `${fixture.candidate.dataManifestSha256}.json`), canonicalJson(fixture.manifest));
    const returnsPath = "derived/returns-v2/returns/2026/08/27/report.jsonl.gz";
    const exclusionsPath = "derived/returns-v2/exclusions/2026/08/27/report.jsonl.gz";
    const returnBytes = gzipSync("");
    const exclusionBytes = gzipSync(`${fixture.exclusions.map(canonicalJson).join("\n")}\n`);
    mkdirSync(join(root, "derived", "returns-v2", "returns", "2026", "08", "27"), { recursive: true });
    mkdirSync(join(root, "derived", "returns-v2", "exclusions", "2026", "08", "27"), { recursive: true });
    writeFileSync(join(root, returnsPath), returnBytes);
    writeFileSync(join(root, exclusionsPath), exclusionBytes);
    const derivedManifestRelative = `${returnsPath}.manifest.json`;
    const derivedManifestPath = join(root, derivedManifestRelative);
    const derivedManifestBytes = canonicalJson({
      schemaVersion: 2, network: "testnet", transformationVersion: "returns-v2", dataManifestSha256: fixture.candidate.dataManifestSha256, sourceRegistrySha256: sourceHash,
      window: { asOfMs: 2, lookbackMs: 1 }, returns: { path: returnsPath, sha256: sha256(returnBytes), rows: 0 }, exclusions: { path: exclusionsPath, sha256: sha256(exclusionBytes), rows: fixture.exclusions.length },
    });
    writeFileSync(derivedManifestPath, derivedManifestBytes);
    Object.assign(fixture.validation, {
      derivedManifestPath: derivedManifestRelative, derivedManifestSha256: sha256(derivedManifestBytes),
      returnsSha256: sha256(returnBytes), exclusionsSha256: sha256(exclusionBytes), derivationWindow: { asOfMs: 2, lookbackMs: 1 },
    });
    mkdirSync(join(root, "facts", "baselines"), { recursive: true });
    writeFileSync(join(root, fixture.validation.baselineSnapshotPath), baselineBytes);
    mkdirSync(join(root, "artifacts", "candidates"), { recursive: true });
    const candidatePath = join(root, "artifacts", "candidates", "beta-1.json");
    writeFileSync(candidatePath, candidateBytes);
    const validationPath = join(root, "artifacts", "candidates", "beta-1.validation.json");
    const validationBytes = `${canonicalJson(fixture.validation)}\n`;
    writeFileSync(validationPath, validationBytes);
    writeFileSync(join(root, "artifacts", "champion.json"), candidateBytes);
    mkdirSync(join(root, "journal", "requests", "2026", "08"), { recursive: true });
    writeFileSync(join(root, "journal", "requests", "2026", "08", "27.jsonl"), `${canonicalJson({ schemaVersion: 2, sourceKey: "testnet:ETH", network: "testnet", profileSha256: profile.profileSha256, startTimeMs: 1, endTimeMs: 2, retrievedAtMs: 3, httpStatus: 503, error: "info API 503", returnedRows: 0, ignoredBefore: 0, ignoredAfter: 0 })}\n`);
    const storage = openResearchPersistence(root);
    const operation = (record: Parameters<typeof writeOperationRecord>[1]) => writeOperationRecord(storage, record);
    operation({ schemaVersion: 1, network: "testnet", runId: "20260827T000000000Z-00000000-0000-4000-8000-000000000001", operation: "calibrate", phase: "terminal", startedAt: "2026-08-27T00:00:00.000Z", endedAt: "2026-08-27T00:01:00.000Z", status: "success", detail: { modelVersion: "beta-1" } });
    operation({ schemaVersion: 1, network: "testnet", runId: "20260827T010000000Z-00000000-0000-4000-8000-000000000002", operation: "replay", phase: "terminal", startedAt: "2026-08-27T01:00:00.000Z", endedAt: "2026-08-27T01:01:00.000Z", status: "failure", stage: "replay", error: "replay exited 1" });
    operation({ schemaVersion: 1, network: "testnet", runId: "20260827T020000000Z-00000000-0000-4000-8000-000000000003", operation: "replay", phase: "terminal", startedAt: "2026-08-27T02:00:00.000Z", endedAt: "2026-08-27T02:01:00.000Z", status: "success" });
    operation({ schemaVersion: 1, network: "testnet", runId: "20260827T030000000Z-00000000-0000-4000-8000-000000000004", operation: "backup", phase: "terminal", startedAt: "2026-08-27T03:00:00.000Z", endedAt: "2026-08-27T03:01:00.000Z", status: "failure", error: "backup total timeout" });
    operation({ schemaVersion: 1, network: "testnet", runId: "20260826T030000000Z-00000000-0000-4000-8000-000000000006", operation: "join", phase: "terminal", startedAt: "2026-08-26T03:00:00.000Z", endedAt: "2026-08-26T03:01:00.000Z", status: "failure", error: "expired failure" });
    operation({ schemaVersion: 1, network: "testnet", runId: "20260827T040000000Z-00000000-0000-4000-8000-000000000005", operation: "promote", phase: "start", startedAt: "2026-08-27T04:00:00.000Z" });
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "daily.json"), canonicalJson({ status: "failed", error: "mutable state must not be evidence" }));

    const reportNow = Date.parse("2026-09-26T01:01:00.000Z");
    const first = generateReport(root, candidatePath, derivedManifestPath, profile, reportNow);
    const second = generateReport(root, candidatePath, derivedManifestPath, profile, reportNow);
    assert.equal(first.path, join(root, "reports", "2026-08-27-beta-1.html"));
    assert.equal(readFileSync(first.path, "utf8"), first.bytes);
    assert.equal(second.bytes, first.bytes);
    writeFileSync(join(root, "artifacts", "champion.json"), `${canonicalJson({ ...fixture.candidate, marketRegistrySha256: "0".repeat(64) })}\n`);
    assert.match(generateReport(root, candidatePath, derivedManifestPath, profile, reportNow).bytes, /not promoted/);
    writeFileSync(join(root, "artifacts", "champion.json"), candidateBytes);
    assert.match(first.bytes, /collector request testnet:ETH: HTTP 503 — info API 503/);
    assert.match(first.bytes, /calibrate terminal: success — beta-1/);
    assert.match(first.bytes, /replay terminal: success/);
    assert.match(first.bytes, /replay failure: replay exited 1/);
    assert.match(first.bytes, /backup failure: backup total timeout/);
    assert.doesNotMatch(first.bytes, /expired failure/);
    assert.doesNotMatch(first.bytes, /promote terminal|mutable state must not be evidence/);
    assert.match(first.bytes, /no-synchronized-peer<\/td><td>1/);

    for (const candidateMutation of [
      { ...fixture.candidate, network: "mainnet" },
      { ...fixture.candidate, profileSha256: "0".repeat(64) },
      { ...fixture.candidate, sourceRegistrySha256: "0".repeat(64) },
      { ...fixture.candidate, marketRegistrySha256: "0".repeat(64) },
      { ...fixture.candidate, deploymentRegistrySha256: "0".repeat(64) },
      { ...fixture.candidate, baselineCorrelationSha256: "0".repeat(64) },
    ]) {
      writeFileSync(candidatePath, `${canonicalJson(candidateMutation)}\n`);
      assert.throws(() => generateReport(root, candidatePath, derivedManifestPath, profile), /artifact: (?:network must be testnet|.*mismatch)/);
    }
    writeFileSync(candidatePath, candidateBytes);

    for (const validationMutation of [
      { ...fixture.validation, network: "mainnet" },
      { ...fixture.validation, profileSha256: "0".repeat(64) },
      { ...fixture.validation, sourceRegistrySha256: "0".repeat(64) },
      { ...fixture.validation, marketRegistrySha256: "0".repeat(64) },
      { ...fixture.validation, deploymentRegistrySha256: "0".repeat(64) },
      { ...fixture.validation, baselineCorrelationSha256: "0".repeat(64), baselineSha256: "0".repeat(64), baselineSnapshotPath: `facts/baselines/${"0".repeat(64)}.json` },
      { ...fixture.validation, candidateSha256: "0".repeat(64) },
      { ...fixture.validation, inputManifestSha256: "0".repeat(64) },
      { ...fixture.validation, derivedManifestSha256: "0".repeat(64) },
      { ...fixture.validation, returnsSha256: "0".repeat(64) },
      { ...fixture.validation, exclusionsSha256: "0".repeat(64) },
      { ...fixture.validation, derivationWindow: { ...fixture.validation.derivationWindow, asOfMs: 3 } },
      { ...fixture.validation, decision: "Rejected" },
      { ...fixture.validation, deterministicRerunMatches: false },
    ]) {
      writeFileSync(validationPath, `${canonicalJson(validationMutation)}\n`);
      assert.throws(() => generateReport(root, candidatePath, derivedManifestPath, profile), /mismatch|Rejected|Supported and deterministic/);
    }
    writeFileSync(validationPath, validationBytes);

    const championQuote: QuoteDecision = {
      schemaVersion: 3, network: "testnet", profileSha256: profile.profileSha256, marketRegistrySha256: profile.marketRegistrySha256,
      deploymentRegistrySha256: profile.deploymentRegistrySha256, baselineCorrelationSha256: profile.baselineCorrelationSha256,
      artifactKind: "champion", artifactSha256: sha256(candidateBytes), validationSha256: sha256(validationBytes), validationState: "Supported",
      pairDecisions: [], recordedAtMs: 1, quoteId: "q-report", quoteDigest: "0x02", chainId: profile.profile.evmChainId,
      parlayVault: profile.deployment.parlayVault, taker: "0x2222222222222222222222222222222222222222",
      legs: [{ vault: "0x3333333333333333333333333333333333333333", isYes: true, underlying: "BTC", cluster: "crypto", direction: "up", outcomeCoin: "+1" }],
      bookInputs: [{ priceWad: "1", source: "l2Book", observedAtMs: 1, depthWad: null, vwapWad: null, freshnessMs: null }],
      modelVersion: "beta-1", dataAsOf: fixture.candidate.dataAsOf, dataManifestSha256: fixture.candidate.dataManifestSha256,
      sourceRegistrySha256: profile.sourceRegistrySha256, bestEstimateJointProbWad: "1", riskAdjustedJointProbWad: "1", rhoBandPct: 0,
      edge: { baseBps: "0", legBps: "0", totalBps: "0" }, premium: "1", maxPayout: "4", deadline: "1", signatureHash: "c".repeat(64),
    };
    const reportQuotes = join(root, "journal", "quotes", "report.jsonl");
    mkdirSync(join(root, "journal", "quotes"), { recursive: true });
    writeFileSync(reportQuotes, `${canonicalJson(championQuote)}\n`);
    assert.deepEqual(journalFunnel(root, profile), { quotes: 1, minted: 0, resolved: 0 });
    for (const quoteMutation of [
      { ...championQuote, profileSha256: "0".repeat(64) },
      { ...championQuote, sourceRegistrySha256: "0".repeat(64) },
      { ...championQuote, marketRegistrySha256: "0".repeat(64) },
      { ...championQuote, deploymentRegistrySha256: "0".repeat(64) },
      { ...championQuote, baselineCorrelationSha256: "0".repeat(64) },
      { ...championQuote, artifactSha256: "0".repeat(64) },
      { ...championQuote, validationSha256: "0".repeat(64) },
      { ...championQuote, dataManifestSha256: "0".repeat(64) },
    ]) {
      writeFileSync(reportQuotes, `${canonicalJson(championQuote)}\n${canonicalJson(quoteMutation)}\n`);
      assert.throws(() => journalFunnel(root, profile), /mismatch/);
    }
    writeFileSync(reportQuotes, "");

    writeFileSync(join(root, exclusionsPath), "changed");
    assert.throws(() => generateReport(root, candidatePath, derivedManifestPath, profile), /exclusions hash mismatch/);
    writeFileSync(join(root, exclusionsPath), exclusionBytes);

    const unsafeCandidate = { ...fixture.candidate, modelVersion: "../../escape" };
    writeFileSync(candidatePath, `${canonicalJson(unsafeCandidate)}\n`);
    assert.throws(() => generateReport(root, candidatePath, derivedManifestPath, profile), /modelVersion/);
    writeFileSync(candidatePath, `${canonicalJson({ ...fixture.candidate, modelVersion: 7 })}\n`);
    assert.throws(() => generateReport(root, candidatePath, derivedManifestPath, profile), /modelVersion/);
    writeFileSync(candidatePath, candidateBytes);
    writeFileSync(validationPath, `${canonicalJson({ ...fixture.validation, modelVersion: "../escape" })}\n`);
    assert.throws(() => generateReport(root, candidatePath, derivedManifestPath, profile), /validation identity mismatch/);
    writeFileSync(validationPath, validationBytes);

    writeFileSync(join(root, fixture.validation.baselineSnapshotPath), "corrupt");
    assert.throws(() => generateReport(root, candidatePath, derivedManifestPath, profile), /baseline.*mismatch/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
