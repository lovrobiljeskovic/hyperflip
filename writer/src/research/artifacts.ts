import { resolve } from "node:path";
import type { MarketInfo } from "../markets.js";
import { pairCorrelation, parseCorrelations, type CorrelationTable } from "../correlation.js";
import type { ValidationReport } from "./replay.js";
import { trailingFresh } from "./returns.js";
import { openResearchPersistence, type ResearchPersistence } from "./persistence.js";
import { canonicalJson, readDerivedDataset, researchRelativePath, sha256, verifyManifest } from "./store.js";
import type { CorrelationArtifact, DataManifest, SourceRegistry } from "./types.js";
import { assertLoadedResearchNetworkProfile, bindResearchRootIdentity, type LoadedResearchNetworkProfile } from "./network.js";

const SHA256 = /^[0-9a-f]{64}$/;
const DAY = 86_400_000;
const CANDIDATE_MAX_AGE_MS = 30 * 3_600_000;
const CHAMPION_MAX_AGE_MS = 7 * DAY;

export interface ArtifactModelMetadata {
  artifactKind: "champion" | "profile-baseline";
  network: "testnet";
  profileSha256: string;
  version: string;
  dataAsOf: string;
  dataManifestSha256: string;
  sourceRegistrySha256: string;
  marketRegistrySha256: string;
  deploymentRegistrySha256: string;
  baselineCorrelationSha256: string;
  artifactSha256: string;
  validationSha256: string | null;
  validationState: "Supported" | "Unavailable";
  identityFailureReason: string | null;
  ageMs: number;
  multiAssetEnabled: boolean;
  eligibleUnderlyings: Set<string>;
  quarantinedUnderlyings: Map<string, string>;
  fallbackEligible: Set<string>;
  pairEligibility: Map<string, { status: "direct" | "fallback" | "quarantined"; reason: string; correlation: number | null }>;
}

export interface ValidatedArtifact {
  artifact: CorrelationArtifact;
  table: CorrelationTable;
  model: ArtifactModelMetadata;
}

export interface PromotionReceipt {
  schemaVersion: 2;
  network: "testnet";
  profileSha256: string;
  modelVersion: string;
  promotedAt: string;
  dataAgeMs: number;
  candidateSha256: string;
  championSha256: string;
  dataManifestSha256: string;
  sourceRegistrySha256: string;
  marketRegistrySha256: string;
  deploymentRegistrySha256: string;
  baselineCorrelationSha256: string;
  baselineSha256: string;
  validationSha256: string;
  validationState: "Supported";
  candidatePath: string;
  manifestPath: string;
  validationPath: string;
  verificationPath: string;
  receiptPath: string;
}

type Context = { manifest: DataManifest; sources: SourceRegistry; markets: Map<string, MarketInfo>; profile: LoadedResearchNetworkProfile; validation: ValidationReport };
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

