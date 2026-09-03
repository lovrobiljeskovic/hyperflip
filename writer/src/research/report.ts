import { resolve } from "node:path";
import type { ValidationReport } from "./replay.js";
import { openResearchPersistence, type ResearchPersistence } from "./persistence.js";
import { assertMarketRegistrySnapshot, canonicalJson, readDerivedDataset, readSourceRegistryFact, researchRelativePath, sha256, verifyManifest } from "./store.js";
import { assertDataManifest, assertJoinedEventRecord, assertQuoteDecision, liveMarketRegistrySha256 } from "./types.js";
import type { ChainLogRecord, CorrelationArtifact, DataManifest, ExclusionRecord, JoinedEventRecord, OrphanCorrectionRecord, QuoteDecision } from "./types.js";
import { terminalOperationHistory } from "./operations.js";
import { assertValidationArtifactIdentity, assertValidationDerivedIdentity, parseCorrelationArtifact } from "./artifacts.js";
import { assertLoadedResearchNetworkProfile, assertResearchRootIdentity, researchRootIdentity, type LoadedResearchNetworkProfile } from "./network.js";

export interface ReportInput {
  manifest: DataManifest;
  candidate: CorrelationArtifact;
  candidateSha256: string;
  validation: ValidationReport;
  validationSha256: string;
  champion: { modelVersion: string; sha256: string } | null;
  funnel: { quotes: number; minted: number; resolved: number };
  failures: string[];
  exclusions: ExclusionRecord[];
  nowMs?: number;
}

const MODELS = ["independence", "static-hierarchical-gaussian", "measured-hierarchical-gaussian", "signed-t-copula", "filtered-historical-simulation"] as const;
const SAFE_MODEL_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const safeModelVersion = (value: unknown): value is string => typeof value === "string" && SAFE_MODEL_VERSION.test(value);
type Label = "Observed fact" | "Model estimate" | "Operator decision";

