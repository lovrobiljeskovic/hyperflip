import { gunzipSync } from "node:zlib";
import { openResearchPersistence, type ResearchPersistence } from "./persistence.js";
import { expectedIntervals, HOUR, quality, sessionDates, trailingFresh, TRANSFORMATION_VERSION, classifyCandle } from "./returns.js";
import type { QualityMode, ReturnRecord, Window } from "./returns.js";
import { nearestCorrelationResult, shrinkLambda, structuredTargets, weightedCorrelation } from "./matrix.js";
import type { PairEstimate } from "./matrix.js";
import { canonicalJson, operationError, readCandlePartition, readSourceRegistryFact, researchRelativePath, sha256, verifyManifest, writeOperationState } from "./store.js";
import { assertExclusionRecord } from "./types.js";
import type { CandleRecord, CorrelationArtifact, DataManifest, ExclusionRecord, SourceEntry } from "./types.js";

const MAX_LOADING = Math.sqrt(0.99);
const lexical = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export interface CalibrationInput {
  root: string;
  manifest: DataManifest;
  derivedManifestPath: string;
  now?: () => number;
  storage?: ResearchPersistence;
}

export interface FactorFit {
  global: number;
  clusters: Record<string, number>;
  loadings: CorrelationArtifact["clusters"];
  implied: number[][];
  objective: number;
}

interface PairTarget { left: number; right: number; target: number }

function grid(lower: number, upper: number, step: number, current?: number): number[] {
  const values: number[] = [];
  for (let value = lower; value <= upper + 1e-15; value += step) values.push(Math.min(upper, value));
  values.push(upper);
  if (current !== undefined) values.push(current);
  return [...new Set(values)].sort((a, b) => a - b);
}

function fit(target: number[][], sources: SourceEntry[], admitted?: Set<string>): FactorFit {
  if (target.length !== sources.length || target.some((row) => row.length !== sources.length)) throw new Error("target matrix and sources must have matching dimensions");
  const indexed = sources.map((source, index) => ({ source, index })).sort((a, b) => lexical(a.source.underlying, b.source.underlying));
  const sorted = indexed.map(({ source }) => source);
  const pairs: PairTarget[] = [];
  for (let left = 0; left < sorted.length; left++) for (let right = left + 1; right < sorted.length; right++) {
    const pair = `${sorted[left].underlying}:${sorted[right].underlying}`;
    const value = target[indexed[left].index][indexed[right].index];
    if (Number.isFinite(value) && (!admitted || admitted.has(pair))) pairs.push({ left, right, target: Math.max(0, value) });
  }
  const clusterNames = [...new Set(sorted.map((source) => source.cluster))].sort();
  const values: Record<string, number> = Object.fromEntries(["global", ...clusterNames].map((name) => [name, 0]));
  const objective = (): number => pairs.reduce((sum, pair) => {
    const sameCluster = sorted[pair.left].cluster === sorted[pair.right].cluster;
    const implied = values.global ** 2 + (sameCluster ? values[sorted[pair.left].cluster] ** 2 : 0);
    return sum + (implied - pair.target) ** 2;
  }, 0);
  const optimize = (candidates: (name: string) => number[]): void => {
    for (let sweep = 0; sweep < 1_000; sweep++) {
      let changed = false;
      for (const name of ["global", ...clusterNames]) {
        const prior = values[name];
        let best = prior;
        let bestObjective = Number.POSITIVE_INFINITY;
        for (const candidate of candidates(name)) {
          if (name === "global" ? clusterNames.some((cluster) => candidate ** 2 + values[cluster] ** 2 > 0.99) : candidate ** 2 + values.global ** 2 > 0.99) continue;
          values[name] = candidate;
          const score = objective();
          if (score < bestObjective - 1e-15 || (Math.abs(score - bestObjective) <= 1e-15 && candidate < best)) {
            best = candidate;
            bestObjective = score;
          }
        }
        values[name] = best;
        changed ||= best !== prior;
      }
      if (!changed) return;
    }
    throw new Error("hierarchical coordinate descent did not converge after 1000 sweeps");
  };
  optimize(() => grid(0, MAX_LOADING, 0.01));
  const coarse = { ...values };
  optimize((name) => grid(Math.max(0, coarse[name] - 0.01), Math.min(MAX_LOADING, coarse[name] + 0.01), 0.001, values[name]));
  const loadings: CorrelationArtifact["clusters"] = {};
  for (const source of sorted) {
    const global = values.global;
    const cluster = values[source.cluster];
    (loadings[source.cluster] ??= {})[source.underlying] = {
      global,
      cluster,
      underlying: Math.sqrt(Math.max(0, 0.99 - global ** 2 - cluster ** 2)),
      underlyingBasis: "structural-underlying",
    };
  }
  const implied = sorted.map((left, row) => sorted.map((right, column) => row === column ? 1 : values.global ** 2 + (left.cluster === right.cluster ? values[left.cluster] ** 2 : 0)));
  return { global: values.global, clusters: Object.fromEntries(clusterNames.map((name) => [name, values[name]])), loadings, implied, objective: objective() };
}

