import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { generateReport, journalFunnel, renderReport, type ReportInput } from "../src/research/report.js";
import { canonicalJson, sha256 } from "../src/research/store.js";

const score = {
  overall: { rows: 12, eligibleRows: 10, logLoss: 0.4, brier: 0.2, calibration: [{ lower: 0, upper: 0.1, rows: 2, meanProbability: 0.05, observedRate: 0 }], sharpness: 0.03, exclusions: [{ reason: "band-market" as const, rows: 2 }] },
  byWindow: {}, byHorizon: {}, byTicketSize: {}, byClusterCombination: {}, byDirection: {},
  byStressRegime: { normal: { rows: 10, eligibleRows: 10, logLoss: 0.4, brier: 0.2, calibration: [], sharpness: 0.03, exclusions: [], gateEligible: true, exclusionReason: null } },
};

const input: ReportInput = {
  manifest: {
    schemaVersion: 1 as const, createdAt: "2026-08-27T03:00:00.000Z", sourceRegistrySha256: "c".repeat(64), sourceRange: { fromMs: 1, toMs: 2 },
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
    schemaVersion: 2 as const, network: "testnet" as const, profileSha256: "b".repeat(64), modelVersion: "beta-1", candidateSha256: "d".repeat(64), inputManifestSha256: "a".repeat(64), sourceRegistrySha256: "c".repeat(64), marketRegistrySha256: "d".repeat(64), deploymentRegistrySha256: "e".repeat(64), baselineCorrelationSha256: "f".repeat(64), baselineSha256: "f".repeat(64), baselineSnapshotPath: "facts/baselines/f.json",
    seed: "fixture", drawCount: 20_000, originStrideHours: 24 as const, policy: { maxProjectionError: 0.10 as const, bootstrapBlockHours: 96 as const, bootstrapSamples: 2_000 as const },
    ticketCounts: {}, selectedTicketKeys: [], modelScores: {
      independence: score, "static-hierarchical-gaussian": score, "measured-hierarchical-gaussian": score, "signed-t-copula": score, "filtered-historical-simulation": score,
    }, bootstrap: { point: -0.01, lower: -0.02, upper: 0, groups: [], samples: 2_000, blockHours: 96 },
    stressThresholds: [], degreeOfFreedomSelections: [], exclusions: [{ originMs: null, ticketKey: null, model: null, reason: "band-market" as const }],
    decision: "Supported" as const, deterministicRerunMatches: true, resourcePolicy: { maxWallClockMs: 30_000 as const, maxPeakRssBytes: 536_870_912 as const }, limitations: [],
  },
  champion: { modelVersion: "beta-1", sha256: "b".repeat(64) },
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
});

