import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { MarketInfo } from "../markets.js";
import { parseCorrelations, type CorrelationTable } from "../correlation.js";
import type { ValidationReport } from "./replay.js";
import { trailingFresh } from "./returns.js";
import { atomicWrite, canonicalJson, sha256, verifyManifest } from "./store.js";
import type { CorrelationArtifact, DataManifest, SourceRegistry } from "./types.js";

const SHA256 = /^[0-9a-f]{64}$/;
const DAY = 86_400_000;
const CANDIDATE_MAX_AGE_MS = 30 * 3_600_000;
const CHAMPION_MAX_AGE_MS = 7 * DAY;

export interface ArtifactModelMetadata {
  version: string;
  dataAsOf: string;
  dataManifestSha256: string;
  sourceRegistrySha256: string;
  ageMs: number;
  multiAssetEnabled: boolean;
  eligibleUnderlyings: Set<string>;
  quarantinedUnderlyings: Map<string, string>;
  fallbackEligible: Set<string>;
  pairEligibility: Map<string, { status: "direct" | "fallback" | "quarantined"; reason: string }>;
}

export interface ValidatedArtifact {
  artifact: CorrelationArtifact;
  table: CorrelationTable;
  model: ArtifactModelMetadata;
}

export interface PromotionReceipt {
  schemaVersion: 1;
  modelVersion: string;
  promotedAt: string;
  dataAgeMs: number;
  candidateSha256: string;
  championSha256: string;
  dataManifestSha256: string;
  sourceRegistrySha256: string;
  baselineSha256: string;
  validationSha256: string;
  validationState: "Supported" | "Inconclusive";
  candidatePath: string;
  manifestPath: string;
  validationPath: string;
  verificationPath: string;
  receiptPath: string;
}

