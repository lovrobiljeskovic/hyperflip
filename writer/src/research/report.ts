import { resolve } from "node:path";
import type { ValidationReport } from "./replay.js";
import { openResearchPersistence, type ResearchPersistence } from "./persistence.js";
import { canonicalJson, readDerivedDataset, readSourceRegistryFact, researchRelativePath, sha256, verifyManifest } from "./store.js";
import type { CorrelationArtifact, DataManifest, ExclusionRecord } from "./types.js";
import { terminalOperationHistory } from "./operations.js";

export interface ReportInput {
  manifest: DataManifest;
  candidate: CorrelationArtifact;
  validation: ValidationReport;
  champion: { modelVersion: string; sha256: string } | null;
  funnel: { quotes: number; minted: number; resolved: number };
  failures: string[];
  exclusions: ExclusionRecord[];
  nowMs?: number;
}

const MODELS = ["independence", "static-hierarchical-gaussian", "measured-hierarchical-gaussian", "signed-t-copula", "filtered-historical-simulation"] as const;
const SAFE_MODEL_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
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
${section("Observed fact", "Immutable identities", table(["Identity", "Value"], [["candidate", candidate.modelVersion], ["manifest", `manifest-${candidate.dataManifestSha256.slice(0, 12)}`], ["champion", input.champion ? `champion-${input.champion.sha256.slice(0, 12)}` : "not promoted"]]))}
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

function verified(root: string, candidatePath: string, storage: ResearchPersistence): { candidate: CorrelationArtifact; manifest: DataManifest; validation: ValidationReport; bytes: string } {
  const path = researchRelativePath(root, candidatePath);
  const bytes = storage.readText(path);
  const candidate = JSON.parse(bytes) as CorrelationArtifact;
  if (!safeModelVersion(candidate.modelVersion)) throw new Error("report modelVersion is not a safe artifact filename");
  if (!SHA256.test(candidate.dataManifestSha256)) throw new Error("report candidate manifest hash is invalid");
  const manifestPath = `manifests/${candidate.dataManifestSha256}.json`;
  const manifest = JSON.parse(storage.readText(manifestPath)) as DataManifest;
  if (sha256(canonicalJson(manifest)) !== candidate.dataManifestSha256) throw new Error("report manifest identity mismatch");
  verifyManifest(root, manifest, storage);
  if (manifest.sourceRegistrySha256 !== candidate.sourceRegistrySha256) throw new Error("report source registry identity mismatch");
  const candidateDirectory = path.includes("/") ? `${path.slice(0, path.lastIndexOf("/"))}/` : "";
  const validationPath = `${candidateDirectory}${candidate.modelVersion}.validation.json`;
  const validation = JSON.parse(storage.readText(validationPath)) as ValidationReport;
  if (!safeModelVersion(validation.modelVersion)) throw new Error("report validation modelVersion is not a safe artifact filename");
  if (validation.modelVersion !== candidate.modelVersion || validation.candidateSha256 !== sha256(bytes) || validation.inputManifestSha256 !== candidate.dataManifestSha256) throw new Error("report validation identity mismatch");
  let baseline: string;
  try { baseline = researchRelativePath(root, validation.baselineSnapshotPath); } catch { throw new Error("report baseline snapshot mismatch"); }
  if (sha256(storage.read(baseline)) !== validation.baselineSha256) throw new Error("report baseline snapshot mismatch");
  return { candidate, manifest, validation, bytes };
}