export function parseCorrelationArtifact(raw: string, nowMs = Date.now(), sources?: SourceRegistry, markets?: Map<string, MarketInfo>, profile?: LoadedResearchNetworkProfile, options: { allowRejectedProjectionEvidence?: boolean } = {}): ValidatedArtifact {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { fail("malformed JSON"); }
  const artifact = parsed as CorrelationArtifact;
  const root = object(artifact, "root");
  if (root.schemaVersion !== 2) fail("schemaVersion must be 2");
  if (root.network !== "testnet") fail("network must be testnet");
  const profileSha256 = hash(root.profileSha256, "profileSha256");
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
  const marketRegistrySha256 = hash(root.marketRegistrySha256, "marketRegistrySha256");
  const deploymentRegistrySha256 = hash(root.deploymentRegistrySha256, "deploymentRegistrySha256");
  const baselineCorrelationSha256 = hash(root.baselineCorrelationSha256, "baselineCorrelationSha256");
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
  if ((quality.maxProjectionError as number) > 0.10 && !options.allowRejectedProjectionEvidence) fail("maxProjectionError exceeds policy");
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
  const pairs = new Map<string, { status: "direct" | "fallback" | "quarantined"; reason: string; correlation: number | null }>();
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
    pairs.set(key, { status: entry.status as "direct" | "fallback" | "quarantined", reason: text(entry.reason, `pair eligibility reason ${key}`), correlation: null });
  }
  if (!same(pairs.keys(), expectedPairs)) fail("pair eligibility must contain every canonical pair exactly once");
  const partitioned = new Map<string, "direct" | "fallback" | "quarantined">();
  const fallbackRecords = new Map<string, { pair: [string, string]; correlation: number }>();
  const pairRecords = (name: "directPairs" | "fallbackPairs", status: "direct" | "fallback", expectedReason: string): void => {
    if (!Array.isArray(root[name])) fail(`${name} must be an array`);
    for (const value of root[name] as unknown[]) {
      const entry = object(value, `${name} entry`);
      if (!Array.isArray(entry.pair) || entry.pair.length !== 2 || typeof entry.pair[0] !== "string" || typeof entry.pair[1] !== "string") fail(`${name} pair is invalid`);
      const [left, right] = entry.pair as [string, string];
      if (left >= right) fail(`canonical pair required for ${left}:${right}`);
      const key = pairKey(left, right);
      if (partitioned.has(key)) fail(`pair evidence duplicates ${key}`);
      if (pairs.get(key)?.status !== status || pairs.get(key)?.reason !== expectedReason || entry.reason !== expectedReason) fail(`${name} disagrees with pair eligibility for ${key}`);
      const correlation = finite(entry.correlation, `${name} correlation`);
      pairs.get(key)!.correlation = correlation;
      if (status === "fallback") fallbackRecords.set(key, { pair: [left, right], correlation });
      partitioned.set(key, status);
    }
  };
  pairRecords("directPairs", "direct", "testnet-quality-passed");
  pairRecords("fallbackPairs", "fallback", "operator-reviewed-testnet-bootstrap");
  if (!Array.isArray(root.quarantinedPairs)) fail("quarantinedPairs must be an array");
  for (const value of root.quarantinedPairs as unknown[]) {
    const entry = object(value, "quarantinedPairs entry");
    if (!Array.isArray(entry.pair) || entry.pair.length !== 2 || typeof entry.pair[0] !== "string" || typeof entry.pair[1] !== "string") fail("quarantinedPairs pair is invalid");
    const [left, right] = entry.pair as [string, string];
    if (left >= right) fail(`canonical pair required for ${left}:${right}`);
    const key = pairKey(left, right);
    if (partitioned.has(key)) fail(`pair evidence duplicates ${key}`);
    if (pairs.get(key)?.status !== "quarantined" || pairs.get(key)?.reason !== text(entry.reason, `quarantinedPairs reason ${key}`)) fail(`quarantinedPairs disagrees with pair eligibility for ${key}`);
    partitioned.set(key, "quarantined");
  }
  if (!same(partitioned.keys(), expectedPairs)) fail("pair evidence must partition every canonical pair exactly once");
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
  if (profile) {
    assertLoadedResearchNetworkProfile(profile);
    if (profile.profile.network !== root.network || profile.profileSha256 !== profileSha256 || profile.sourceRegistrySha256 !== sourceRegistrySha256 || profile.marketRegistrySha256 !== marketRegistrySha256 || profile.deploymentRegistrySha256 !== deploymentRegistrySha256 || profile.baselineCorrelationSha256 !== baselineCorrelationSha256) fail("artifact profile identity mismatch");
    const baseline = parseCorrelations(profile.baselineCorrelationRaw);
    const profileSources = new Map(profile.sources.sources.map((source) => [source.underlying, source]));
    for (const [key, record] of fallbackRecords) {
      const [left, right] = record.pair;
      const a = baseline.underlyings[left];
      const b = baseline.underlyings[right];
      const sourceA = profileSources.get(left);
      const sourceB = profileSources.get(right);
      if (a === undefined || b === undefined || sourceA === undefined || sourceB === undefined) fail(`fallback pair ${key} is missing an exact baseline entry`);
      const expected = pairCorrelation(a, b, sourceA.cluster === sourceB.cluster, left === right);
      if (record.correlation !== expected) fail(`fallback pair ${key} correlation differs from the exact baseline`);
    }
  }
  const ageMs = nowMs - dataAsOfMs;
  const eligibleUnderlyings = new Set(eligible);
  const fallbackEligible = new Set(sources?.sources.filter((entry) => entry.fallbackEligible).map((entry) => entry.underlying) ?? []);
  return { artifact, table, model: {
    artifactKind: "champion", network: "testnet", profileSha256, version: modelVersion, dataAsOf: artifact.dataAsOf, dataManifestSha256, sourceRegistrySha256,
    marketRegistrySha256, deploymentRegistrySha256, baselineCorrelationSha256, artifactSha256: sha256(raw), validationSha256: null,
    validationState: "Unavailable", identityFailureReason: null, ageMs, multiAssetEnabled: ageMs < CHAMPION_MAX_AGE_MS,
    eligibleUnderlyings, quarantinedUnderlyings: quarantined, fallbackEligible, pairEligibility: pairs,
  } };
}

