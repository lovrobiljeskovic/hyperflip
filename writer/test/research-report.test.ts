import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateReport, renderReport, type ReportInput } from "../src/research/report.js";
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
    schemaVersion: 1 as const, modelVersion: "beta-1", modelFamily: "hierarchical-gaussian-factor" as const,
    createdAt: "2026-08-27T03:00:00.000Z", dataAsOf: "2026-08-27T00:00:00.000Z", dataManifestSha256: "a".repeat(64), sourceRegistrySha256: "c".repeat(64),
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
    schemaVersion: 1 as const, modelVersion: "beta-1", candidateSha256: "d".repeat(64), inputManifestSha256: "a".repeat(64), baselineSha256: "e".repeat(64), baselineSnapshotPath: "facts/baselines/e.json",
    seed: "fixture", drawCount: 20_000, originStrideHours: 24 as const, policy: { maxProjectionError: 0.10 as const, bootstrapBlockHours: 96 as const, bootstrapSamples: 2_000 as const },
    ticketCounts: {}, selectedTicketKeys: [], modelScores: {
      independence: score, "static-hierarchical-gaussian": score, "measured-hierarchical-gaussian": score, "signed-t-copula": score, "filtered-historical-simulation": score,
    }, bootstrap: { point: -0.01, lower: -0.02, upper: 0, groups: [], samples: 2_000, blockHours: 96 },
    stressThresholds: [], degreeOfFreedomSelections: [], exclusions: [{ originMs: null, ticketKey: null, model: null, reason: "band-market" as const }],
    decision: "Supported" as const, deterministicRerunMatches: true, resourcePolicy: { maxWallClockMs: 30_000 as const, maxPeakRssBytes: 536_870_912 as const }, limitations: [],
  },
  champion: { modelVersion: "beta-1", sha256: "b".repeat(64) },
  funnel: { quotes: 4, minted: 3, resolved: 2 },
  failures: ["collector timeout"],
};

test("research report renders deterministic escaped evidence with every required caveat", () => {
  const html = renderReport(input);
  assert.equal(renderReport(structuredClone(input)), html);
  for (const fragment of readFileSync(new URL("./fixtures/research/report-expected.html", import.meta.url), "utf8").trim().split("\n")) assert.ok(html.includes(fragment), `missing report fragment: ${fragment}`);
  assert.equal(html.includes("<script>"), false);
  assert.match(html, /<style>[\s\S]*<\/style>/);
  assert.equal(/<(?:link|script)\b/i.test(html), false);
});

test("research report verifies every immutable reference before writing the deterministic path", () => {
  const root = mkdtempSync(join(tmpdir(), "hype-report-"));
  try {
    const fixture = structuredClone(input);
    const sourceBytes = canonicalJson({ schemaVersion: 1, sources: [] });
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
    mkdirSync(join(root, "facts", "baselines"), { recursive: true });
    writeFileSync(join(root, fixture.validation.baselineSnapshotPath), baselineBytes);
    mkdirSync(join(root, "artifacts", "candidates"), { recursive: true });
    const candidatePath = join(root, "artifacts", "candidates", "beta-1.json");
    writeFileSync(candidatePath, candidateBytes);
    writeFileSync(join(root, "artifacts", "candidates", "beta-1.validation.json"), `${canonicalJson(fixture.validation)}\n`);
    writeFileSync(join(root, "artifacts", "champion.json"), candidateBytes);

    const first = generateReport(root, candidatePath);
    const second = generateReport(root, candidatePath);
    assert.equal(first.path, join(root, "reports", "2026-08-27-beta-1.html"));
    assert.equal(readFileSync(first.path, "utf8"), first.bytes);
    assert.equal(second.bytes, first.bytes);

    writeFileSync(join(root, fixture.validation.baselineSnapshotPath), "corrupt");
    assert.throws(() => generateReport(root, candidatePath), /baseline.*mismatch/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