export function journalFunnel(root: string, storage = openResearchPersistence(root)): ReportInput["funnel"] {
  const parse = (directory: string): Record<string, unknown>[] => storage.list(`journal/${directory}`).flatMap((file) => {
    const text = storage.readText(file).trim();
    return text ? text.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
  });
  const quotes = new Set(parse("quotes").map((row) => String(row.quoteId)));
  const events = parse("events");
  const orphaned = new Set(events.filter((row) => row.kind === "orphaned" && row.targetKind === "chain-log").map((row) => String(row.targetKey)));
  const active = events.filter((row) => (row.kind === "minted" || row.kind === "resolved") && !orphaned.has(`${String(row.eventKey)}:${String(row.blockHash).toLowerCase()}`));
  const mints = active.filter((row) => row.kind === "minted" && quotes.has(String(row.quoteId)));
  const mintedParlays = new Set(mints.map((row) => String(row.parlayId)));
  const resolvedParlays = new Set(active.filter((row) => row.kind === "resolved" && mintedParlays.has(String(row.parlayId))).map((row) => String(row.parlayId)));
  return { quotes: quotes.size, minted: new Set(mints.map((row) => `${String(row.quoteId)}:${String(row.parlayId)}`)).size, resolved: resolvedParlays.size };
}

function operationalFailures(storage: ResearchPersistence, network: CorrelationArtifact["network"], nowMs = Date.now()): string[] {
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
      const row = JSON.parse(line) as { sourceKey?: unknown; httpStatus?: unknown; error?: unknown };
      if (row.error === null && typeof row.httpStatus === "number" && row.httpStatus < 400) return [];
      const status = typeof row.httpStatus === "number" ? `HTTP ${row.httpStatus}` : "request failure";
      return [`collector request ${String(row.sourceKey ?? "unknown")}: ${status}${typeof row.error === "string" ? ` — ${row.error}` : ""}`];
    }) : [];
  });
  const records = terminalOperationHistory(storage, network);
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

export function generateReport(rootInput: string, candidateInput: string, derivedManifestInput: string, nowMs = Date.now()): { path: string; bytes: string } {
  const root = resolve(rootInput);
  const storage = openResearchPersistence(root);
  const current = verified(root, candidateInput, storage);
  const derived = readDerivedDataset(root, derivedManifestInput, storage);
  if (derived.manifest.dataManifestSha256 !== current.candidate.dataManifestSha256 || derived.manifest.sourceRegistrySha256 !== current.candidate.sourceRegistrySha256) throw new Error("report derived manifest identity mismatch");
  if (current.validation.schemaVersion !== 3 || current.validation.derivedManifestPath !== derived.manifestPath || current.validation.derivedManifestSha256 !== derived.manifestSha256
    || current.validation.returnsSha256 !== derived.manifest.returns.sha256 || current.validation.exclusionsSha256 !== derived.manifest.exclusions.sha256
    || canonicalJson(current.validation.derivationWindow) !== canonicalJson(derived.manifest.window)) throw new Error("report validation derived manifest identity mismatch");
  if (readSourceRegistryFact(root, derived.manifest.sourceRegistrySha256, storage).registry.network !== derived.manifest.network) throw new Error("report derived manifest network mismatch");
  const championPath = "artifacts/champion.json";
  let champion: ReportInput["champion"] = null;
  if (storage.exists(championPath)) {
    const championBytes = storage.readText(championPath);
    const artifact = JSON.parse(championBytes) as CorrelationArtifact;
    if (!safeModelVersion(artifact.modelVersion)) throw new Error("report champion modelVersion is not a safe artifact filename");
    const championCandidate = `artifacts/candidates/${artifact.modelVersion}.json`;
    verified(root, championCandidate, storage);
    if (sha256(championBytes) !== sha256(storage.read(championCandidate))) throw new Error("report champion candidate mismatch");
    champion = { modelVersion: artifact.modelVersion, sha256: sha256(championBytes) };
  }
  const bytes = renderReport({ manifest: current.manifest, candidate: current.candidate, validation: current.validation, champion, funnel: journalFunnel(root, storage), failures: operationalFailures(storage, current.candidate.network, nowMs), exclusions: derived.exclusions, nowMs });
  const date = current.candidate.dataAsOf.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("report dataAsOf date is invalid");
  const path = `reports/${date}-${current.candidate.modelVersion}.html`;
  storage.writeAtomic(path, bytes);
  return { path: resolve(root, path), bytes };
}