export function validateArtifact(raw: string, context: Context, nowMs: number): ValidatedArtifact {
  const result = parseCorrelationArtifact(raw, nowMs, context.sources, context.markets, context.profile);
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
  for (const [key, pair] of result.model.pairEligibility) if (pair.status === "direct") {
    for (const underlying of key.split(":")) {
      const source = sourceByUnderlying.get(underlying)!;
      if (!source.measurementEnabled) fail(`direct pair ${key} has measurement-disabled source ${underlying}`);
      const observed = artifact.quality.lastUsableObservationMs[underlying];
      if (observed === null || !trailingFresh(source, [observed], Date.parse(artifact.dataAsOf))) fail(`trailing freshness failed for ${underlying}`);
    }
  } else if (pair.status === "fallback") {
    const [left, right] = key.split(":");
    if (!sourceByUnderlying.get(left)?.fallbackEligible || !sourceByUnderlying.get(right)?.fallbackEligible) fail(`fallback pair ${key} is not a subset of operator-approved fallbacks`);
  }
  const report = context.validation;
  assertValidationArtifactIdentity(raw, artifact, report, context.profile);
  hash(report.baselineSha256, "validation baselineSha256");
  if (!report.baselineSnapshotPath) fail("validation baselineSnapshotPath is missing");
  if (report.decision === "Rejected") fail("validation is Rejected");
  if (report.decision !== "Supported" && report.decision !== "Inconclusive") fail("validation decision is invalid");
  if (!report.deterministicRerunMatches) fail("validation deterministic rerun failed");
  return result;
}