type Context = { manifest: DataManifest; sources: SourceRegistry; markets: Map<string, MarketInfo>; validation: ValidationReport };
function fail(message: string): never { throw new Error(`artifact: ${message}`); }
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
};
const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be non-empty`);
  return value;
};
const finite = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be finite`);
  return value;
};
const hash = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} must be a lowercase sha256 hash`);
  return value;
};
const timestamp = (value: unknown, label: string): number => {
  const raw = text(value, label);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== raw) fail(`${label} must be an exact ISO timestamp`);
  return parsed;
};
const pairKey = (left: string, right: string): string => left < right ? `${left}:${right}` : `${right}:${left}`;
const sorted = (values: Iterable<string>): string[] => [...values].sort();
const same = (left: Iterable<string>, right: Iterable<string>): boolean => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));

function validateMatrix(value: unknown, size: number, label: string, nullable = false): void {
  if (!Array.isArray(value) || value.length !== size) fail(`${label} dimensions do not match matrixOrder`);
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== size) fail(`${label} dimensions do not match matrixOrder`);
    for (const cell of row) if (!(nullable && cell === null)) finite(cell, label);
  }
}

export function parseCorrelationArtifact(raw: string, nowMs = Date.now(), sources?: SourceRegistry, markets?: Map<string, MarketInfo>): ValidatedArtifact {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { fail("malformed JSON"); }
  const artifact = parsed as CorrelationArtifact;
  const root = object(artifact, "root");
  if (root.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (root.modelFamily !== "hierarchical-gaussian-factor") fail("modelFamily must be hierarchical-gaussian-factor");
  const modelVersion = text(root.modelVersion, "modelVersion");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(modelVersion)) fail("modelVersion is not a safe artifact filename");
  const createdAtMs = timestamp(root.createdAt, "createdAt");
  const dataAsOfMs = timestamp(root.dataAsOf, "dataAsOf");
  if (dataAsOfMs > createdAtMs) fail("dataAsOf must not follow createdAt");
  if (!Number.isSafeInteger(nowMs)) fail("nowMs must be a safe integer");
  if (dataAsOfMs > nowMs) fail("dataAsOf is in the future");
  const dataManifestSha256 = hash(root.dataManifestSha256, "dataManifestSha256");
  const sourceRegistrySha256 = hash(root.sourceRegistrySha256, "sourceRegistrySha256");
  const policy = object(root.policy, "policy");
  if (policy.lookbackDays !== 180 || policy.halfLifeDays !== 45 || JSON.stringify(policy.diagnosticWindowsDays) !== "[30,90,180]" || policy.minHourly !== 1_000 || policy.minDaily !== 90 || policy.minCoverage !== 0.8 || policy.maxProjectionError !== 0.10) fail("policy must match [180,45,[30,90,180]] and fixed quality gates");
  const clusters = object(root.clusters, "clusters");
  if (Object.keys(clusters).length === 0) fail("clusters must be non-empty");
  const clusterByUnderlying = new Map<string, string>();
  for (const [cluster, rawEntries] of Object.entries(clusters)) {
    const entries = object(rawEntries, `clusters.${cluster}`);
    if (Object.keys(entries).length === 0) fail(`clusters.${cluster} must be non-empty`);
    for (const [underlying, rawLoading] of Object.entries(entries)) {
      if (clusterByUnderlying.has(underlying)) fail(`duplicate cluster entry for ${underlying}`);
      const loading = object(rawLoading, `clusters.${cluster}.${underlying}`);
      const global = finite(loading.global, `clusters.${cluster}.${underlying}.global`);
      const member = finite(loading.cluster, `clusters.${cluster}.${underlying}.cluster`);
      const structural = finite(loading.underlying, `clusters.${cluster}.${underlying}.underlying`);
      if ([global, member, structural].some((value) => value < 0 || value > 1) || global ** 2 + member ** 2 + structural ** 2 > 0.99 + 1e-12) fail(`clusters.${cluster}.${underlying} loadings explain over 0.99 variance`);
      if (loading.underlyingBasis !== "structural-underlying") fail(`clusters.${cluster}.${underlying}.underlyingBasis is invalid`);
      clusterByUnderlying.set(underlying, cluster);
    }
  }
  const quality = object(root.quality, "quality");
  if (!Array.isArray(quality.matrixOrder) || quality.matrixOrder.some((value) => typeof value !== "string" || !value) || new Set(quality.matrixOrder).size !== quality.matrixOrder.length) fail("matrixOrder must contain unique underlyings");
  const matrixOrder = quality.matrixOrder as string[];
  if (!Array.isArray(quality.eligibleUnderlyings) || quality.eligibleUnderlyings.some((value) => typeof value !== "string" || !value) || new Set(quality.eligibleUnderlyings).size !== quality.eligibleUnderlyings.length) fail("eligibleUnderlyings must be unique non-empty strings");
  const eligible = new Set(quality.eligibleUnderlyings as string[]);
  if (!same(eligible, clusterByUnderlying.keys())) fail("eligible entries must exactly match clusters");
  if (!Array.isArray(quality.quarantinedUnderlyings)) fail("quarantinedUnderlyings must be an array");
  const quarantined = new Map<string, string>();
  for (const value of quality.quarantinedUnderlyings as unknown[]) {
    const entry = object(value, "quarantine");
    const underlying = text(entry.underlying, "quarantine underlying");
    const reason = text(entry.reason, "quarantine reason");
    if (eligible.has(underlying) || quarantined.has(underlying)) fail(`quarantine sets overlap or duplicate ${underlying}`);
    quarantined.set(underlying, reason);
  }
  if (!same(matrixOrder, [...eligible, ...quarantined.keys()])) fail("matrixOrder must exactly cover eligible and quarantined underlyings");
  const last = object(quality.lastUsableObservationMs, "lastUsableObservationMs");
  if (!same(Object.keys(last), matrixOrder)) fail("lastUsableObservationMs must cover matrixOrder exactly");
  for (const [underlying, value] of Object.entries(last)) if (value !== null && (!Number.isSafeInteger(value) || (value as number) < 0)) fail(`lastUsableObservationMs.${underlying} must be a safe non-negative integer or null`);
  finite(quality.maxProjectionError, "maxProjectionError");
  if ((quality.maxProjectionError as number) > 0.10) fail("maxProjectionError exceeds policy");
  finite(quality.highamProjectionDelta, "highamProjectionDelta");
  validateMatrix(quality.signedPsdTarget, matrixOrder.length, "signedPsdTarget");
  const diagnostics = object(quality.diagnosticMatrices, "diagnosticMatrices");
  if (!same(Object.keys(diagnostics), ["30", "90", "180"])) fail("diagnosticMatrices must contain 30, 90, and 180");
  for (const window of ["30", "90", "180"]) validateMatrix(diagnostics[window], matrixOrder.length, `diagnosticMatrices.${window}`, true);
  if (!Array.isArray(quality.pairDiagnostics)) fail("pairDiagnostics must be an array");
  for (const value of quality.pairDiagnostics as unknown[]) {
    const entry = object(value, "pairDiagnostics entry");
    for (const name of ["observations", "expected", "coverage", "shrinkTarget", "shrinkLambda", "target", "implied", "residual"]) finite(entry[name], `pairDiagnostics.${name}`);
    for (const name of ["effectiveN", "raw"]) if (entry[name] !== null) finite(entry[name], `pairDiagnostics.${name}`);
    if (typeof entry.mode !== "string" || !Array.isArray(entry.pair) || entry.pair.length !== 2 || typeof entry.fallbackUsed !== "boolean") fail("pairDiagnostics shape is invalid");
  }
  if (!Array.isArray(quality.clippedNegativePairs)) fail("clippedNegativePairs must be an array");
  for (const value of quality.clippedNegativePairs as unknown[]) finite(object(value, "clippedNegativePairs entry").target, "clippedNegativePairs.target");
  if (!Array.isArray(quality.pairEligibility)) fail("pair eligibility must be an array");
  const expectedPairs = new Set<string>();
  for (let left = 0; left < matrixOrder.length; left++) for (let right = left + 1; right < matrixOrder.length; right++) expectedPairs.add(pairKey(matrixOrder[left], matrixOrder[right]));
  const pairs = new Map<string, { status: "direct" | "fallback" | "quarantined"; reason: string }>();
  for (const value of quality.pairEligibility as unknown[]) {
    const entry = object(value, "pair eligibility entry");
    if (!Array.isArray(entry.pair) || entry.pair.length !== 2 || typeof entry.pair[0] !== "string" || typeof entry.pair[1] !== "string") fail("pair eligibility pair is invalid");
    const [left, right] = entry.pair as [string, string];
    if (left >= right) fail(`canonical pair required for ${left}:${right}`);
    const key = pairKey(left, right);
    if (pairs.has(key)) fail(`duplicate pair ${key}`);
    if (!expectedPairs.has(key)) fail(`pair eligibility references unknown pair ${key}`);
    if (entry.status !== "direct" && entry.status !== "fallback" && entry.status !== "quarantined") fail(`pair eligibility status is invalid for ${key}`);
    if (entry.status !== "quarantined" && (!eligible.has(left) || !eligible.has(right))) fail(`non-quarantined pair ${key} contains a quarantined underlying`);
    pairs.set(key, { status: entry.status as "direct" | "fallback" | "quarantined", reason: text(entry.reason, `pair eligibility reason ${key}`) });
  }
  if (!same(pairs.keys(), expectedPairs)) fail("pair eligibility must contain every canonical pair exactly once");
  const validation = object(root.validation, "validation");
  if (validation.status !== "pending") fail("candidate validation status must be pending");
  const table = parseCorrelations(raw);
  const sourceByUnderlying = new Map(sources?.sources.map((entry) => [entry.underlying, entry]) ?? []);
  if (sources) {
    if (sha256(canonicalJson(sources)) !== sourceRegistrySha256) fail("current source registry hash mismatch");
    if (!same(sourceByUnderlying.keys(), matrixOrder)) fail("source registry and matrixOrder disagree");
    for (const [underlying, cluster] of clusterByUnderlying) if (sourceByUnderlying.get(underlying)?.cluster !== cluster) fail(`source/artifact cluster disagreement for ${underlying}`);
    for (const market of markets?.values() ?? []) {
      const source = sourceByUnderlying.get(market.underlying);
      if (!source || source.cluster !== market.cluster) fail(`source/market cluster disagreement for ${market.underlying}`);
      const artifactCluster = clusterByUnderlying.get(market.underlying);
      if (artifactCluster !== undefined && artifactCluster !== market.cluster) fail(`market/artifact cluster disagreement for ${market.underlying}`);
    }
  }
  const ageMs = nowMs - dataAsOfMs;
  const eligibleUnderlyings = new Set([...eligible].filter((underlying) => sources === undefined || sourceByUnderlying.get(underlying)?.eligible === true));
  const fallbackEligible = new Set(sources?.sources.filter((entry) => entry.fallbackEligible).map((entry) => entry.underlying) ?? []);
  return { artifact, table, model: { version: modelVersion, dataAsOf: artifact.dataAsOf, dataManifestSha256, sourceRegistrySha256, ageMs, multiAssetEnabled: ageMs < CHAMPION_MAX_AGE_MS, eligibleUnderlyings, quarantinedUnderlyings: quarantined, fallbackEligible, pairEligibility: pairs } };
}

export function validateArtifact(raw: string, context: Context, nowMs: number): ValidatedArtifact {
  const result = parseCorrelationArtifact(raw, nowMs, context.sources, context.markets);
  const { artifact } = result;
  if (!Number.isSafeInteger(nowMs)) fail("nowMs must be a safe integer");
  const ageMs = nowMs - Date.parse(artifact.dataAsOf);
  if (ageMs < 0) fail("dataAsOf is in the future");
  if (ageMs > CANDIDATE_MAX_AGE_MS) fail("candidate data age exceeds 30 hours");
  if (sha256(canonicalJson(context.manifest)) !== artifact.dataManifestSha256) fail("manifest hash mismatch");
  if (context.manifest.sourceRegistrySha256 !== artifact.sourceRegistrySha256) fail("manifest source registry hash mismatch");
  if (context.manifest.createdAt !== artifact.createdAt) fail("manifest createdAt mismatch");
  if (sha256(canonicalJson(context.sources)) !== artifact.sourceRegistrySha256) fail("source registry hash mismatch");
  const sourceByUnderlying = new Map(context.sources.sources.map((entry) => [entry.underlying, entry]));
  for (const underlying of artifact.quality.eligibleUnderlyings) {
    const source = sourceByUnderlying.get(underlying)!;
    if (!source.eligible) fail(`eligible artifact entry has ineligible source ${underlying}`);
    const observed = artifact.quality.lastUsableObservationMs[underlying];
    if (observed === null || !trailingFresh(source, [observed], Date.parse(artifact.dataAsOf))) fail(`trailing freshness failed for ${underlying}`);
  }
  for (const [key, pair] of result.model.pairEligibility) if (pair.status === "fallback") {
    const [left, right] = key.split(":");
    if (!sourceByUnderlying.get(left)?.fallbackEligible || !sourceByUnderlying.get(right)?.fallbackEligible) fail(`fallback pair ${key} is not a subset of operator-approved fallbacks`);
  }
  const report = context.validation;
  if (report.schemaVersion !== 1 || report.modelVersion !== artifact.modelVersion || report.inputManifestSha256 !== artifact.dataManifestSha256) fail("validation identity mismatch");
  if (report.candidateSha256 !== sha256(raw)) fail("validation candidate hash mismatch");
  hash(report.baselineSha256, "validation baselineSha256");
  if (!report.baselineSnapshotPath) fail("validation baselineSnapshotPath is missing");
  if (report.decision === "Rejected") fail("validation is Rejected");
  if (report.decision !== "Supported" && report.decision !== "Inconclusive") fail("validation decision is invalid");
  if (!report.deterministicRerunMatches) fail("validation deterministic rerun failed");
  return result;
}

function inside(root: string, path: string): boolean { return path === root || path.startsWith(`${root}/`); }

function manifestFor(root: string, expectedHash: string): { manifest: DataManifest; path: string } {
  const named = join(root, "manifests", `${expectedHash}.json`);
  const candidates: string[] = [];
  const walk = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".json")) candidates.push(path);
    }
  };
  if (existsSync(named)) candidates.push(named); else walk(root);
  for (const path of candidates) try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as DataManifest;
    if (sha256(canonicalJson(manifest)) === expectedHash) return { manifest, path };
  } catch { /* another JSON artifact */ }
  return fail(`referenced manifest ${expectedHash} not found`);
}

function durableTemporary(file: string, bytes: string): void {
  const fd = openSync(file, "wx");
  try {
    const data = Buffer.from(bytes);
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export function promoteCandidate(rootInput: string, candidatePath: string, sources: SourceRegistry, markets: Map<string, MarketInfo>, nowMs: number, hooks?: { beforeRename?: () => void }): PromotionReceipt {
  const root = resolve(rootInput);
  const candidate = resolve(root, candidatePath);
  if (!inside(root, candidate)) fail("candidate path escapes research root");
  const raw = readFileSync(candidate, "utf8");
  const preliminary = parseCorrelationArtifact(raw, nowMs, sources);
  if (basename(candidate) !== `${preliminary.artifact.modelVersion}.json`) fail("candidate filename does not match modelVersion");
  const manifestFact = manifestFor(root, preliminary.artifact.dataManifestSha256);
  verifyManifest(root, manifestFact.manifest);
  const sourceSnapshot = join(root, "facts", "source-registries", `${preliminary.artifact.sourceRegistrySha256}.json`);
  if (sha256(readFileSync(sourceSnapshot)) !== preliminary.artifact.sourceRegistrySha256) fail("source registry snapshot hash mismatch");
  const validationPath = join(dirname(candidate), `${preliminary.artifact.modelVersion}.validation.json`);
  const validationBytes = readFileSync(validationPath, "utf8");
  const validation = JSON.parse(validationBytes) as ValidationReport;
  const validated = validateArtifact(raw, { manifest: manifestFact.manifest, sources, markets, validation }, nowMs);
  const baseline = resolve(root, validation.baselineSnapshotPath);
  if (!inside(root, baseline) || sha256(readFileSync(baseline)) !== validation.baselineSha256) fail("baseline snapshot hash mismatch");
  const candidateSha256 = sha256(raw);
  const validationSha256 = sha256(validationBytes);
  const artifacts = join(root, "artifacts");
  const verificationPath = join(artifacts, "candidates", `${validated.artifact.modelVersion}.verification.json`);
  const verification = {
    schemaVersion: 1, modelVersion: validated.artifact.modelVersion, candidateSha256, dataManifestSha256: validated.artifact.dataManifestSha256,
    sourceRegistrySha256: validated.artifact.sourceRegistrySha256, baselineSha256: validation.baselineSha256, validationSha256,
    candidatePath: relative(root, candidate), manifestPath: relative(root, manifestFact.path), validationPath: relative(root, validationPath), baselineSnapshotPath: validation.baselineSnapshotPath,
  };
  atomicWrite(verificationPath, `${canonicalJson(verification)}\n`);
  const receiptPath = join(artifacts, "promotions", `${validated.artifact.modelVersion}.${nowMs}.json`);
  const receipt: PromotionReceipt = {
    schemaVersion: 1, modelVersion: validated.artifact.modelVersion, promotedAt: new Date(nowMs).toISOString(), dataAgeMs: nowMs - Date.parse(validated.artifact.dataAsOf),
    candidateSha256, championSha256: candidateSha256, dataManifestSha256: validated.artifact.dataManifestSha256, sourceRegistrySha256: validated.artifact.sourceRegistrySha256,
    baselineSha256: validation.baselineSha256, validationSha256, validationState: validation.decision as "Supported" | "Inconclusive",
    candidatePath: relative(root, candidate), manifestPath: relative(root, manifestFact.path), validationPath: relative(root, validationPath),
    verificationPath: relative(root, verificationPath), receiptPath: relative(root, receiptPath),
  };
  atomicWrite(receiptPath, `${canonicalJson(receipt)}\n`);
  const champion = join(artifacts, "champion.json");
  const temporary = `${champion}.tmp`;
  try {
    durableTemporary(temporary, raw);
    hooks?.beforeRename?.();
    renameSync(temporary, champion);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  try {
    const directory = openSync(artifacts, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    console.warn(JSON.stringify({ event: "champion-directory-fsync-warning", error: (error as Error).message }));
  }
  return receipt;
}
