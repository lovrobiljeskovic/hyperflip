import { openResearchPersistence, type ResearchPersistence } from "./persistence.js";
import { pairCorrelation, parseCorrelations } from "../correlation.js";
import { expectedIntervals, HOUR, quality, returnModeFor, sessionDates, trailingFresh, classifyCandle } from "./returns.js";
import type { QualityMode, ReturnRecord, Window } from "./returns.js";
import { fitSignedFactors, nearestCorrelationResult, structuredTargets, weightedCorrelation } from "./matrix.js";
import type { FitEvidenceInput, PairEstimate } from "./matrix.js";
import { canonicalJson, operationError, readCandlePartition, readDerivedDataset, readSourceRegistryFact, recordMarketRegistryFact, sha256, verifyManifest, writeOperationState } from "./store.js";
import { APPROVED_FIT_POLICY } from "./types.js";
import type { CandleRecord, CorrelationArtifact, DataManifest, DerivedManifestV2, SourceEntry } from "./types.js";
import { assertLoadedResearchNetworkProfile, bindResearchRootIdentity, type LoadedResearchNetworkProfile } from "./network.js";

const lexical = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const MIXED_TRIANGLE_TOLERANCE = 1e-10;

export interface CalibrationInput {
  root: string;
  manifest: DataManifest;
  derivedManifestPath: string;
  profile: LoadedResearchNetworkProfile;
  now?: () => number;
  storage?: ResearchPersistence;
}

export type PairAdmission =
  | { kind: "direct"; correlation: number; reason: "testnet-quality-passed" }
  | { kind: "fallback"; correlation: number; reason: "operator-reviewed-testnet-bootstrap" }
  | { kind: "quarantined"; reason: string };

export interface DirectPairEvidence {
  network: "testnet" | "mainnet";
  eligible: boolean;
  correlation: number | null;
  reason: string | null;
}

export function admitPair(left: SourceEntry, right: SourceEntry, direct: DirectPairEvidence | null, baseline: LoadedResearchNetworkProfile): PairAdmission {
  assertLoadedResearchNetworkProfile(baseline);
  if (left.measurementEnabled && right.measurementEnabled && left.sourceNetwork === "testnet" && right.sourceNetwork === "testnet" && direct?.network === "testnet" && direct.eligible && direct.correlation !== null) {
    return { kind: "direct", correlation: direct.correlation, reason: "testnet-quality-passed" };
  }
  if (left.fallbackEligible && right.fallbackEligible && left.sourceNetwork === "testnet" && right.sourceNetwork === "testnet") {
    const table = parseCorrelations(baseline.baselineCorrelationRaw);
    const a = table.underlyings[left.underlying];
    const b = table.underlyings[right.underlying];
    if (a !== undefined && b !== undefined) return { kind: "fallback", correlation: pairCorrelation(a, b, left.cluster === right.cluster, left.underlying === right.underlying), reason: "operator-reviewed-testnet-bootstrap" };
  }
  const ineligible = !left.measurementEnabled || !right.measurementEnabled || !left.fallbackEligible || !right.fallbackEligible;
  return { kind: "quarantined", reason: direct?.reason ?? (ineligible ? "ineligible-source" : "insufficient-pair-quality") };
}

export interface AlignedPair {
  rows: { timestampMs: number; a: number; b: number }[];
  mode: QualityMode;
  expected: number;
  coverage: number;
  eligible: boolean;
}

export interface CalibrationAlignmentCache {
  possible: Map<string, string[]>;
  returns: Map<string, Map<string, ReturnRecord>>;
}