export function assertValidationArtifactIdentity(raw: string, artifact: CorrelationArtifact, report: ValidationReport, profile: LoadedResearchNetworkProfile): void {
  if (report.schemaVersion !== 3) fail("validation schemaVersion must be 3");
  if (report.network !== profile.profile.network || report.network !== artifact.network) fail("validation network mismatch");
  if (report.profileSha256 !== profile.profileSha256 || report.profileSha256 !== artifact.profileSha256) fail("validation profile mismatch");
  if (report.modelVersion !== artifact.modelVersion || report.inputManifestSha256 !== artifact.dataManifestSha256) fail("validation identity mismatch");
  if (report.candidateSha256 !== sha256(raw)) fail("validation candidate hash mismatch");
  if (report.sourceRegistrySha256 !== profile.sourceRegistrySha256 || report.sourceRegistrySha256 !== artifact.sourceRegistrySha256) fail("validation source registry mismatch");
  if (report.marketRegistrySha256 !== profile.marketRegistrySha256 || report.marketRegistrySha256 !== artifact.marketRegistrySha256) fail("validation market registry mismatch");
  if (report.deploymentRegistrySha256 !== profile.deploymentRegistrySha256 || report.deploymentRegistrySha256 !== artifact.deploymentRegistrySha256) fail("validation deployment registry mismatch");
  if (report.baselineCorrelationSha256 !== profile.baselineCorrelationSha256 || report.baselineCorrelationSha256 !== artifact.baselineCorrelationSha256 || report.baselineSha256 !== profile.baselineCorrelationSha256) fail("validation baseline correlation mismatch");
  if (report.baselineSnapshotPath !== `facts/baselines/${profile.baselineCorrelationSha256}.json`) fail("validation baseline snapshot path mismatch");
  hash(report.derivedManifestSha256, "validation derivedManifestSha256");
  hash(report.returnsSha256, "validation returnsSha256");
  hash(report.exclusionsSha256, "validation exclusionsSha256");
  if (!report.derivedManifestPath) fail("validation derivedManifestPath is missing");
  if (!Number.isSafeInteger(report.derivationWindow?.asOfMs) || !Number.isSafeInteger(report.derivationWindow?.lookbackMs) || report.derivationWindow.lookbackMs < 0) fail("validation derivationWindow is invalid");
}

export function assertValidationDerivedIdentity(root: string, storage: ResearchPersistence, artifact: CorrelationArtifact, report: ValidationReport, profile: LoadedResearchNetworkProfile): void {
  let derived: ReturnType<typeof readDerivedDataset>;
  try { derived = readDerivedDataset(root, report.derivedManifestPath, storage); }
  catch (error) { return fail(`validation derived manifest mismatch: ${error instanceof Error ? error.message : String(error)}`); }
  if (derived.manifestSha256 !== report.derivedManifestSha256
    || derived.manifest.returns.sha256 !== report.returnsSha256
    || derived.manifest.exclusions.sha256 !== report.exclusionsSha256
    || canonicalJson(derived.manifest.window) !== canonicalJson(report.derivationWindow)
    || derived.manifest.dataManifestSha256 !== artifact.dataManifestSha256
    || derived.manifest.sourceRegistrySha256 !== profile.sourceRegistrySha256
    || derived.manifest.network !== profile.profile.network) {
    fail("validation derived manifest identity mismatch");
  }
}

function manifestFor(storage: ResearchPersistence, expectedHash: string): { manifest: DataManifest; path: string } {
  const named = `manifests/${expectedHash}.json`;
  const candidates = storage.exists(named)
    ? [named]
    : ["manifest.json", ...["manifests", "facts", "raw", "derived", "artifacts", "journal", "reports", "state", "quarantine"].flatMap((directory) => storage.list(directory))].filter((path) => path.endsWith(".json") && storage.exists(path)).sort();
  for (const path of candidates) try {
    const manifest = JSON.parse(storage.readText(path)) as DataManifest;
    if (sha256(canonicalJson(manifest)) === expectedHash) return { manifest, path };
  } catch { /* another JSON artifact */ }
  return fail(`referenced manifest ${expectedHash} not found`);
}