export function fitHierarchical(target: number[][], sources: SourceEntry[], admitted?: Set<string>): FactorFit { return fit(target, sources, admitted); }

interface DerivedManifest {
  schemaVersion: 1;
  transformationVersion: typeof TRANSFORMATION_VERSION;
  dataManifestSha256: string;
  sourceRegistrySha256: string;
  window: Window;
  files: { kind: "returns" | "exclusions"; path: string; bytes: number; sha256: string; rows: number; schemaVersion: 1 }[];
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
const candleKey = (candle: CandleRecord): string => `${candle.sourceNetwork}:${candle.sourceCoin}:${candle.interval}:${candle.openTimeMs}`;
function verifiedReturns(input: CalibrationInput, storage: ResearchPersistence): { manifest: DerivedManifest; rows: ReturnRecord[] } {
  const manifestPath = researchRelativePath(input.root, input.derivedManifestPath);
  const parsed = JSON.parse(storage.readText(manifestPath)) as Partial<DerivedManifest>;
  const dataManifestSha256 = sha256(canonicalJson(input.manifest));
  if (parsed.schemaVersion !== 1 || parsed.transformationVersion !== TRANSFORMATION_VERSION || parsed.dataManifestSha256 !== dataManifestSha256 || parsed.sourceRegistrySha256 !== input.manifest.sourceRegistrySha256) throw new Error("derived manifest identity mismatch");
  const window = parsed.window;
  if (!window || !Number.isSafeInteger(window.asOfMs) || window.lookbackMs !== 180 * 86_400_000) throw new Error("derived manifest must use the fixed 180-day window");
  if (!Array.isArray(parsed.files) || !parsed.files.length) throw new Error("derived manifest has no files");
  const rows: ReturnRecord[] = [];
  for (const file of parsed.files) {
    const path = researchRelativePath(input.root, file.path);
    if (file.schemaVersion !== 1 || !file.path.endsWith(".jsonl.gz") || !storage.exists(path)) throw new Error(`derived manifest file mismatch: ${file.path}`);
    const bytes = storage.read(path);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`derived manifest file mismatch: ${file.path}`);
    const text = gunzipSync(bytes).toString("utf8").trim();
    const fileRows = text ? text.split("\n").map((line) => JSON.parse(line) as ReturnRecord | ExclusionRecord) : [];
    if (fileRows.length !== file.rows) throw new Error(`derived manifest file mismatch: ${file.path}`);
    if (file.kind === "exclusions") {
      for (const row of fileRows as ExclusionRecord[]) assertExclusionRecord(row);
      continue;
    }
    if (file.kind !== "returns") throw new Error(`derived manifest file kind is invalid: ${file.path}`);
    for (const row of fileRows) {
      const record = row as ReturnRecord;
      if (record.schemaVersion !== 1 || record.transformationVersion !== TRANSFORMATION_VERSION || (record.interval !== "1h" && record.interval !== "1d") || !Number.isSafeInteger(record.timestampMs) || (record.observationCloseTimeMs !== undefined && (!Number.isSafeInteger(record.observationCloseTimeMs) || record.observationCloseTimeMs < record.timestampMs)) || !Number.isFinite(record.value) || typeof record.sessionDate !== "string" || !Array.isArray(record.sourceKeys) || record.sourceKeys.some((key) => typeof key !== "string")) throw new Error("invalid derived return record");
    }
    rows.push(...fileRows as ReturnRecord[]);
  }
  return { manifest: parsed as DerivedManifest, rows };
}

function possibleKeys(source: SourceEntry, window: Window, mode: QualityMode): string[] {
  if (mode === "daily-cross-session") {
    if (source.calendar === "continuous") return [...new Set(expectedIntervals(source, window).map((timestamp) => new Date(timestamp).toISOString().slice(0, 10)))].slice(1);
    return sessionDates(window, source).slice(1);
  }
  const intervals = expectedIntervals(source, window);
  const keys: string[] = [];
  for (let index = 1; index < intervals.length; index++) if (intervals[index] - intervals[index - 1] === HOUR) keys.push(String(intervals[index]));
  return keys;
}