function escapeHtml(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function section(label: Label, title: string, body: string): string {
  return `<section class="card"><p class="label">${label}</p><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

function table(headers: string[], rows: unknown[][]): string {
  return `<table><thead><tr>${headers.map((value) => `<th>${escapeHtml(value)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value ?? "—")}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

const number = (value: number | null): string => value === null ? "—" : Number.isInteger(value) ? String(value) : value.toFixed(6);

export function renderReport(input: ReportInput): string {
  const { candidate, manifest, validation } = input;
  const order = [...candidate.quality.matrixOrder].sort();
  const originalIndex = new Map(candidate.quality.matrixOrder.map((underlying, index) => [underlying, index]));
  const matrices = ([30, 90, 180] as const).map((window) => section("Model estimate", `${window}-day correlation`, table(
    ["Underlying", ...order],
    order.map((left) => [left, ...order.map((right) => number(candidate.quality.diagnosticMatrices[String(window) as "30" | "90" | "180"][originalIndex.get(left)!][originalIndex.get(right)!]))]),
  ))).join("");
  const scores = MODELS.map((model) => {
    const score = validation.modelScores[model].overall;
    return [model, score.rows, score.eligibleRows, number(score.logLoss), number(score.brier), number(score.sharpness), score.exclusions.map((item) => `${item.reason}: ${item.rows}`).join(", ") || "none"];
  });
  const calibration = MODELS.flatMap((model) => validation.modelScores[model].overall.calibration.map((bucket) => [model, `${bucket.lower}-${bucket.upper}`, bucket.rows, number(bucket.meanProbability), number(bucket.observedRate)]));
  const stress = MODELS.flatMap((model) => Object.entries(validation.modelScores[model].byStressRegime).sort(([left], [right]) => left.localeCompare(right)).map(([bucket, score]) => [model, bucket, score.rows, score.eligibleRows, number(score.logLoss), score.gateEligible, score.exclusionReason ?? "none"]));
  const quarantines = candidate.quality.quarantinedUnderlyings.map((item) => [item.underlying, item.reason]);
  const exclusionReasons: ExclusionRecord["reason"][] = ["missing-interval", "stale-session-bar", "non-positive-close", "no-synchronized-peer"];
  const exclusions = exclusionReasons.map((reason) => [reason, input.exclusions.filter((row) => row.reason === reason).length]);
  const exclusionEvidence = [...exclusions, ...candidate.quality.quarantinedUnderlyings.map((item) => [`quarantined: ${item.underlying} (${item.reason})`, 1])];
  const operational = [...input.failures].filter((item) => item.includes(" terminal:")).sort().map((item) => ["operation", item]);
  const failures = [...input.failures].filter((item) => !item.includes(" terminal:")).sort().map((failure) => ["operation", failure]);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Correlation beta evidence — ${escapeHtml(candidate.modelVersion)}</title><style>:root{color-scheme:dark;font:15px system-ui;background:#0d1117;color:#e6edf3}body{max-width:1200px;margin:auto;padding:2rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:1rem}.card{border:1px solid #30363d;border-radius:8px;padding:1rem;overflow:auto}.label{color:#7ee787;font-size:.75rem;text-transform:uppercase;letter-spacing:.08em}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #30363d;padding:.4rem;text-align:left;white-space:nowrap}.warning{color:#ffa657}</style></head><body>
<header><p class="label">Operator decision</p><h1>Correlation beta evidence</h1><p class="warning">Testnet P&amp;L is not evidence of production expected value.</p></header>
<main class="grid">
${section("Operator decision", "Validation state", `<p><strong>${escapeHtml(validation.decision)}</strong> — Supported / Inconclusive / Rejected</p>`)}
${section("Observed fact", "Immutable identities", table(["Identity", "Value"], [["candidate", input.candidateSha256], ["manifest", candidate.dataManifestSha256], ["champion", input.champion?.sha256 ?? "not promoted"], ["profile", candidate.profileSha256], ["validation", input.validationSha256]]))}
${section("Observed fact", "Freshness and missing intervals", table(["Underlying", "Rows", "Last usable (ms)", "Missing intervals"], Object.entries(manifest.underlyings).sort(([left], [right]) => left.localeCompare(right)).map(([underlying, value]) => [underlying, value.rows, value.lastUsableObservationMs, value.missingIntervals.join(", ") || "none"])))}
${section("Observed fact", "Verified exclusions", table(["Reason", "Rows"], exclusionEvidence))}
${matrices}
${section("Model estimate", "Target / implied / residual", table(["Pair", "Mode", "Observations / expected", "Coverage", "Effective N", "Target", "Implied", "Residual", "Fallback"], [...candidate.quality.pairDiagnostics].sort((left, right) => left.pair.join(":").localeCompare(right.pair.join(":"))).map((row) => [row.pair.join(" / "), row.mode, `${row.observations} / ${row.expected}`, number(row.coverage), number(row.effectiveN), number(row.target), number(row.implied), number(row.residual), row.fallbackUsed])))}
${section("Model estimate", "Projection error", table(["Maximum", "Higham delta"], [[number(candidate.quality.maxProjectionError), number(candidate.quality.highamProjectionDelta)]]))}
${section("Model estimate", "Clipped negative correlations", table(["Pair", "Target"], [...candidate.quality.clippedNegativePairs].sort((left, right) => left.pair.join(":").localeCompare(right.pair.join(":"))).map((row) => [row.pair.join(" / "), number(row.target)])))}
${section("Model estimate", "All five model scores", `<p>Band markets are excluded from statistical claims.</p>${table(["Model", "Rows", "Eligible sample", "Log loss", "Brier", "Sharpness", "Exclusions"], scores)}`)}
${section("Model estimate", "Calibration buckets", table(["Model", "Bucket", "Sample", "Mean probability", "Observed rate"], calibration))}
${section("Model estimate", "Stress buckets", table(["Model", "Bucket", "Rows", "Eligible sample", "Log loss", "Gate eligible", "Exclusion"], stress))}
${section("Observed fact", "Quote → mint → resolution funnel", `<p>quotes: ${input.funnel.quotes} · minted: ${input.funnel.minted} · resolved: ${input.funnel.resolved}</p><p>Public quote detail remains redacted until joined resolution.</p>`)}
${section("Observed fact", "Quarantines and failures", table(["Source", "Reason"], [...quarantines, ...failures]))}
${section("Observed fact", "Operational evidence", table(["Operation", "State"], operational))}
</main></body></html>\n`;
}

function validationReport(raw: string): ValidationReport {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("report validation is malformed JSON"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("report validation must be an object");
  const report = parsed as ValidationReport;
  const keys = ["schemaVersion", "network", "profileSha256", "modelVersion", "candidateSha256", "inputManifestSha256", "derivedManifestPath", "derivedManifestSha256", "returnsSha256", "exclusionsSha256", "derivationWindow", "sourceRegistrySha256", "marketRegistrySha256", "deploymentRegistrySha256", "baselineCorrelationSha256", "baselineSha256", "baselineSnapshotPath", "seed", "drawCount", "originStrideHours", "policy", "ticketCounts", "selectedTicketKeys", "modelScores", "bootstrap", "stressThresholds", "degreeOfFreedomSelections", "exclusions", "decision", "deterministicRerunMatches", "resourcePolicy", "limitations"];
  if (Object.keys(report).length !== keys.length || keys.some((key) => !(key in report))) throw new Error("report validation has invalid fields");
  if (typeof report.seed !== "string" || !report.seed || report.drawCount !== 20_000 || report.originStrideHours !== 24
    || canonicalJson(report.policy) !== canonicalJson({ maxProjectionError: 0.10, bootstrapBlockHours: 96, bootstrapSamples: 2_000 })
    || (report.decision !== "Supported" && report.decision !== "Inconclusive" && report.decision !== "Rejected")
    || typeof report.deterministicRerunMatches !== "boolean" || !Array.isArray(report.selectedTicketKeys) || report.selectedTicketKeys.some((key) => typeof key !== "string")
    || !Array.isArray(report.stressThresholds) || !Array.isArray(report.degreeOfFreedomSelections) || !Array.isArray(report.exclusions) || !Array.isArray(report.limitations)) throw new Error("report validation structure is invalid");
  if (report.ticketCounts === null || typeof report.ticketCounts !== "object" || Array.isArray(report.ticketCounts) || Object.values(report.ticketCounts).some((count) => !Number.isSafeInteger(count) || count < 0)) throw new Error("report validation ticket counts are invalid");
  if (report.modelScores === null || typeof report.modelScores !== "object" || Array.isArray(report.modelScores) || MODELS.some((model) => !(model in report.modelScores))) throw new Error("report validation model scores are invalid");
  for (const model of MODELS) {
    const value = report.modelScores[model] as unknown as Record<string, unknown>;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("report validation model score is invalid");
    const overall = value.overall as Record<string, unknown>;
    const stress = value.byStressRegime as Record<string, unknown>;
    if (overall === null || typeof overall !== "object" || Array.isArray(overall) || !Array.isArray(overall.calibration) || !Array.isArray(overall.exclusions)
      || stress === null || typeof stress !== "object" || Array.isArray(stress)) throw new Error("report validation model score is invalid");
  }
  return report;
}

function verified(root: string, candidatePath: string, storage: ResearchPersistence, profile: LoadedResearchNetworkProfile, nowMs: number, options: { allowRejectedProjectionEvidence?: boolean } = {}): { candidate: CorrelationArtifact; manifest: DataManifest; validation: ValidationReport; bytes: string; candidateSha256: string; validationSha256: string } {
  const path = researchRelativePath(root, candidatePath);
  const bytes = storage.readText(path);
  // Live markets are not passed: the candidate is immutable evidence verified against its own
  // registry snapshot below, not against whatever registry is current at report time (R6).
  const candidate = parseCorrelationArtifact(bytes, nowMs, profile.sources, undefined, profile, options).artifact;
  const manifestPath = `manifests/${candidate.dataManifestSha256}.json`;
  const manifest = JSON.parse(storage.readText(manifestPath)) as DataManifest;
  assertDataManifest(manifest);
  if (sha256(canonicalJson(manifest)) !== candidate.dataManifestSha256) throw new Error("report manifest identity mismatch");
  verifyManifest(root, manifest, storage);
  if (manifest.network !== profile.profile.network || manifest.network !== candidate.network || manifest.profileSha256 !== profile.profileSha256 || manifest.profileSha256 !== candidate.profileSha256 || manifest.sourceRegistrySha256 !== profile.sourceRegistrySha256 || manifest.sourceRegistrySha256 !== candidate.sourceRegistrySha256) throw new Error("report manifest profile identity mismatch");
  const candidateDirectory = path.includes("/") ? `${path.slice(0, path.lastIndexOf("/"))}/` : "";
  const validationPath = `${candidateDirectory}${candidate.modelVersion}.validation.json`;
  const validationBytes = storage.readText(validationPath);
  const validation = validationReport(validationBytes);
  assertValidationArtifactIdentity(bytes, candidate, validation, profile);
  if (candidate.quality.maxProjectionError > candidate.policy.maxProjectionError && (validation.decision !== "Rejected" || !validation.deterministicRerunMatches)) throw new Error("report rejected projection evidence is inconsistent");
  let baseline: string;
  try { baseline = researchRelativePath(root, validation.baselineSnapshotPath); } catch { throw new Error("report baseline snapshot mismatch"); }
  if (sha256(storage.read(baseline)) !== validation.baselineSha256) throw new Error("report baseline snapshot mismatch");
  if (candidate.schemaVersion === 3) assertMarketRegistrySnapshot(root, storage, candidate.marketRegistrySha256);
  return { candidate, manifest, validation, bytes, candidateSha256: sha256(bytes), validationSha256: sha256(validationBytes) };
}

function journalRows(storage: ResearchPersistence, directory: string): unknown[] {
  return storage.list(`journal/${directory}`).flatMap((file) => {
    const text = storage.readText(file).trim();
    if (!text) return [];
    return text.split("\n").map((line) => {
      try { return JSON.parse(line) as unknown; } catch { throw new Error(`report ${directory} journal row is malformed`); }
    });
  });
}

function verifiedQuote(root: string, storage: ResearchPersistence, row: unknown, profile: LoadedResearchNetworkProfile): QuoteDecision {
  try { assertQuoteDecision(row as QuoteDecision); } catch (error) { throw new Error(`report quote journal row is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  const quote = row as QuoteDecision;
  assertResearchRootIdentity(storage, quote);
  if (quote.network !== profile.profile.network || quote.profileSha256 !== profile.profileSha256 || quote.sourceRegistrySha256 !== profile.sourceRegistrySha256
    || quote.deploymentRegistrySha256 !== profile.deploymentRegistrySha256
    || quote.baselineCorrelationSha256 !== profile.baselineCorrelationSha256 || quote.chainId !== profile.profile.evmChainId
    || quote.parlayVault.toLowerCase() !== profile.deployment.parlayVault.toLowerCase()) throw new Error("report quote journal profile identity mismatch");
  // R6: the quote's own live-registry snapshot is the evidence; a quote from an earlier registry
  // counts once that snapshot exists, and one naming a registry with no snapshot fails the report.
  assertMarketRegistrySnapshot(root, storage, liveMarketRegistrySha256(quote));
  if (quote.artifactKind === "profile-baseline") {
    if (quote.dataManifestSha256 !== profile.baselineCorrelationSha256 || quote.modelVersion !== "profile-baseline") throw new Error("report quote journal baseline identity mismatch");
    return quote;
  }
  if (!safeModelVersion(quote.modelVersion)) throw new Error("report quote journal modelVersion is invalid");
  const candidatePath = `artifacts/candidates/${quote.modelVersion}.json`;
  const evidence = verified(root, candidatePath, storage, profile, Number.MAX_SAFE_INTEGER);
  if (evidence.candidateSha256 !== quote.artifactSha256 || evidence.candidate.dataManifestSha256 !== quote.dataManifestSha256 || evidence.candidate.sourceRegistrySha256 !== quote.sourceRegistrySha256) throw new Error("report quote journal candidate identity mismatch");
  // A signed-factor (schemaVersion 3) candidate is quoted only by the point-model runtime
  // (schemaVersion 4); a legacy candidate is quoted only by the band-era runtime.
  if ((quote.schemaVersion === 4) !== (evidence.candidate.schemaVersion === 3)) throw new Error("report quote journal schema and candidate model version disagree");
  if (quote.schemaVersion === 4 && quote.championMarketRegistrySha256 !== evidence.candidate.marketRegistrySha256) throw new Error("report quote journal champion registry identity mismatch");
  assertValidationDerivedIdentity(root, storage, evidence.candidate, evidence.validation, profile);
  if (evidence.validationSha256 !== quote.validationSha256 || evidence.validation.decision !== "Supported" || !evidence.validation.deterministicRerunMatches) throw new Error("report quote journal validation identity mismatch");
  return quote;
}

function verifiedEvent(storage: ResearchPersistence, row: unknown, profile: LoadedResearchNetworkProfile): JoinedEventRecord {
  try { assertJoinedEventRecord(row as JoinedEventRecord); } catch (error) { throw new Error(`report event journal row is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  const event = row as JoinedEventRecord;
  assertResearchRootIdentity(storage, event);
  if (event.network !== profile.profile.network || event.profileSha256 !== profile.profileSha256 || event.deploymentRegistrySha256 !== profile.deploymentRegistrySha256) throw new Error("report event journal profile identity mismatch");
  return event;
}

export function journalFunnel(root: string, profile: LoadedResearchNetworkProfile, storage = openResearchPersistence(root)): ReportInput["funnel"] {
  const quoteRows = journalRows(storage, "quotes").map((row) => verifiedQuote(root, storage, row, profile));
  const quotes = new Set(quoteRows.map((row) => row.quoteId));
  const events = journalRows(storage, "events").map((row) => verifiedEvent(storage, row, profile));
  const orphaned = new Set(events.filter((row): row is OrphanCorrectionRecord => row.kind === "orphaned" && row.targetKind === "chain-log").map((row) => String(row.targetKey)));
  const active = events.filter((row): row is ChainLogRecord => (row.kind === "minted" || row.kind === "resolved") && !orphaned.has(`${String(row.eventKey)}:${String(row.blockHash).toLowerCase()}`));
  const mints = active.filter((row) => row.kind === "minted" && quotes.has(String(row.quoteId)));
  const mintedParlays = new Set(mints.map((row) => String(row.parlayId)));
  const resolvedParlays = new Set(active.filter((row) => row.kind === "resolved" && mintedParlays.has(String(row.parlayId))).map((row) => String(row.parlayId)));
  return { quotes: quotes.size, minted: new Set(mints.map((row) => `${String(row.quoteId)}:${String(row.parlayId)}`)).size, resolved: resolvedParlays.size };
}

function operationalFailures(storage: ResearchPersistence, profile: LoadedResearchNetworkProfile, nowMs = Date.now()): string[] {
  const quarantines = storage.list("quarantine").flatMap((file) => {
    const text = storage.readText(file).trim();
    return text ? text.split("\n").map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      return String(row.reason ?? row.error ?? `quarantined ${row.underlying ?? file}`);
    }) : [];
  });
  const requests = storage.list("journal/requests").flatMap((file) => {
    const text = storage.readText(file).trim();
    return text ? text.split("\n").flatMap((line) => {
      let row: Record<string, unknown>;
      try { row = JSON.parse(line) as Record<string, unknown>; } catch { throw new Error("report request journal row is malformed"); }
      const keys = ["schemaVersion", "sourceKey", "network", "profileSha256", "startTimeMs", "endTimeMs", "retrievedAtMs", "httpStatus", "error", "returnedRows", "ignoredBefore", "ignoredAfter"];
      if (row === null || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))
        || row.schemaVersion !== 2 || row.network !== profile.profile.network || row.profileSha256 !== profile.profileSha256
        || typeof row.sourceKey !== "string" || !row.sourceKey.startsWith(`${profile.profile.network}:`)
        || !Number.isSafeInteger(row.startTimeMs) || !Number.isSafeInteger(row.endTimeMs) || !Number.isSafeInteger(row.retrievedAtMs)
        || (row.httpStatus !== null && !Number.isSafeInteger(row.httpStatus)) || (row.error !== null && typeof row.error !== "string")
        || !Number.isSafeInteger(row.returnedRows) || !Number.isSafeInteger(row.ignoredBefore) || !Number.isSafeInteger(row.ignoredAfter)) throw new Error("report request journal row is invalid");
      if (row.error === null && typeof row.httpStatus === "number" && row.httpStatus < 400) return [];
      const status = typeof row.httpStatus === "number" ? `HTTP ${row.httpStatus}` : "request failure";
      return [`collector request ${String(row.sourceKey ?? "unknown")}: ${status}${typeof row.error === "string" ? ` — ${row.error}` : ""}`];
    }) : [];
  });
  const records = terminalOperationHistory(storage, profile.profile.network);
  const latest = new Map<string, (typeof records)[number]>();
  for (const record of records) {
    const prior = latest.get(record.operation);
    if (!prior || record.endedAt! > prior.endedAt! || (record.endedAt === prior.endedAt && record.runId > prior.runId)) latest.set(record.operation, record);
  }
  const states = [...latest.values()].map((record) => {
    const detail = record.stage ?? (typeof record.detail?.modelVersion === "string" ? record.detail.modelVersion : null);
    return `${record.operation} terminal: ${record.status}${detail ? ` — ${detail}` : ""}`;
  });
  const failures = records.filter((record) => record.status === "failure" && Date.parse(record.endedAt!) <= nowMs && Date.parse(record.endedAt!) >= nowMs - 30 * 24 * 60 * 60 * 1_000)
    .map((record) => `${record.operation} failure: ${record.error}`);
  return [...quarantines, ...requests, ...states, ...failures];
}

export function generateReport(rootInput: string, candidateInput: string, derivedManifestInput: string, profile: LoadedResearchNetworkProfile, nowMs = Date.now()): { path: string; bytes: string } {
  const root = resolve(rootInput);
  const storage = openResearchPersistence(root);
  assertLoadedResearchNetworkProfile(profile);
  assertResearchRootIdentity(storage, researchRootIdentity(profile));
  const current = verified(root, candidateInput, storage, profile, nowMs, { allowRejectedProjectionEvidence: true });
  const derived = readDerivedDataset(root, derivedManifestInput, storage);
  if (derived.manifest.network !== profile.profile.network || derived.manifest.dataManifestSha256 !== current.candidate.dataManifestSha256 || derived.manifest.sourceRegistrySha256 !== profile.sourceRegistrySha256 || derived.manifest.sourceRegistrySha256 !== current.candidate.sourceRegistrySha256) throw new Error("report derived manifest identity mismatch");
  if (current.validation.schemaVersion !== 3 || current.validation.derivedManifestPath !== derived.manifestPath || current.validation.derivedManifestSha256 !== derived.manifestSha256
    || current.validation.returnsSha256 !== derived.manifest.returns.sha256 || current.validation.exclusionsSha256 !== derived.manifest.exclusions.sha256
    || canonicalJson(current.validation.derivationWindow) !== canonicalJson(derived.manifest.window)) throw new Error("report validation derived manifest identity mismatch");
  if (readSourceRegistryFact(root, derived.manifest.sourceRegistrySha256, storage).registry.network !== derived.manifest.network) throw new Error("report derived manifest network mismatch");
  assertValidationDerivedIdentity(root, storage, current.candidate, current.validation, profile);
  const championPath = "artifacts/champion.json";
  let champion: ReportInput["champion"] = null;
  if (storage.exists(championPath)) {
    const championBytes = storage.readText(championPath);
    let championIdentity: Partial<CorrelationArtifact>;
    try { championIdentity = JSON.parse(championBytes) as Partial<CorrelationArtifact>; } catch { throw new Error("report champion is malformed JSON"); }
    const current = championIdentity.network === profile.profile.network && championIdentity.profileSha256 === profile.profileSha256 && championIdentity.sourceRegistrySha256 === profile.sourceRegistrySha256 && championIdentity.deploymentRegistrySha256 === profile.deploymentRegistrySha256 && championIdentity.baselineCorrelationSha256 === profile.baselineCorrelationSha256;
    if (current) {
      const artifact = parseCorrelationArtifact(championBytes, nowMs, profile.sources, undefined, profile).artifact;
      const championCandidate = `artifacts/candidates/${artifact.modelVersion}.json`;
      const championEvidence = verified(root, championCandidate, storage, profile, nowMs);
      if (sha256(championBytes) !== sha256(storage.read(championCandidate))) throw new Error("report champion candidate mismatch");
      if (championEvidence.validation.decision !== "Supported" || !championEvidence.validation.deterministicRerunMatches) throw new Error("report champion validation is not Supported and deterministic");
      champion = { modelVersion: artifact.modelVersion, sha256: sha256(championBytes) };
    }
  }
  const bytes = renderReport({ manifest: current.manifest, candidate: current.candidate, candidateSha256: current.candidateSha256, validation: current.validation, validationSha256: current.validationSha256, champion, funnel: journalFunnel(root, profile, storage), failures: operationalFailures(storage, profile, nowMs), exclusions: derived.exclusions, nowMs });
  const date = current.candidate.dataAsOf.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("report dataAsOf date is invalid");
  const path = `reports/${date}-${current.candidate.modelVersion}.html`;
  storage.writeAtomic(path, bytes);
  return { path: resolve(root, path), bytes };
}