export function promoteCandidate(rootInput: string, candidatePath: string, profile: LoadedResearchNetworkProfile, markets: Map<string, MarketInfo>, nowMs: number, hooks?: { beforeRename?: () => void }): PromotionReceipt {
  const root = resolve(rootInput);
  const storage = openResearchPersistence(root);
  assertLoadedResearchNetworkProfile(profile);
  bindResearchRootIdentity(storage, profile);
  const sources = profile.sources;
  let candidate: string;
  try { candidate = researchRelativePath(root, candidatePath); } catch { return fail("candidate path escapes research root"); }
  const raw = storage.readText(candidate);
  const preliminary = parseCorrelationArtifact(raw, nowMs, sources, undefined, profile);
  if (candidate.split("/").at(-1) !== `${preliminary.artifact.modelVersion}.json`) fail("candidate filename does not match modelVersion");
  const manifestFact = manifestFor(storage, preliminary.artifact.dataManifestSha256);
  verifyManifest(root, manifestFact.manifest, storage);
  const sourceSnapshot = `facts/source-registries/${preliminary.artifact.sourceRegistrySha256}.json`;
  if (sha256(storage.read(sourceSnapshot)) !== preliminary.artifact.sourceRegistrySha256) fail("source registry snapshot hash mismatch");
  const candidateDirectory = candidate.includes("/") ? `${candidate.slice(0, candidate.lastIndexOf("/"))}/` : "";
  const validationPath = `${candidateDirectory}${preliminary.artifact.modelVersion}.validation.json`;
  const validationBytes = storage.readText(validationPath);
  const validation = JSON.parse(validationBytes) as ValidationReport;
  const validated = validateArtifact(raw, { manifest: manifestFact.manifest, sources, markets, profile, validation }, nowMs);
  if (validation.decision !== "Supported") fail("promotion requires Supported validation");
  assertValidationDerivedIdentity(root, storage, validated.artifact, validation, profile);
  let baseline: string;
  try { baseline = researchRelativePath(root, validation.baselineSnapshotPath); } catch { return fail("baseline snapshot hash mismatch"); }
  if (sha256(storage.read(baseline)) !== validation.baselineSha256) fail("baseline snapshot hash mismatch");
  const candidateSha256 = sha256(raw);
  const validationSha256 = sha256(validationBytes);
  const verificationPath = `artifacts/candidates/${validated.artifact.modelVersion}.verification.json`;
  const verification = {
    schemaVersion: 2, network: validated.artifact.network, profileSha256: validated.artifact.profileSha256,
    modelVersion: validated.artifact.modelVersion, candidateSha256, dataManifestSha256: validated.artifact.dataManifestSha256,
    sourceRegistrySha256: validated.artifact.sourceRegistrySha256, marketRegistrySha256: validated.artifact.marketRegistrySha256,
    deploymentRegistrySha256: validated.artifact.deploymentRegistrySha256, baselineCorrelationSha256: validated.artifact.baselineCorrelationSha256,
    baselineSha256: validation.baselineSha256, validationSha256,
    candidatePath: candidate, manifestPath: manifestFact.path, validationPath, baselineSnapshotPath: validation.baselineSnapshotPath,
  };
  storage.writeAtomic(verificationPath, `${canonicalJson(verification)}\n`);
  const receiptPath = `artifacts/promotions/${validated.artifact.modelVersion}.${nowMs}.json`;
  const receipt: PromotionReceipt = {
    schemaVersion: 2, network: "testnet", profileSha256: validated.artifact.profileSha256,
    modelVersion: validated.artifact.modelVersion, promotedAt: new Date(nowMs).toISOString(), dataAgeMs: nowMs - Date.parse(validated.artifact.dataAsOf),
    candidateSha256, championSha256: candidateSha256, dataManifestSha256: validated.artifact.dataManifestSha256, sourceRegistrySha256: validated.artifact.sourceRegistrySha256,
    marketRegistrySha256: validated.artifact.marketRegistrySha256, deploymentRegistrySha256: validated.artifact.deploymentRegistrySha256,
    baselineCorrelationSha256: validated.artifact.baselineCorrelationSha256, baselineSha256: validation.baselineSha256,
    validationSha256, validationState: "Supported",
    candidatePath: candidate, manifestPath: manifestFact.path, validationPath,
    verificationPath, receiptPath,
  };
  storage.writeAtomic(receiptPath, `${canonicalJson(receipt)}\n`);
  hooks?.beforeRename?.();
  storage.writeAtomic("artifacts/champion.json", raw);
  return receipt;
}