const pairName = (left: string, right: string): string => left < right ? `${left}:${right}` : `${right}:${left}`;
function incompatibleFallbacks(matrix: number[][], order: string[], pairs: CorrelationArtifact["quality"]["pairEligibility"]): Set<string> {
  const status = new Map(pairs.map((pair) => [pairName(...pair.pair), pair.status]));
  const result = new Set<string>();
  for (let first = 0; first < order.length; first++) for (let second = first + 1; second < order.length; second++) for (let third = second + 1; third < order.length; third++) {
    const edges = [[first, second], [first, third], [second, third]] as const;
    const kinds = edges.map(([left, right]) => status.get(pairName(order[left], order[right]))!);
    if (kinds.includes("quarantined") || !kinds.includes("direct") || !kinds.includes("fallback")) continue;
    const ab = matrix[first][second];
    const ac = matrix[first][third];
    const bc = matrix[second][third];
    if (1 + 2 * ab * ac * bc - ab * ab - ac * ac - bc * bc >= -MIXED_TRIANGLE_TOLERANCE) continue;
    edges.forEach(([left, right], index) => {
      if (kinds[index] === "fallback") result.add(pairName(order[left], order[right]));
    });
  }
  return result;
}

const candleKey = (candle: CandleRecord): string => `${candle.sourceNetwork}:${candle.sourceCoin}:${candle.interval}:${candle.openTimeMs}`;
function verifiedReturns(input: CalibrationInput, storage: ResearchPersistence): { manifest: DerivedManifestV2; rows: ReturnRecord[] } {
  const parsed = readDerivedDataset(input.root, input.derivedManifestPath, storage);
  const dataManifestSha256 = sha256(canonicalJson(input.manifest));
  if (parsed.manifest.dataManifestSha256 !== dataManifestSha256 || parsed.manifest.sourceRegistrySha256 !== input.manifest.sourceRegistrySha256) throw new Error("derived manifest identity mismatch");
  const window = parsed.manifest.window;
  if (!window || !Number.isSafeInteger(window.asOfMs) || window.lookbackMs !== 180 * 86_400_000) throw new Error("derived manifest must use the fixed 180-day window");
  return { manifest: parsed.manifest, rows: parsed.returns };
}

function possibleKeys(source: SourceEntry, window: Window, mode: QualityMode): string[] {
  if (mode === "daily") {
    if (source.calendar === "continuous") return [...new Set(expectedIntervals(source, window).map((timestamp) => new Date(timestamp).toISOString().slice(0, 10)))].slice(1);
    return sessionDates(window, source).slice(1);
  }
  const intervals = expectedIntervals(source, window);
  const keys: string[] = [];
  for (let index = 1; index < intervals.length; index++) if (intervals[index] - intervals[index - 1] === HOUR) keys.push(String(intervals[index]));
  return keys;
}

export function calibrationPairSample(records: ReturnRecord[], left: SourceEntry, right: SourceEntry, window: Window, cache?: CalibrationAlignmentCache): AlignedPair {
  const mode = returnModeFor(left, right);
  const interval = mode;
  const fromMs = window.asOfMs - window.lookbackMs;
  const own = (source: SourceEntry) => {
    const key = `${source.underlying}:${interval}:${fromMs}:${window.asOfMs}`;
    const existing = cache?.returns.get(key);
    if (existing) return existing;
    const built = new Map(records.filter((row) => row.underlying === source.underlying && row.interval === interval && row.timestampMs >= fromMs && row.timestampMs <= window.asOfMs).map((row) => [mode === "hourly" ? String(row.timestampMs) : row.sessionDate, row]));
    cache?.returns.set(key, built);
    return built;
  };
  const possibleFor = (source: SourceEntry): string[] => {
    const key = `${source.underlying}:${mode}:${fromMs}:${window.asOfMs}`;
    const existing = cache?.possible.get(key);
    if (existing) return existing;
    const built = possibleKeys(source, window, mode);
    cache?.possible.set(key, built);
    return built;
  };
  const a = own(left);
  const b = own(right);
  const rightPossible = new Set(possibleFor(right));
  const possible = possibleFor(left).filter((key) => rightPossible.has(key));
  const rows: AlignedPair["rows"] = [];
  for (const key of possible) {
    const first = a.get(key);
    const second = b.get(key);
    if (first && second) rows.push({ timestampMs: Math.max(first.timestampMs, second.timestampMs), a: first.value, b: second.value });
  }
  const result = quality(rows.length, possible.length, mode);
  return { rows, mode, expected: possible.length, coverage: result.coverage, eligible: result.eligible };
}