test("journal funnel joins only quoted canonical mints to their matching parlay resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-report-funnel-"));
  try {
    mkdirSync(join(root, "journal", "quotes"), { recursive: true });
    writeFileSync(join(root, "journal", "quotes", "quotes.jsonl"), `${canonicalJson({ quoteId: "q1" })}\n`);
    mkdirSync(join(root, "journal", "events"), { recursive: true });
    const rows = [
      { kind: "minted", eventKey: "tx1:0", blockHash: "0xaaa", quoteId: "q1", parlayId: "1" },
      { kind: "resolved", eventKey: "tx2:0", blockHash: "0xbbb", quoteId: "q1", parlayId: "1" },
      { kind: "minted", eventKey: "tx3:0", blockHash: "0xccc", quoteId: "q2", parlayId: "2" },
      { kind: "resolved", eventKey: "tx4:0", blockHash: "0xddd", quoteId: "q2", parlayId: "2" },
      { kind: "resolved", eventKey: "tx5:0", blockHash: "0xeee", quoteId: "q1", parlayId: "99" },
      { kind: "orphaned", targetKind: "chain-log", targetKey: "tx3:0:0xccc" },
    ];
    writeFileSync(join(root, "journal", "events", "events.jsonl"), `${rows.map(canonicalJson).join("\n")}\n`);
    assert.deepEqual(journalFunnel(root), { quotes: 1, minted: 1, resolved: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("research report verifies every immutable reference before writing the deterministic path", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-report-"));
  try {
    const fixture = structuredClone(input);
    const sourceBytes = canonicalJson({ schemaVersion: 2, network: "testnet", sources: [] });
    const sourceHash = sha256(sourceBytes);
    const sourceRelative = `facts/source-registries/${sourceHash}.json`;
    mkdirSync(join(root, "facts", "source-registries"), { recursive: true });
    writeFileSync(join(root, sourceRelative), sourceBytes);
    fixture.manifest.sourceRegistrySha256 = sourceHash;
    fixture.manifest.files = [{ path: sourceRelative, bytes: statSync(join(root, sourceRelative)).size, sha256: sourceHash, rows: 1, schemaVersion: 1 }];
    fixture.candidate.sourceRegistrySha256 = sourceHash;
    fixture.candidate.dataManifestSha256 = sha256(canonicalJson(fixture.manifest));
    fixture.validation.inputManifestSha256 = fixture.candidate.dataManifestSha256;
    const candidateBytes = `${canonicalJson(fixture.candidate)}\n`;
    fixture.validation.candidateSha256 = sha256(candidateBytes);
    const baselineBytes = canonicalJson({ fixture: true });
    fixture.validation.baselineSha256 = sha256(baselineBytes);
    fixture.validation.baselineSnapshotPath = `facts/baselines/${fixture.validation.baselineSha256}.json`;
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
    const derivedManifestPath = join(root, `${returnsPath}.manifest.json`);
    writeFileSync(derivedManifestPath, canonicalJson({
      schemaVersion: 2, network: "testnet", transformationVersion: "returns-v2", dataManifestSha256: fixture.candidate.dataManifestSha256, sourceRegistrySha256: sourceHash,
      window: { asOfMs: 2, lookbackMs: 1 }, returns: { path: returnsPath, sha256: sha256(returnBytes), rows: 0 }, exclusions: { path: exclusionsPath, sha256: sha256(exclusionBytes), rows: fixture.exclusions.length },
    }));
    mkdirSync(join(root, "facts", "baselines"), { recursive: true });
    writeFileSync(join(root, fixture.validation.baselineSnapshotPath), baselineBytes);
    mkdirSync(join(root, "artifacts", "candidates"), { recursive: true });
    const candidatePath = join(root, "artifacts", "candidates", "beta-1.json");
    writeFileSync(candidatePath, candidateBytes);
    writeFileSync(join(root, "artifacts", "candidates", "beta-1.validation.json"), `${canonicalJson(fixture.validation)}\n`);
    writeFileSync(join(root, "artifacts", "champion.json"), candidateBytes);
    mkdirSync(join(root, "journal", "requests", "2026", "08"), { recursive: true });
    writeFileSync(join(root, "journal", "requests", "2026", "08", "27.jsonl"), `${canonicalJson({ schemaVersion: 1, sourceKey: "testnet:ETH", startTime: 1, endTime: 2, retrievedAtMs: 3, httpStatus: 503, error: "info API 503", returnedRows: 0 })}\n`);
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "collector.json"), canonicalJson({ schemaVersion: 1, sourceRegistrySha256: sourceHash, sources: { "testnet:BTC": 1, "testnet:ETH": 2 } }));
    writeFileSync(join(root, "state", "calibrator.json"), canonicalJson({ schemaVersion: 1, operation: "calibrator", status: "succeeded", startedAt: "2026-08-27T00:00:00.000Z", endedAt: "2026-08-27T00:01:00.000Z", error: null, details: { modelVersion: "beta-1" } }));
    writeFileSync(join(root, "state", "daily.json"), canonicalJson({ schemaVersion: 1, operation: "daily", status: "failed", startedAt: "2026-08-27T01:00:00.000Z", endedAt: "2026-08-27T01:01:00.000Z", error: "replay exited 1", details: {} }));
    writeFileSync(join(root, "state", "join.json"), canonicalJson({ schemaVersion: 1, operation: "join", status: "succeeded", startedAt: "2026-08-27T02:00:00.000Z", endedAt: "2026-08-27T02:01:00.000Z", error: null, details: {} }));
    writeFileSync(join(root, "state", "backup.json"), canonicalJson({ schemaVersion: 1, operation: "backup", status: "failed", startedAt: "2026-08-27T03:00:00.000Z", endedAt: "2026-08-27T03:01:00.000Z", error: "backup total timeout", details: {} }));

    const first = generateReport(root, candidatePath, derivedManifestPath);
    const second = generateReport(root, candidatePath, derivedManifestPath);
    assert.equal(first.path, join(root, "reports", "2026-08-27-beta-1.html"));
    assert.equal(readFileSync(first.path, "utf8"), first.bytes);
    assert.equal(second.bytes, first.bytes);
    assert.match(first.bytes, /collector request testnet:ETH: HTTP 503 — info API 503/);
    assert.match(first.bytes, /collector state: 2 source checkpoints/);
    assert.match(first.bytes, /calibrator state: succeeded — beta-1/);
    assert.match(first.bytes, /daily state: failed — replay exited 1/);
    assert.match(first.bytes, /join state: succeeded/);
    assert.match(first.bytes, /backup state: failed — backup total timeout/);
    assert.match(first.bytes, /no-synchronized-peer<\/td><td>1/);

    writeFileSync(join(root, exclusionsPath), "changed");
    assert.throws(() => generateReport(root, candidatePath, derivedManifestPath), /exclusions hash mismatch/);
    writeFileSync(join(root, exclusionsPath), exclusionBytes);

    const stateTarget = join(root, "daily-state-target.json");
    const dailyState = readFileSync(join(root, "state", "daily.json"));
    writeFileSync(stateTarget, dailyState);
    rmSync(join(root, "state", "daily.json"));
    symlinkSync(stateTarget, join(root, "state", "daily.json"));
    assert.throws(() => generateReport(root, candidatePath, derivedManifestPath), /symbolic link/);
    rmSync(join(root, "state", "daily.json"));
    writeFileSync(join(root, "state", "daily.json"), dailyState);

    const unsafeCandidate = { ...fixture.candidate, modelVersion: "../../escape" };
    writeFileSync(candidatePath, `${canonicalJson(unsafeCandidate)}\n`);
    assert.throws(() => generateReport(root, candidatePath, derivedManifestPath), /safe artifact filename/);
    writeFileSync(candidatePath, `${canonicalJson({ ...fixture.candidate, modelVersion: 7 })}\n`);
    assert.throws(() => generateReport(root, candidatePath, derivedManifestPath), /safe artifact filename/);
    writeFileSync(candidatePath, candidateBytes);
    writeFileSync(join(root, "artifacts", "candidates", "beta-1.validation.json"), `${canonicalJson({ ...fixture.validation, modelVersion: "../escape" })}\n`);
    assert.throws(() => generateReport(root, candidatePath, derivedManifestPath), /safe artifact filename/);
    writeFileSync(join(root, "artifacts", "candidates", "beta-1.validation.json"), `${canonicalJson(fixture.validation)}\n`);

    writeFileSync(join(root, fixture.validation.baselineSnapshotPath), "corrupt");
    assert.throws(() => generateReport(root, candidatePath, derivedManifestPath), /baseline.*mismatch/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
