import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ValidationReport } from "./replay.js";
import { atomicWrite, canonicalJson, containedPath, sha256, verifyManifest } from "./store.js";
import type { CorrelationArtifact, DataManifest } from "./types.js";

export interface ReportInput {
  manifest: DataManifest;
  candidate: CorrelationArtifact;
  validation: ValidationReport;
  champion: { modelVersion: string; sha256: string } | null;
  funnel: { quotes: number; minted: number; resolved: number };
  failures: string[];
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
  const operational = [...input.failures].filter((item) => item.includes(" state:")).sort().map((item) => ["operation", item]);
  const failures = [...input.failures].filter((item) => !item.includes(" state:")).sort().map((failure) => ["operation", failure]);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Correlation beta evidence — ${escapeHtml(candidate.modelVersion)}</title><style>:root{color-scheme:dark;font:15px system-ui;background:#0d1117;color:#e6edf3}body{max-width:1200px;margin:auto;padding:2rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:1rem}.card{border:1px solid #30363d;border-radius:8px;padding:1rem;overflow:auto}.label{color:#7ee787;font-size:.75rem;text-transform:uppercase;letter-spacing:.08em}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #30363d;padding:.4rem;text-align:left;white-space:nowrap}.warning{color:#ffa657}</style></head><body>
<header><p class="label">Operator decision</p><h1>Correlation beta evidence</h1><p class="warning">Testnet P&amp;L is not evidence of production expected value.</p></header>
<main class="grid">
${section("Operator decision", "Validation state", `<p><strong>${escapeHtml(validation.decision)}</strong> — Supported / Inconclusive / Rejected</p>`)}
${section("Observed fact", "Immutable identities", table(["Identity", "Value"], [["candidate", candidate.modelVersion], ["manifest", `manifest-${candidate.dataManifestSha256.slice(0, 12)}`], ["champion", input.champion ? `champion-${input.champion.sha256.slice(0, 12)}` : "not promoted"]]))}
${section("Observed fact", "Freshness and missing intervals", table(["Underlying", "Rows", "Last usable (ms)", "Missing intervals"], Object.entries(manifest.underlyings).sort(([left], [right]) => left.localeCompare(right)).map(([underlying, value]) => [underlying, value.rows, value.lastUsableObservationMs, value.missingIntervals.join(", ") || "none"])))}
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

const filesBelow = (path: string): string[] => existsSync(path) ? readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
  if (entry.isSymbolicLink()) throw new Error(`report closure contains a symbolic link: ${join(path, entry.name)}`);
  return entry.isDirectory() ? filesBelow(join(path, entry.name)) : [join(path, entry.name)];
}) : [];
const inside = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`);

function verified(root: string, candidatePath: string): { candidate: CorrelationArtifact; manifest: DataManifest; validation: ValidationReport; bytes: string } {
  const path = containedPath(root, candidatePath);
  const bytes = readFileSync(path, "utf8");
  const candidate = JSON.parse(bytes) as CorrelationArtifact;
  if (!safeModelVersion(candidate.modelVersion)) throw new Error("report modelVersion is not a safe artifact filename");
  if (!SHA256.test(candidate.dataManifestSha256)) throw new Error("report candidate manifest hash is invalid");
  const manifestPath = containedPath(root, join("manifests", `${candidate.dataManifestSha256}.json`));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as DataManifest;
  if (sha256(canonicalJson(manifest)) !== candidate.dataManifestSha256) throw new Error("report manifest identity mismatch");
  verifyManifest(root, manifest);
  if (manifest.sourceRegistrySha256 !== candidate.sourceRegistrySha256) throw new Error("report source registry identity mismatch");
  const validationPath = containedPath(root, resolve(dirname(path), `${candidate.modelVersion}.validation.json`));
  const validation = JSON.parse(readFileSync(validationPath, "utf8")) as ValidationReport;
  if (!safeModelVersion(validation.modelVersion)) throw new Error("report validation modelVersion is not a safe artifact filename");
  if (validation.modelVersion !== candidate.modelVersion || validation.candidateSha256 !== sha256(bytes) || validation.inputManifestSha256 !== candidate.dataManifestSha256) throw new Error("report validation identity mismatch");
  let baseline: string;
  try { baseline = containedPath(root, validation.baselineSnapshotPath); } catch { throw new Error("report baseline snapshot mismatch"); }
  if (sha256(readFileSync(baseline)) !== validation.baselineSha256) throw new Error("report baseline snapshot mismatch");
  return { candidate, manifest, validation, bytes };
}

export function journalFunnel(root: string): ReportInput["funnel"] {
  const parse = (directory: string): Record<string, unknown>[] => filesBelow(join(root, "journal", directory)).sort().flatMap((file) => {
    const text = readFileSync(file, "utf8").trim();
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

function operationalFailures(root: string): string[] {
  const quarantines = filesBelow(join(root, "quarantine")).sort().flatMap((file) => {
    const text = readFileSync(file, "utf8").trim();
    return text ? text.split("\n").map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      return String(row.reason ?? row.error ?? `quarantined ${row.underlying ?? relative(root, file)}`);
    }) : [];
  });
  const requests = filesBelow(join(root, "journal", "requests")).sort().flatMap((file) => {
    const text = readFileSync(file, "utf8").trim();
    return text ? text.split("\n").flatMap((line) => {
      const row = JSON.parse(line) as { sourceKey?: unknown; httpStatus?: unknown; error?: unknown };
      if (row.error === null && typeof row.httpStatus === "number" && row.httpStatus < 400) return [];
      const status = typeof row.httpStatus === "number" ? `HTTP ${row.httpStatus}` : "request failure";
      return [`collector request ${String(row.sourceKey ?? "unknown")}: ${status}${typeof row.error === "string" ? ` — ${row.error}` : ""}`];
    }) : [];
  });
  const states: string[] = [];
  const collectorFile = join(root, "state", "collector.json");
  if (existsSync(collectorFile)) {
    const collector = JSON.parse(readFileSync(containedPath(root, collectorFile), "utf8")) as { sources?: unknown };
    if (collector.sources && typeof collector.sources === "object" && !Array.isArray(collector.sources)) states.push(`collector state: ${Object.keys(collector.sources).length} source checkpoints`);
  }
  for (const [operation, file] of [["calibrator", "calibrator.json"], ["daily", "daily.json"], ["join", "join.json"], ["backup", "backup.json"]] as const) {
    const path = join(root, "state", file);
    if (!existsSync(path)) continue;
    const state = JSON.parse(readFileSync(containedPath(root, path), "utf8")) as { status?: unknown; error?: unknown; details?: { modelVersion?: unknown } };
    if (typeof state.status !== "string") continue;
    const detail = operation === "calibrator" && typeof state.details?.modelVersion === "string"
      ? state.details.modelVersion
      : typeof state.error === "string" ? state.error : null;
    states.push(`${operation} state: ${state.status}${detail ? ` — ${detail}` : ""}`);
  }
  return [...quarantines, ...requests, ...states];
}

export function generateReport(rootInput: string, candidateInput: string): { path: string; bytes: string } {
  const root = resolve(rootInput);
  const current = verified(root, candidateInput);
  const championPath = join(root, "artifacts", "champion.json");
  let champion: ReportInput["champion"] = null;
  if (existsSync(championPath)) {
    const championBytes = readFileSync(containedPath(root, championPath), "utf8");
    const artifact = JSON.parse(championBytes) as CorrelationArtifact;
    if (!safeModelVersion(artifact.modelVersion)) throw new Error("report champion modelVersion is not a safe artifact filename");
    const championCandidate = containedPath(root, join("artifacts", "candidates", `${artifact.modelVersion}.json`));
    verified(root, championCandidate);
    if (sha256(championBytes) !== sha256(readFileSync(championCandidate))) throw new Error("report champion candidate mismatch");
    champion = { modelVersion: artifact.modelVersion, sha256: sha256(championBytes) };
  }
  const bytes = renderReport({ manifest: current.manifest, candidate: current.candidate, validation: current.validation, champion, funnel: journalFunnel(root), failures: operationalFailures(root) });
  const date = current.candidate.dataAsOf.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("report dataAsOf date is invalid");
  const path = resolve(root, "reports", `${date}-${current.candidate.modelVersion}.html`);
  if (!inside(root, path)) throw new Error("report output path escapes root");
  atomicWrite(path, bytes);
  return { path, bytes };
}