function unweighted(rows: AlignedPair["rows"]): number | null {
  if (rows.length < 2) return null;
  const meanA = rows.reduce((sum, row) => sum + row.a, 0) / rows.length;
  const meanB = rows.reduce((sum, row) => sum + row.b, 0) / rows.length;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (const row of rows) {
    const a = row.a - meanA;
    const b = row.b - meanB;
    covariance += a * b;
    varianceA += a * a;
    varianceB += b * b;
  }
  const denominator = Math.sqrt(varianceA * varianceB);
  const result = denominator > 0 ? covariance / denominator : Number.NaN;
  return Number.isFinite(result) ? Math.max(-1, Math.min(1, result)) : null;
}

function usableCandles(candles: CandleRecord[], source: SourceEntry, window: Window): CandleRecord[] {
  const own = candles.filter((candle) => candle.underlying === source.underlying && candle.sourceNetwork === source.sourceNetwork && candle.sourceCoin === source.sourceCoin && candle.interval === "1h").sort((a, b) => a.openTimeMs - b.openTimeMs);
  const fromMs = window.asOfMs - window.lookbackMs;
  return own.filter((candle, index) => candle.openTimeMs >= fromMs && candle.openTimeMs <= window.asOfMs && Number.isFinite(Number(candle.close)) && Number(candle.close) > 0 && classifyCandle(candle, source, own[index - 1]) === "active");
}