export function calibrationPairSample(records: ReturnRecord[], left: SourceEntry, right: SourceEntry, window: Window, cache?: CalibrationAlignmentCache): AlignedPair {
  const mode: QualityMode = left.cluster === right.cluster ? "hourly-within-cluster" : "daily-cross-session";
  const interval = mode === "hourly-within-cluster" ? "1h" : "1d";
  const fromMs = window.asOfMs - window.lookbackMs;
  const own = (source: SourceEntry) => {
    const key = `${source.underlying}:${interval}:${fromMs}:${window.asOfMs}`;
    const existing = cache?.returns.get(key);
    if (existing) return existing;
    const built = new Map(records.filter((row) => row.underlying === source.underlying && row.interval === interval && row.timestampMs >= fromMs && row.timestampMs <= window.asOfMs).map((row) => [mode === "hourly-within-cluster" ? String(row.timestampMs) : row.sessionDate, row]));
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
  verifyManifest(input.root, input.manifest, storage);
  const dataManifestSha256 = sha256(canonicalJson(input.manifest));
  const sources = readSourceRegistryFact(input.root, input.manifest.sourceRegistrySha256, storage).registry.sources.sort((a, b) => lexical(a.underlying, b.underlying));
  const derived = verifiedReturns(input, storage);
  if (derived.rows.some((row) => !sources.some((source) => source.underlying === row.underlying))) throw new Error("derived return references unknown source");
  const candles = input.manifest.files.filter((file) => file.path.endsWith(".jsonl.gz")).flatMap((file) => readCandlePartition(storage, file.path));
  const contributing = new Set(derived.rows.flatMap((row) => row.sourceKeys));
  const usable = new Map(sources.map((source) => [source.underlying, usableCandles(candles, source, derived.manifest.window)]));
  const contributingCandles = [...usable.values()].flat().filter((candle) => contributing.has(candleKey(candle)));
  if (!contributingCandles.length) throw new Error("no usable candle contributes to the derived returns");
  const dataAsOfMs = Math.max(...contributingCandles.map((candle) => candle.closeTimeMs));
  const lastUsableObservationMs: Record<string, number | null> = Object.fromEntries(sources.map((source) => {
    const rows = (usable.get(source.underlying) ?? []).filter((candle) => contributing.has(candleKey(candle)));
    return [source.underlying, rows.length ? Math.max(...rows.map((candle) => candle.openTimeMs)) : null];
  }));
  const sourceReason = new Map<string, string | null>();
  for (const source of sources) {
    if (!source.measurementEnabled) sourceReason.set(source.underlying, "ineligible-source");
    else if (!trailingFresh(source, (usable.get(source.underlying) ?? []).filter((candle) => contributing.has(candleKey(candle))).map((candle) => candle.openTimeMs), derived.manifest.window.asOfMs)) sourceReason.set(source.underlying, "trailing-source-stale");
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
    let lambda = 0;
    let fallbackUsed = false;
    if (ownReason) { status = "quarantined"; reason = ownReason; }
    else if (estimate?.eligible) {
      status = "direct"; reason = "quality-gates-passed";
      lambda = shrinkLambda(estimate, shrinkTarget);
      value = (1 - lambda) * estimate.correlation + lambda * shrinkTarget;
      admitted.add(key);
    } else if (a.fallbackEligible && b.fallbackEligible) {
      status = "fallback"; reason = "operator-reviewed-structured-fallback"; value = shrinkTarget; lambda = 1; fallbackUsed = true; admitted.add(key);
    } else { status = "quarantined"; reason = "insufficient-pair-quality"; }
    baseTarget[left][right] = baseTarget[right][left] = value;
    pairEligibility.push({ pair: [a.underlying, b.underlying], status, reason });
    preliminary.set(key, { mode: sample.mode, observations: sample.rows.length, expected: sample.expected, coverage: sample.coverage, effectiveN: estimate?.effectiveN ?? null, raw: estimate?.correlation ?? null, shrinkTarget, shrinkLambda: lambda, fallbackUsed });
  }
  const admittedCount = new Map(sources.map((source) => [source.underlying, pairEligibility.filter((pair) => pair.status !== "quarantined" && pair.pair.includes(source.underlying)).length]));
  const quarantinedUnderlyings = sources.flatMap((source) => {
    const reason = sourceReason.get(source.underlying) ?? (admittedCount.get(source.underlying) === 0 ? "no-admissible-pair" : null);
    return reason ? [{ underlying: source.underlying, reason }] : [];
  });
  const eligibleUnderlyings = sources.map((source) => source.underlying).filter((underlying) => !quarantinedUnderlyings.some((entry) => entry.underlying === underlying));
  const projection = nearestCorrelationResult(baseTarget);
  let maxProjectionError = 0;
  for (let row = 0; row < sources.length; row++) for (let column = 0; column < sources.length; column++) maxProjectionError = Math.max(maxProjectionError, Math.abs(projection.matrix[row][column] - baseTarget[row][column]));
  const fitted = fit(projection.matrix, sources, admitted);
  const clusters: CorrelationArtifact["clusters"] = {};
  for (const [cluster, entries] of Object.entries(fitted.loadings)) {
    const included = Object.fromEntries(Object.entries(entries).filter(([underlying]) => eligibleUnderlyings.includes(underlying)));
    if (Object.keys(included).length) clusters[cluster] = included;
  }
  const pairDiagnostics: CorrelationArtifact["quality"]["pairDiagnostics"] = pairEligibility.map(({ pair }) => {
    const left = sources.findIndex((source) => source.underlying === pair[0]);
    const right = sources.findIndex((source) => source.underlying === pair[1]);
    const data = preliminary.get(pairName(...pair))!;
    const target = projection.matrix[left][right];
    const implied = fitted.implied[left][right];
    return { pair, ...data, mode: data.mode, target, implied, residual: Math.max(0, target) - implied };
  });
  const diagnosticMatrices = Object.fromEntries(([30, 90, 180] as const).map((days) => {
    const window = { asOfMs: derived.manifest.window.asOfMs, lookbackMs: days * 86_400_000 };
    const matrix: (number | null)[][] = sources.map((source, row) => sources.map((_, column) => row === column ? (derived.rows.some((record) => record.underlying === source.underlying && record.timestampMs >= window.asOfMs - window.lookbackMs && record.timestampMs <= window.asOfMs) ? 1 : null) : null));
    for (let left = 0; left < sources.length; left++) for (let right = left + 1; right < sources.length; right++) matrix[left][right] = matrix[right][left] = unweighted(calibrationPairSample(derived.rows, sources[left], sources[right], window).rows);
    return [String(days), matrix];
  })) as CorrelationArtifact["quality"]["diagnosticMatrices"];
  const dataAsOf = new Date(dataAsOfMs).toISOString();
  const modelVersion = `${dataAsOf.slice(0, 10)}.${dataManifestSha256.slice(0, 8)}`;
  const artifact: CorrelationArtifact = {
    schemaVersion: 1, modelVersion, modelFamily: "hierarchical-gaussian-factor", createdAt: input.manifest.createdAt, dataAsOf,
    dataManifestSha256, sourceRegistrySha256: input.manifest.sourceRegistrySha256,
    policy: { lookbackDays: 180, halfLifeDays: 45, diagnosticWindowsDays: [30, 90, 180], minHourly: 1000, minDaily: 90, minCoverage: 0.8, maxProjectionError: 0.10 },
    quality: {
      matrixOrder: sources.map((source) => source.underlying), eligibleUnderlyings, quarantinedUnderlyings, pairEligibility,
      lastUsableObservationMs, pairDiagnostics, maxProjectionError, highamProjectionDelta: projection.delta,
      clippedNegativePairs: pairEligibility.flatMap(({ pair }) => {
        const left = sources.findIndex((source) => source.underlying === pair[0]);
        const right = sources.findIndex((source) => source.underlying === pair[1]);
        return baseTarget[left][right] < 0 ? [{ pair, target: baseTarget[left][right] }] : [];
      }),
      signedPsdTarget: projection.matrix, diagnosticMatrices,
    },
    validation: { status: "pending" }, clusters,
  };
  const bytes = `${canonicalJson(artifact)}\n`;
  const candidate = `artifacts/candidates/${modelVersion}.json`;
  if (storage.exists(candidate)) {
    if (storage.readText(candidate) !== bytes) throw new Error("candidate already exists with different bytes");
  } else if (!storage.writeNew(candidate, bytes) && storage.readText(candidate) !== bytes) throw new Error("candidate already exists with different bytes");
  return artifact;
}

export function calibrate(input: CalibrationInput): CorrelationArtifact {
  const storage = input.storage ?? openResearchPersistence(input.root);
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