function calibrateImpl(input: CalibrationInput, storage: ResearchPersistence): CorrelationArtifact {
  assertLoadedResearchNetworkProfile(input.profile);
  verifyManifest(input.root, input.manifest, storage);
  const dataManifestSha256 = sha256(canonicalJson(input.manifest));
  const sources = readSourceRegistryFact(input.root, input.manifest.sourceRegistrySha256, storage).registry.sources.sort((a, b) => lexical(a.underlying, b.underlying));
  if (input.profile.sourceRegistrySha256 !== input.manifest.sourceRegistrySha256 || sha256(canonicalJson(input.profile.sources)) !== input.manifest.sourceRegistrySha256) throw new Error("calibration profile source registry identity mismatch");
  const derived = verifiedReturns(input, storage);
  if (derived.manifest.network !== sources[0]?.sourceNetwork || sources.some((source) => source.sourceNetwork !== derived.manifest.network)) throw new Error("derived manifest network mismatch");
  if (derived.rows.some((row) => !sources.some((source) => source.underlying === row.underlying))) throw new Error("derived return references unknown source");
  const candles = input.manifest.files.filter((file) => file.path.endsWith(".jsonl.gz")).flatMap((file) => readCandlePartition(storage, file.path));
  const contributing = new Set(derived.rows.flatMap((row) => row.sourceKeys));
  const usable = new Map(sources.map((source) => [source.underlying, usableCandles(candles, source, derived.manifest.window)]));
  const contributingCandles = [...usable.values()].flat().filter((candle) => contributing.has(candleKey(candle)));
  if (!contributingCandles.length) throw new Error("no usable candle contributes to the derived returns");
  const dataAsOfMs = Math.max(...derived.rows.map((row) => row.observationCloseTimeMs));
  const lastUsableObservationMs: Record<string, number | null> = Object.fromEntries(sources.map((source) => {
    const rows = derived.rows.filter((row) => row.underlying === source.underlying);
    return [source.underlying, rows.length ? Math.max(...rows.map((row) => row.observationCloseTimeMs)) : null];
  }));
  const sourceReason = new Map<string, string | null>();
  for (const source of sources) {
    if (!source.measurementEnabled) sourceReason.set(source.underlying, "ineligible-source");
    else if (!trailingFresh(source, derived.rows.filter((row) => row.underlying === source.underlying).map((row) => row.observationCloseTimeMs), derived.manifest.window.asOfMs)) sourceReason.set(source.underlying, "trailing-source-stale");
    else sourceReason.set(source.underlying, null);
  }

  const aligned = new Map<string, AlignedPair>();
  const directEstimates: PairEstimate[] = [];
  for (let left = 0; left < sources.length; left++) for (let right = left + 1; right < sources.length; right++) {
    const a = sources[left];
    const b = sources[right];
    const key = pairName(a.underlying, b.underlying);
    const sample = calibrationPairSample(derived.rows, a, b, derived.manifest.window);
    aligned.set(key, sample);
    if (sample.rows.length >= 2) {
      try {
        const estimate = weightedCorrelation(sample.rows, 45, derived.manifest.window.asOfMs);
        directEstimates.push({ pair: [a.underlying, b.underlying], ...estimate, eligible: sample.eligible && sourceReason.get(a.underlying) === null && sourceReason.get(b.underlying) === null });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "weighted correlation requires non-constant series") throw error;
      }
    }
  }
  const targets = structuredTargets(directEstimates, sources);
  const estimateByPair = new Map(directEstimates.map((estimate) => [pairName(...estimate.pair), estimate]));
  const pairEligibility: CorrelationArtifact["quality"]["pairEligibility"] = [];
  const baseTarget: number[][] = Array.from({ length: sources.length }, (_, row) => Array.from({ length: sources.length }, (_, column) => row === column ? 1 : 0));
  const preliminary = new Map<string, { mode: QualityMode; observations: number; expected: number; coverage: number; effectiveN: number | null; raw: number | null; shrinkTarget: number; shrinkLambda: number; fallbackUsed: boolean }>();
  const admitted = new Set<string>();
  for (let left = 0; left < sources.length; left++) for (let right = left + 1; right < sources.length; right++) {
    const a = sources[left];
    const b = sources[right];
    const key = pairName(a.underlying, b.underlying);
    const sample = aligned.get(key)!;
    const estimate = estimateByPair.get(key);
    const shrinkTarget = a.cluster === b.cluster ? targets.clusters[a.cluster] : targets.global;
    const ownReason = sourceReason.get(a.underlying) ?? sourceReason.get(b.underlying);
    let status: "direct" | "fallback" | "quarantined";
    let reason: string;
    let value = 0;
    const lambda = 0;
    let fallbackUsed = false;
    const directCorrelation = estimate?.eligible ? estimate.correlation : null;
    const admission = admitPair(a, b, { network: derived.manifest.network, eligible: estimate?.eligible === true, correlation: directCorrelation, reason: ownReason ?? "insufficient-pair-quality" }, input.profile);
    // A rail correlation or an effective sample at or below 3 has no Fisher interval, so it cannot be direct evidence.
    const decision: PairAdmission = admission.kind === "direct" && (!(estimate!.effectiveN > 3) || Math.abs(admission.correlation) >= 1) ? { kind: "quarantined", reason: "insufficient-effective-sample" } : admission;
    status = decision.kind === "quarantined" ? "quarantined" : decision.kind;
    reason = decision.reason;
    if (decision.kind !== "quarantined") {
      value = decision.correlation;
      fallbackUsed = decision.kind === "fallback";
      admitted.add(key);
    }
    baseTarget[left][right] = baseTarget[right][left] = value;
    pairEligibility.push({ pair: [a.underlying, b.underlying], status, reason });
    preliminary.set(key, { mode: sample.mode, observations: sample.rows.length, expected: sample.expected, coverage: sample.coverage, effectiveN: estimate?.effectiveN ?? null, raw: estimate?.correlation ?? null, shrinkTarget, shrinkLambda: lambda, fallbackUsed });
  }
  const incompatible = incompatibleFallbacks(baseTarget, sources.map((source) => source.underlying), pairEligibility);
  for (const pair of pairEligibility) {
    const key = pairName(...pair.pair);
    if (!incompatible.has(key)) continue;
    pair.status = "quarantined";
    pair.reason = "structurally-incompatible-fallback";
    const left = sources.findIndex((source) => source.underlying === pair.pair[0]);
    const right = sources.findIndex((source) => source.underlying === pair.pair[1]);
    baseTarget[left][right] = baseTarget[right][left] = 0;
    admitted.delete(key);
    preliminary.set(key, { ...preliminary.get(key)!, fallbackUsed: false });
  }
  const indexOf = (underlying: string): number => sources.findIndex((source) => source.underlying === underlying);
  const evidence: FitEvidenceInput[] = pairEligibility.map(({ pair, status, reason }) => {
    const data = preliminary.get(pairName(...pair))!;
    const target = baseTarget[indexOf(pair[0])][indexOf(pair[1])];
    if (status === "direct") return { evidence: "direct", pair, mode: data.mode, target, effectiveN: data.effectiveN! };
    if (status === "fallback") return { evidence: "fallback", pair, target };
    return { evidence: "quarantined", pair, reason };
  });
  const fitted = fitSignedFactors(sources, evidence);
  if (canonicalJson(fitSignedFactors(sources, evidence)) !== canonicalJson(fitted)) throw new Error("signed factor fit is not deterministic");
  const failedDirect = fitted.pairEvidence.filter((record) => record.evidence === "direct" && !record.gate.passed);
  if (failedDirect.length) throw new Error(`direct pair gate failed: ${failedDirect.map((record) => `${record.pair.join(":")} ${record.gate.reason}`).join(", ")}`);
  for (const record of fitted.pairEvidence) {
    const key = pairName(...record.pair);
    const entry = pairEligibility.find((pair) => pairName(...pair.pair) === key)!;
    if (record.evidence !== "quarantined" || entry.status === "quarantined") continue;
    entry.status = "quarantined";
    entry.reason = record.gate.reason;
    baseTarget[indexOf(record.pair[0])][indexOf(record.pair[1])] = baseTarget[indexOf(record.pair[1])][indexOf(record.pair[0])] = 0;
    admitted.delete(key);
    preliminary.set(key, { ...preliminary.get(key)!, fallbackUsed: false });
  }
  const admittedCount = new Map(sources.map((source) => [source.underlying, pairEligibility.filter((pair) => pair.status !== "quarantined" && pair.pair.includes(source.underlying)).length]));
  const quarantinedUnderlyings = sources.flatMap((source) => {
    const reason = admittedCount.get(source.underlying) === 0 ? sourceReason.get(source.underlying) ?? "no-admissible-pair" : null;
    return reason ? [{ underlying: source.underlying, reason }] : [];
  });
  const eligibleUnderlyings = sources.map((source) => source.underlying).filter((underlying) => !quarantinedUnderlyings.some((entry) => entry.underlying === underlying));
  // Higham projection of the admitted targets stays a diagnostic (maxProjectionError gate); the runtime model is the fitter's R = BB^T + D.
  const projection = nearestCorrelationResult(baseTarget);
  let maxProjectionError = 0;
  for (let row = 0; row < sources.length; row++) for (let column = 0; column < sources.length; column++) maxProjectionError = Math.max(maxProjectionError, Math.abs(projection.matrix[row][column] - baseTarget[row][column]));
  const clusters: CorrelationArtifact["clusters"] = {};
  for (const [cluster, entries] of Object.entries(fitted.loadings)) {
    const included = Object.fromEntries(Object.entries(entries).filter(([underlying]) => eligibleUnderlyings.includes(underlying)));
    if (Object.keys(included).length) clusters[cluster] = included;
  }
  const pairDiagnostics: CorrelationArtifact["quality"]["pairDiagnostics"] = pairEligibility.map(({ pair }) => {
    const left = indexOf(pair[0]);
    const right = indexOf(pair[1]);
    const data = preliminary.get(pairName(...pair))!;
    const target = baseTarget[left][right];
    const implied = fitted.matrix[left][right];
    return { pair, ...data, mode: data.mode, target, implied, residual: implied - target };
  });
  const diagnosticMatrices = Object.fromEntries(([30, 90, 180] as const).map((days) => {
    const window = { asOfMs: derived.manifest.window.asOfMs, lookbackMs: days * 86_400_000 };
    const matrix: (number | null)[][] = sources.map((source, row) => sources.map((_, column) => row === column ? (derived.rows.some((record) => record.underlying === source.underlying && record.timestampMs >= window.asOfMs - window.lookbackMs && record.timestampMs <= window.asOfMs) ? 1 : null) : null));
    for (let left = 0; left < sources.length; left++) for (let right = left + 1; right < sources.length; right++) matrix[left][right] = matrix[right][left] = unweighted(calibrationPairSample(derived.rows, sources[left], sources[right], window).rows);
    return [String(days), matrix];
  })) as CorrelationArtifact["quality"]["diagnosticMatrices"];
  const dataAsOf = new Date(dataAsOfMs).toISOString();
  const modelVersion = `${dataAsOf.slice(0, 10)}.${dataManifestSha256.slice(0, 8)}`;
  const directPairs = pairEligibility.flatMap(({ pair, status, reason }) => status === "direct" ? [{ pair, correlation: baseTarget[indexOf(pair[0])][indexOf(pair[1])], reason: reason as "testnet-quality-passed" }] : []);
  const fallbackPairs = pairEligibility.flatMap(({ pair, status, reason }) => status === "fallback" ? [{ pair, correlation: baseTarget[indexOf(pair[0])][indexOf(pair[1])], reason: reason as "operator-reviewed-testnet-bootstrap" }] : []);
  const quarantinedPairs = pairEligibility.flatMap(({ pair, status, reason }) => status === "quarantined" ? [{ pair, reason }] : []);
  const artifact: CorrelationArtifact = {
    schemaVersion: 3, network: input.profile.profile.network, profileSha256: input.profile.profileSha256,
    modelVersion, modelFamily: "signed-asset-factor", createdAt: input.manifest.createdAt, dataAsOf,
    dataManifestSha256, sourceRegistrySha256: input.manifest.sourceRegistrySha256, marketRegistrySha256: input.profile.marketRegistrySha256,
    deploymentRegistrySha256: input.profile.deploymentRegistrySha256, baselineCorrelationSha256: input.profile.baselineCorrelationSha256,
    directPairs, fallbackPairs, quarantinedPairs,
    policy: { ...APPROVED_FIT_POLICY },
    quality: {
      matrixOrder: sources.map((source) => source.underlying), eligibleUnderlyings, quarantinedUnderlyings, pairEligibility,
      lastUsableObservationMs, pairDiagnostics, maxProjectionError, highamProjectionDelta: projection.delta,
      clippedNegativePairs: [],
      signedPsdTarget: projection.matrix, diagnosticMatrices,
    },
    validation: { status: "pending" }, clusters, pairEvidence: fitted.pairEvidence,
  };
  const bytes = `${canonicalJson(artifact)}\n`;
  if (sha256(input.profile.marketRegistryRaw) !== artifact.marketRegistrySha256) throw new Error("loaded profile market registry hash differs");
  recordMarketRegistryFact(storage, input.profile.marketRegistryRaw);
  const candidate = `artifacts/candidates/${modelVersion}.json`;
  if (storage.exists(candidate)) {
    if (storage.readText(candidate) !== bytes) throw new Error("candidate already exists with different bytes");
  } else if (!storage.writeNew(candidate, bytes) && storage.readText(candidate) !== bytes) throw new Error("candidate already exists with different bytes");
  return artifact;
}

export function calibrate(input: CalibrationInput): CorrelationArtifact {
  const storage = input.storage ?? openResearchPersistence(input.root);
  bindResearchRootIdentity(storage, input.profile);
  const now = input.now ?? Date.now;
  const started = now();
  const persist = (status: "running" | "succeeded" | "failed", error: string | null, details: Record<string, string | number | boolean | null> = {}): void => {
    const at = status === "running" ? started : now();
    writeOperationState(input.root, "calibrator.json", { schemaVersion: 1, operation: "calibrator", status, startedAt: new Date(started).toISOString(), endedAt: status === "running" ? null : new Date(at).toISOString(), error, details }, storage);
  };
  persist("running", null);
  try {
    const artifact = calibrateImpl(input, storage);
    persist("succeeded", null, { modelVersion: artifact.modelVersion, dataManifestSha256: artifact.dataManifestSha256 });
    return artifact;
  } catch (error) {
    persist("failed", operationError(error));
    throw error;
  }
}
