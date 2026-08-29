import { createHash, hash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { jointProbWad, parseCorrelations, type CorrLeg, type CorrelationTable } from "../correlation.js";
import { calibrationPairSample, fitHierarchical, type CalibrationAlignmentCache } from "./calibration.js";
import { cholesky, nearestCorrelation, shrinkPair, structuredTargets, weightedCorrelation, type PairEstimate } from "./matrix.js";
import { trailingFresh, type ReturnRecord } from "./returns.js";
import { atomicWriteNew, canonicalJson, readSourceRegistryFact, sha256 } from "./store.js";
import type { CorrelationArtifact, SourceEntry } from "./types.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const WAD = 10n ** 18n;
const HORIZONS = [24, 48, 72, 96] as const;
const QUANTILES = [0.25, 0.5, 0.75] as const;
const DFS = [4, 6, 8, 12, 20, 30] as const;
const MODELS = ["independence", "static-hierarchical-gaussian", "measured-hierarchical-gaussian", "signed-t-copula", "filtered-historical-simulation"] as const;
const STRESS_REGIMES = ["drawdown-stress", "high-volatility", "normal"] as const;
const SAFE_MODEL_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const observationTime = (row: ReturnRecord): number => row.observationCloseTimeMs ?? row.timestampMs;
const pairName = (left: string, right: string): string => left < right ? `${left}:${right}` : `${right}:${left}`;

export function loadReplaySourceRegistry(root: string, sourceRegistrySha256: string): SourceEntry[] {
  return readSourceRegistryFact(root, sourceRegistrySha256).registry.sources;
}

export type Direction = "up" | "down";
export type TicketStratum = "same-underlying" | "same-cluster" | "cross-cluster";
export type ModelName = typeof MODELS[number];

export interface ReplaySeries {
  rows: ReturnRecord[];
  sources: SourceEntry[];
  manifestHash: string;
}

export interface SyntheticLeg {
  underlying: string;
  cluster: SourceEntry["cluster"];
  direction: Direction;
  quantile: number;
  threshold: number;
  marginalProbability: number;
}

export interface SyntheticTicket {
  key: string;
  originMs: number;
  horizonHours: number;
  stratum: TicketStratum;
  direction: "all-up" | "alternating" | "all-down" | "band";
  legs: SyntheticLeg[];
  outcome: 0 | 1 | null;
}

export interface ProbabilityRow {
  p: number;
  y: 0 | 1;
  originMs?: number;
  direction?: string;
  [key: string]: unknown;
}

export interface CalibrationBin {
  lower: number;
  upper: number;
  rows: number;
  meanProbability: number | null;
  observedRate: number | null;
}

export interface ScoreSummary {
  rows: number;
  eligibleRows: number;
  logLoss: number;
  brier: number;
  calibration: CalibrationBin[];
  sharpness: number;
  exclusions: { reason: "band-market"; rows: number }[];
}

export interface BootstrapOrigin {
  originMs: number;
  baselineLosses: number[];
  measuredLosses: number[];
}

export interface Interval {
  point: number;
  lower: number;
  upper: number;
  groups: number[][];
  samples: number;
  blockHours: number;
}

export interface ReplayInput {
  root: string;
  candidate: CorrelationArtifact;
  candidateBytes?: string;
  inputManifestSha256: string;
  baselineFile: string;
  series: ReplaySeries;
  seed: string;
}

export interface ValidationReport {
  schemaVersion: 1;
  modelVersion: string;
  candidateSha256: string;
  inputManifestSha256: string;
  baselineSha256: string;
  baselineSnapshotPath: string;
  seed: string;
  drawCount: number;
  originStrideHours: 24;
  policy: { maxProjectionError: 0.10; bootstrapBlockHours: 96; bootstrapSamples: 2_000 };
  ticketCounts: Record<string, number>;
  selectedTicketKeys: string[];
  modelScores: Record<ModelName, ModelScore>;
  bootstrap: Interval;
  stressThresholds: StressThreshold[];
  degreeOfFreedomSelections: { originMs: number; df: number }[];
  exclusions: ReplayExclusion[];
  decision: "Supported" | "Inconclusive" | "Rejected";
  deterministicRerunMatches: boolean;
  resourcePolicy: { maxWallClockMs: 30_000; maxPeakRssBytes: 536_870_912 };
  limitations: string[];
}

interface ForecastRow extends ProbabilityRow {
  originMs: number;
  model: ModelName;
  window: "180d";
  horizon: string;
  ticketSize: string;
  clusterCombination: string;
  direction: string;
  stressRegime: StressRegime;
}

interface ModelScore {
  overall: ScoreSummary;
  byWindow: Record<string, ScoreSummary>;
  byHorizon: Record<string, ScoreSummary>;
  byTicketSize: Record<string, ScoreSummary>;
  byClusterCombination: Record<string, ScoreSummary>;
  byDirection: Record<string, ScoreSummary>;
  byStressRegime: Record<string, ScoreSummary & { gateEligible: boolean; exclusionReason: "insufficient-stress-sample" | null }>;
}

export type StressRegime = "drawdown-stress" | "high-volatility" | "normal";
export interface StressThreshold { originMs: number; ticketKey: string; upperVolatilityTercile: number; drawdownFifthPercentile: number; regime: StressRegime }
interface ReplayExclusion { originMs: number | null; ticketKey: string | null; model: ModelName | null; reason: "structurally-unavailable" | "insufficient-sample" | "non-finite-probability" | "band-market"; stratum?: TicketStratum; legCount?: number }

const clampProbability = (probability: number): number => Math.min(1 - 1e-6, Math.max(1e-6, probability));
const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

export function logLoss(rows: Pick<ProbabilityRow, "p" | "y">[]): number {
  if (!rows.length) return 0;
  return mean(rows.map(({ p, y }) => {
    const probability = clampProbability(p);
    return -(y * Math.log(probability) + (1 - y) * Math.log(1 - probability));
  }));
}

export function brier(rows: Pick<ProbabilityRow, "p" | "y">[]): number {
  return rows.length ? mean(rows.map(({ p, y }) => (p - y) ** 2)) : 0;
}

export function scoreForecasts(rows: ProbabilityRow[]): ScoreSummary {
  const eligible = rows.filter((row) => row.direction !== "band");
  const averageProbability = eligible.length ? mean(eligible.map((row) => row.p)) : 0;
  const calibration = Array.from({ length: 10 }, (_, index): CalibrationBin => {
    const selected = eligible.filter((row) => Math.min(9, Math.floor(clampProbability(row.p) * 10)) === index);
    return {
      lower: index / 10,
      upper: (index + 1) / 10,
      rows: selected.length,
      meanProbability: selected.length ? mean(selected.map((row) => row.p)) : null,
      observedRate: selected.length ? mean(selected.map((row) => row.y)) : null,
    };
  });
  const bandRows = rows.length - eligible.length;
  return {
    rows: rows.length,
    eligibleRows: eligible.length,
    logLoss: logLoss(eligible),
    brier: brier(eligible),
    calibration,
    sharpness: eligible.length ? mean(eligible.map((row) => (row.p - averageProbability) ** 2)) : 0,
    exclusions: bandRows ? [{ reason: "band-market", rows: bandRows }] : [],
  };
}

function logGamma(value: number): number {
  const coefficients = [676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  let x = 0.9999999999998099;
  const z = value - 1;
  for (let index = 0; index < coefficients.length; index++) x += coefficients[index] / (z + index + 1);
  const t = z + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function betaFraction(x: number, a: number, b: number): number {
  const maxIterations = 300;
  const epsilon = 3e-14;
  const floor = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < floor) d = floor;
  d = 1 / d;
  let result = d;
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const twice = 2 * iteration;
    let numerator = (iteration * (b - iteration) * x) / ((a + twice - 1) * (a + twice));
    d = 1 + numerator * d;
    if (Math.abs(d) < floor) d = floor;
    c = 1 + numerator / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    result *= d * c;
    numerator = -((a + iteration) * (a + b + iteration) * x) / ((a + twice) * (a + twice + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < floor) d = floor;
    c = 1 + numerator / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) <= epsilon) return result;
  }
  throw new Error("incomplete beta did not converge");
}

function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const factor = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  return x < (a + 1) / (a + b + 2) ? (factor * betaFraction(x, a, b)) / a : 1 - (factor * betaFraction(1 - x, b, a)) / b;
}

export function studentTCdf(x: number, df: number): number {
  if (!Number.isFinite(x) || !Number.isInteger(df) || df <= 0) {
    if (x === Number.POSITIVE_INFINITY) return 1;
    if (x === Number.NEGATIVE_INFINITY) return 0;
    throw new Error("student t CDF requires a finite x and positive integer df");
  }
  if (x === 0) return 0.5;
  const tail = 0.5 * regularizedBeta(df / (df + x * x), df / 2, 0.5);
  return x > 0 ? 1 - tail : tail;
}

export function studentTInv(probability: number, df: number): number {
  if (!(probability > 0 && probability < 1) || !Number.isInteger(df) || df <= 0) throw new Error("student t inverse requires p in (0,1) and positive integer df");
  if (probability === 0.5) return 0;
  if (probability < 0.5) return -studentTInv(1 - probability, df);
  let lower = 0;
  let upper = 1;
  while (studentTCdf(upper, df) < probability && upper < 1e12) upper *= 2;
  for (let iteration = 0; iteration < 200; iteration++) {
    const middle = (lower + upper) / 2;
    if (studentTCdf(middle, df) < probability) lower = middle;
    else upper = middle;
  }
  return (lower + upper) / 2;
}

function seeded(seed: string): () => number {
  let state = Number.parseInt(sha256(seed).slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function normal(random: () => number): number {
  const first = Math.max(Number.MIN_VALUE, random());
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * random());
}

function tDraws(matrix: number[][], df: number, draws: number, seed: string): number[][] {
  if (!Number.isInteger(draws) || draws <= 0) throw new Error("draw count must be a positive integer");
  const lower = cholesky(matrix);
  const random = seeded(seed);
  return Array.from({ length: draws }, () => {
    const independent = matrix.map(() => normal(random));
    const correlated = matrix.map((_, row) => lower[row].reduce((sum, loading, column) => sum + loading * independent[column], 0));
    let chiSquare = 0;
    for (let index = 0; index < df; index++) chiSquare += normal(random) ** 2;
    const scale = Math.sqrt(chiSquare / df);
    return correlated.map((value) => value / scale);
  });
}

export function signedTCopula(matrix: number[][], marginals: number[], directions: Direction[], df: number, draws = 20_000, seed = "replay"): { probability: number; marginals: number[]; hits: number; draws: number } {
  if (matrix.length !== marginals.length || matrix.some((row) => row.length !== matrix.length)) throw new Error("t-copula matrix and marginals must have matching dimensions");
  const generated = tDraws(matrix, df, draws, seed);
  const thresholds = marginals.map((probability) => studentTInv(1 - Math.min(1 - 1e-12, Math.max(1e-12, probability)), df));
  const marginalHits = marginals.map(() => 0);
  let hits = 0;
  for (const draw of generated) {
    let joint = true;
    for (let leg = 0; leg < marginals.length; leg++) {
      const win = directions[leg] === "up" ? draw[leg] > thresholds[leg] : draw[leg] < -thresholds[leg];
      if (win) marginalHits[leg]++;
      else joint = false;
    }
    if (joint) hits++;
  }
  return { probability: (hits + 1) / (draws + 2), marginals: marginalHits.map((count) => count / draws), hits, draws };
}

function combinations<T>(values: T[], size: number): T[][] {
  const output: T[][] = [];
  const visit = (start: number, selected: T[]): void => {
    if (selected.length === size) { output.push(selected); return; }
    for (let index = start; index <= values.length - (size - selected.length); index++) visit(index + 1, [...selected, values[index]]);
  };
  visit(0, []);
  return output;
}

function tuples<T>(values: readonly T[], size: number): T[][] {
  return size === 0 ? [[]] : values.flatMap((value) => tuples(values, size - 1).map((tail) => [value, ...tail]));
}

function percentile(values: number[], probability: number): number {
  if (!values.length) throw new Error("percentile requires observations");
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower] + fraction * ((sorted[lower + 1] ?? sorted[lower]) - sorted[lower]);
}

function sourceFor(series: ReplaySeries, underlying: string): SourceEntry {
  const found = series.sources.find((source) => source.underlying === underlying);
  if (!found) throw new Error(`missing replay source: ${underlying}`);
  return found;
}

function intervalFor(series: ReplaySeries, underlyings: string[], strict = false): "1h" | "1d" {
  const sources = underlyings.map((underlying) => sourceFor(series, underlying));
  const hourly = sources.every((source) => source.calendar === "continuous") && new Set(sources.map((source) => source.cluster)).size === 1;
  if (!hourly) return "1d";
  if (strict) return "1h";
  return underlyings.every((underlying) => series.rows.some((row) => row.underlying === underlying && row.interval === "1h")) ? "1h" : "1d";
}

function cumulativeSamples(rows: ReturnRecord[], underlying: string, interval: "1h" | "1d", horizonHours: number, originMs: number): number[] {
  const size = interval === "1h" ? horizonHours : horizonHours / 24;
  const own = rows.filter((row) => row.underlying === underlying && row.interval === interval && observationTime(row) <= originMs).sort((left, right) => left.timestampMs - right.timestampMs);
  const samples: number[] = [];
  for (let start = 0; start + size <= own.length; start++) {
    const block = own.slice(start, start + size);
    if (interval === "1h" && block.some((row, index) => index > 0 && row.timestampMs - block[index - 1].timestampMs !== HOUR)) continue;
    samples.push(block.reduce((sum, row) => sum + row.value, 0));
  }
  return samples;
}

function futureReturn(rows: ReturnRecord[], underlying: string, interval: "1h" | "1d", horizonHours: number, originMs: number): number | null {
  const size = interval === "1h" ? horizonHours : horizonHours / 24;
  const step = interval === "1h" ? HOUR : DAY;
  const byTimestamp = new Map(rows.filter((row) => row.underlying === underlying && row.interval === interval).map((row) => [row.timestampMs, row]));
  const block = Array.from({ length: size }, (_, index) => byTimestamp.get(originMs + (index + 1) * step));
  if (block.some((row) => row === undefined)) return null;
  return (block as ReturnRecord[]).reduce((sum, row) => sum + row.value, 0);
}

function contradictory(legs: SyntheticLeg[]): boolean {
  for (const underlying of new Set(legs.map((leg) => leg.underlying))) {
    const own = legs.filter((leg) => leg.underlying === underlying);
    const lower = own.filter((leg) => leg.direction === "up").map((leg) => leg.threshold);
    const upper = own.filter((leg) => leg.direction === "down").map((leg) => leg.threshold);
    if (lower.length && upper.length && Math.max(...lower) >= Math.min(...upper)) return true;
  }
  return false;
}

export function syntheticEvents(originMs: number, series: ReplaySeries, future: ReturnRecord[], admittedPairs?: Set<string>): SyntheticTicket[] {
  if (!Number.isSafeInteger(originMs) || !/^[0-9a-f]{64}$/.test(series.manifestHash)) throw new Error("synthetic replay requires a safe origin and manifest hash");
  const sources = [...series.sources].filter((source) => source.measurementEnabled).sort((left, right) => left.underlying.localeCompare(right.underlying));
  const groups: Record<TicketStratum, SourceEntry[][]> = { "same-underlying": [], "same-cluster": [], "cross-cluster": [] };
  const admitted = (selected: SourceEntry[]): boolean => {
    const underlyings = [...new Set(selected.map((source) => source.underlying))];
    for (let left = 0; left < underlyings.length; left++) for (let right = left + 1; right < underlyings.length; right++) if (admittedPairs && !admittedPairs.has(pairName(underlyings[left], underlyings[right]))) return false;
    return true;
  };
  for (const size of [2, 3, 4]) {
    if (size <= 3) groups["same-underlying"].push(...sources.map((source) => Array.from({ length: size }, () => source)));
    for (const cluster of [...new Set(sources.map((source) => source.cluster))]) groups["same-cluster"].push(...combinations(sources.filter((source) => source.cluster === cluster), size).filter(admitted));
    groups["cross-cluster"].push(...combinations(sources, size).filter((selected) => new Set(selected.map((source) => source.cluster)).size >= 2 && admitted(selected)));
  }
  const output: SyntheticTicket[] = [];
  const legs = new Map<string, SyntheticLeg | null>();
  const cachedLeg = (source: SourceEntry, interval: "1h" | "1d", horizonHours: number, quantile: number, direction: Direction): SyntheticLeg | null => {
    const key = `${source.underlying}:${interval}:${horizonHours}:${quantile}:${direction}`;
    if (legs.has(key)) return legs.get(key)!;
    const samples = cumulativeSamples(series.rows, source.underlying, interval, horizonHours, originMs);
    const leg = samples.length < 2 ? null : (() => {
      const threshold = percentile(samples, quantile);
      const marginalProbability = samples.filter((value) => direction === "up" ? value > threshold : value < threshold).length / samples.length;
      return { underlying: source.underlying, cluster: source.cluster, direction, quantile, threshold, marginalProbability };
    })();
    legs.set(key, leg);
    return leg;
  };
  const futures = new Map<string, number | null>();
  const cachedFuture = (underlying: string, interval: "1h" | "1d", horizonHours: number): number | null => {
    const key = `${underlying}:${interval}:${horizonHours}`;
    if (!futures.has(key)) futures.set(key, futureReturn(future, underlying, interval, horizonHours, originMs));
    return futures.get(key)!;
  };
  const hourlyUnderlyings = new Set(series.rows.filter((row) => row.interval === "1h").map((row) => row.underlying));
  const intervalForAssets = (assets: SourceEntry[]): "1h" | "1d" => assets.every((source) => source.calendar === "continuous")
    && new Set(assets.map((source) => source.cluster)).size === 1
    && assets.every((source) => hourlyUnderlyings.has(source.underlying)) ? "1h" : "1d";
  const quantileVectors = new Map<string, number[][]>();
  const directionsBySize = new Map<number, Direction[][]>();
  for (const size of [2, 3, 4]) {
    quantileVectors.set(`same-underlying:${size}`, size <= 3 ? combinations([...QUANTILES], size) : []);
    quantileVectors.set(`distinct:${size}`, tuples(QUANTILES, size));
    directionsBySize.set(size, [Array.from({ length: size }, () => "up" as const), Array.from({ length: size }, (_, index) => index % 2 ? "down" as const : "up" as const), Array.from({ length: size }, () => "down" as const)]);
  }
  for (const stratum of Object.keys(groups) as TicketStratum[]) {
    type PendingTicket = Omit<SyntheticTicket, "key" | "outcome"> & { interval: "1h" | "1d" };
    const chosen: { ticketJson: string; key: string; ticket: PendingTicket }[] = [];
    const compare = (left: { ticketJson: string; key: string }, right: { ticketJson: string; key: string }): number => left.key < right.key ? -1 : left.key > right.key ? 1 : left.ticketJson < right.ticketJson ? -1 : left.ticketJson > right.ticketJson ? 1 : 0;
    const hashPrefix = `${series.manifestHash}${originMs}${stratum}`;
    const stratumJson = JSON.stringify(stratum);
    const legJson = new WeakMap<SyntheticLeg, string>();
    const canonicalLeg = (leg: SyntheticLeg): string => {
      const existing = legJson.get(leg);
      if (existing) return existing;
      const bytes = `{"cluster":${JSON.stringify(leg.cluster)},"direction":${JSON.stringify(leg.direction)},"marginalProbability":${JSON.stringify(leg.marginalProbability)},"quantile":${JSON.stringify(leg.quantile)},"threshold":${JSON.stringify(leg.threshold)},"underlying":${JSON.stringify(leg.underlying)}}`;
      legJson.set(leg, bytes);
      return bytes;
    };
    let worstIndex = 0;
    for (const assets of groups[stratum]) for (const horizonHours of HORIZONS) {
      const interval = intervalForAssets(assets);
      const quantileTuples = quantileVectors.get(`${stratum === "same-underlying" ? "same-underlying" : "distinct"}:${assets.length}`)!;
      const directionVectors = directionsBySize.get(assets.length)!;
      for (const quantiles of quantileTuples) for (let directionIndex = 0; directionIndex < directionVectors.length; directionIndex++) {
        const directions = directionVectors[directionIndex];
        const ticketLegs = assets.map((source, index) => cachedLeg(source, interval, horizonHours, quantiles[index], directions[index]));
        if (ticketLegs.some((leg) => leg === null)) continue;
        const complete = ticketLegs as SyntheticLeg[];
        if (stratum === "same-underlying" && contradictory(complete)) continue;
        const direction = directionIndex === 0 ? "all-up" as const : directionIndex === 2 ? "all-down" as const : stratum === "same-underlying" ? "band" as const : "alternating" as const;
        const ticket = {
          originMs, horizonHours, stratum, direction, legs: complete,
          interval,
        };
        const serializedLegs = complete.length === 2 ? `${canonicalLeg(complete[0])},${canonicalLeg(complete[1])}`
          : complete.length === 3 ? `${canonicalLeg(complete[0])},${canonicalLeg(complete[1])},${canonicalLeg(complete[2])}`
            : `${canonicalLeg(complete[0])},${canonicalLeg(complete[1])},${canonicalLeg(complete[2])},${canonicalLeg(complete[3])}`;
        const ticketJson = `{"direction":${JSON.stringify(direction)},"horizonHours":${horizonHours},"legs":[${serializedLegs}],"originMs":${originMs},"stratum":${stratumJson}}`;
        const key = hash("sha256", hashPrefix + ticketJson, "hex");
        const candidate = { ticketJson, key, ticket };
        if (chosen.length < 12) {
          chosen.push(candidate);
          if (chosen.length === 12) for (let index = 1; index < chosen.length; index++) if (compare(chosen[index], chosen[worstIndex]) > 0) worstIndex = index;
        } else if (compare(candidate, chosen[worstIndex]) < 0) {
          chosen[worstIndex] = candidate;
          worstIndex = 0;
          for (let index = 1; index < chosen.length; index++) if (compare(chosen[index], chosen[worstIndex]) > 0) worstIndex = index;
        }
      }
    }
    output.push(...chosen.sort(compare).map((entry): SyntheticTicket => {
      const { interval, ...ticket } = entry.ticket;
      const futureByUnderlying = new Map([...new Set(ticket.legs.map((leg) => leg.underlying))].map((underlying) => [underlying, cachedFuture(underlying, interval, ticket.horizonHours)]));
      const known = [...futureByUnderlying.values()].every((value) => value !== null);
      const outcome = known && ticket.legs.every((leg) => leg.direction === "up" ? futureByUnderlying.get(leg.underlying)! > leg.threshold : futureByUnderlying.get(leg.underlying)! < leg.threshold) ? 1 as const : known ? 0 as const : null;
      return { key: entry.key, ...ticket, outcome };
    }));
  }
  return output;
}

export function forecastAt(originMs: number, series: ReplaySeries): SyntheticTicket[] {
  return syntheticEvents(originMs, { ...series, rows: series.rows.filter((row) => observationTime(row) <= originMs) }, []);
}

interface FhsResult { available: boolean; probability: number | null; hits: number; blocks: number; originMean: number[]; originSigma: number[]; reason: "insufficient-sample" | null }

function alignedRows(series: ReplaySeries, underlyings: string[], interval: "1h" | "1d", originMs = Number.POSITIVE_INFINITY): { timestampMs: number; values: number[]; contiguous: boolean }[] {
  const ordered = underlyings.map((underlying) => series.rows.filter((row) => row.underlying === underlying && row.interval === interval && observationTime(row) <= originMs).sort((left, right) => left.timestampMs - right.timestampMs));
  const maps = ordered.map((rows) => new Map(rows.map((row) => [interval === "1h" ? String(row.timestampMs) : row.sessionDate, row])));
  const positions = ordered.map((rows) => new Map(rows.map((row, index) => [interval === "1h" ? String(row.timestampMs) : row.sessionDate, index])));
  const common = [...maps[0].keys()].filter((key) => maps.every((map) => map.has(key))).sort((left, right) => (maps[0].get(left)!.timestampMs - maps[0].get(right)!.timestampMs));
  return common.map((key, index) => ({
    timestampMs: Math.max(...maps.map((map) => map.get(key)!.timestampMs)),
    values: maps.map((map) => map.get(key)!.value),
    contiguous: index === 0 || positions.every((position) => position.get(key)! === position.get(common[index - 1])! + 1),
  }));
}

function ewStats(rows: { timestampMs: number; values: number[] }[], end: number, asset: number): { mu: number; sigma: number } | null {
  if (end < 2) return null;
  const asOfMs = rows[end - 1].timestampMs;
  const weights = rows.slice(0, end).map((row) => 2 ** (-((asOfMs - row.timestampMs) / DAY) / 45));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const mu = rows.slice(0, end).reduce((sum, row, index) => sum + weights[index] * row.values[asset], 0) / total;
  const variance = rows.slice(0, end).reduce((sum, row, index) => sum + weights[index] * (row.values[asset] - mu) ** 2, 0) / total;
  return Number.isFinite(mu) && variance > 0 ? { mu, sigma: Math.sqrt(variance) } : null;
}

export function filteredHistoricalSimulation(ticket: SyntheticTicket, series: ReplaySeries): FhsResult {
  const underlyings = [...new Set(ticket.legs.map((leg) => leg.underlying))].sort();
  const interval = intervalFor(series, underlyings, true);
  const rows = alignedRows(series, underlyings, interval, ticket.originMs);
  const originStats = underlyings.map((_, asset) => ewStats(rows, rows.length, asset));
  const empty = (reason: "insufficient-sample" | null): FhsResult => ({ available: false, probability: null, hits: 0, blocks: 0, originMean: originStats.map((stats) => stats?.mu ?? 0), originSigma: originStats.map((stats) => stats?.sigma ?? 0), reason });
  if (originStats.some((stats) => stats === null) || (interval === "1h" && rows.length < 1_000)) return empty("insufficient-sample");
  const residuals: { timestampMs: number; values: number[]; contiguous: boolean }[] = [];
  for (let index = 0; index < rows.length; index++) {
    const stats = underlyings.map((_, asset) => ewStats(rows, index, asset));
    if (stats.some((value) => value === null)) continue;
    const values = stats.map((value, asset) => (rows[index].values[asset] - value!.mu) / value!.sigma);
    if (values.every(Number.isFinite)) residuals.push({ timestampMs: rows[index].timestampMs, values, contiguous: rows[index].contiguous });
  }
  const size = interval === "1h" ? ticket.horizonHours : ticket.horizonHours / 24;
  let hits = 0;
  let blocks = 0;
  for (let start = 0; start + size <= residuals.length; start++) {
    const block = residuals.slice(start, start + size);
    if (block.some((row, index) => index > 0 && (!row.contiguous || (interval === "1h" && row.timestampMs - block[index - 1].timestampMs !== HOUR)))) continue;
    const reconstructed = underlyings.map((_, asset) => size * originStats[asset]!.mu + originStats[asset]!.sigma * block.reduce((sum, row) => sum + row.values[asset], 0));
    blocks++;
    if (ticket.legs.every((leg) => {
      const value = reconstructed[underlyings.indexOf(leg.underlying)];
      return leg.direction === "up" ? value > leg.threshold : value < leg.threshold;
    })) hits++;
  }
  if (interval === "1d" && blocks < 90) return empty("insufficient-sample");
  return { available: true, probability: (hits + 1) / (blocks + 2), hits, blocks, originMean: originStats.map((stats) => stats!.mu), originSigma: originStats.map((stats) => stats!.sigma), reason: null };
}

function fittedMatrix(rows: ReturnRecord[], sources: SourceEntry[], originMs = Number.POSITIVE_INFINITY): { matrix: number[][]; values: number[][]; observationTimes: number[]; sources: SourceEntry[] } {
  const sorted = [...sources].sort((left, right) => left.underlying.localeCompare(right.underlying));
  const asOfMs = Number.isSafeInteger(originMs) ? originMs : Math.max(...rows.map((row) => row.timestampMs));
  const series: ReplaySeries = { rows, sources: sorted, manifestHash: "0".repeat(64) };
  const estimates: PairEstimate[] = [];
  for (let left = 0; left < sorted.length; left++) for (let right = left + 1; right < sorted.length; right++) {
    const interval = sorted[left].cluster === sorted[right].cluster ? "1h" : "1d";
    const pair = alignedRows(series, [sorted[left].underlying, sorted[right].underlying], interval, asOfMs);
    if (pair.length < 2) continue;
    try {
      const estimate = weightedCorrelation(pair.map((row) => ({ timestampMs: row.timestampMs, a: row.values[0], b: row.values[1] })), 45, asOfMs);
      estimates.push({ pair: [sorted[left].underlying, sorted[right].underlying], ...estimate, eligible: pair.length >= (interval === "1h" ? 1_000 : 90) });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "weighted correlation requires non-constant series") throw error;
    }
  }
  const targets = structuredTargets(estimates, sorted);
  const byPair = new Map(estimates.map((estimate) => [estimate.pair.join(":"), estimate]));
  const raw = sorted.map((left, row) => sorted.map((right, column) => {
    if (row === column) return 1;
    const key = left.underlying < right.underlying ? `${left.underlying}:${right.underlying}` : `${right.underlying}:${left.underlying}`;
    const estimate = byPair.get(key);
    const target = left.cluster === right.cluster ? targets.clusters[left.cluster] : targets.global;
    return estimate?.eligible ? shrinkPair(estimate, target) : target;
  }));
  const daily = alignedRows(series, sorted.map((source) => source.underlying), "1d", asOfMs);
  const base = daily.length >= 3 ? daily : alignedRows(series, sorted.map((source) => source.underlying), "1h", asOfMs);
  if (base.length < 3) throw new Error("dependence fit requires at least three complete rows");
  return { matrix: nearestCorrelation(raw), values: base.map((row) => row.values), observationTimes: base.map((row) => row.timestampMs), sources: sorted };
}

export interface ReplayDependenceFit {
  matrix: number[][];
  values: number[][];
  observationTimes: number[];
  sources: SourceEntry[];
  admittedPairs: Set<string>;
}

export function fitReplayDependence(rows: ReturnRecord[], sources: SourceEntry[], candidate: CorrelationArtifact, originMs: number, fits?: Map<number, ReplayDependenceFit>): ReplayDependenceFit {
  const cached = fits?.get(originMs);
  if (cached) return cached;
  const window = { asOfMs: originMs, lookbackMs: 180 * DAY };
  const causal = rows.filter((row) => observationTime(row) <= originMs && row.timestampMs >= originMs - window.lookbackMs);
  const quarantined = new Set(candidate.quality.quarantinedUnderlyings.map((entry) => entry.underlying));
  const eligible = new Set(candidate.quality.eligibleUnderlyings);
  const sorted = sources.filter((source) => source.measurementEnabled && eligible.has(source.underlying) && !quarantined.has(source.underlying))
    .filter((source) => trailingFresh(source, causal.filter((row) => row.underlying === source.underlying).map((row) => row.timestampMs), originMs))
    .sort((left, right) => left.underlying < right.underlying ? -1 : left.underlying > right.underlying ? 1 : 0);
  if (sorted.length < 2) throw new Error("dependence fit requires two eligible fresh sources");
  const policy = new Map(candidate.quality.pairEligibility.map((entry) => [pairName(...entry.pair), entry.status]));
  const estimates: PairEstimate[] = [];
  const samples = new Map<string, ReturnType<typeof calibrationPairSample>>();
  const alignment: CalibrationAlignmentCache = { possible: new Map(), returns: new Map() };
  for (let left = 0; left < sorted.length; left++) for (let right = left + 1; right < sorted.length; right++) {
    const a = sorted[left];
    const b = sorted[right];
    const key = pairName(a.underlying, b.underlying);
    const sample = calibrationPairSample(causal, a, b, window, alignment);
    samples.set(key, sample);
    if (policy.get(key) !== "direct" || !sample.eligible || sample.rows.length < 2) continue;
    try {
      estimates.push({ pair: [a.underlying, b.underlying], ...weightedCorrelation(sample.rows, 45, originMs), eligible: true });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "weighted correlation requires non-constant series") throw error;
    }
  }
  const targets = structuredTargets(estimates, sorted);
  const estimatesByPair = new Map(estimates.map((estimate) => [pairName(...estimate.pair), estimate]));
  const admittedPairs = new Set<string>();
  const raw = sorted.map((left, row) => sorted.map((right, column) => {
    if (row === column) return 1;
    const key = pairName(left.underlying, right.underlying);
    const status = policy.get(key);
    const target = left.cluster === right.cluster ? targets.clusters[left.cluster] : targets.global;
    const estimate = estimatesByPair.get(key);
    if (status === "direct" && estimate && samples.get(key)?.eligible) {
      admittedPairs.add(key);
      return shrinkPair(estimate, target);
    }
    if (status === "fallback" && left.fallbackEligible && right.fallbackEligible) {
      admittedPairs.add(key);
      return target;
    }
    return 0;
  }));
  const series: ReplaySeries = { rows: causal, sources: sorted, manifestHash: "0".repeat(64) };
  const daily = alignedRows(series, sorted.map((source) => source.underlying), "1d", originMs);
  const base = daily.length >= 3 ? daily : alignedRows(series, sorted.map((source) => source.underlying), "1h", originMs);
  if (base.length < 3) throw new Error("dependence fit requires at least three complete rows");
  const result = { matrix: nearestCorrelation(raw), values: base.map((row) => row.values), observationTimes: base.map((row) => row.timestampMs), sources: sorted, admittedPairs };
  fits?.set(originMs, result);
  return result;
}

function determinantFromCholesky(lower: number[][]): number {
  return lower.reduce((product, row, index) => product * row[index] ** 2, 1);
}

function solveLower(lower: number[][], values: number[]): number[] {
  const solved: number[] = [];
  for (let row = 0; row < lower.length; row++) solved[row] = (values[row] - lower[row].slice(0, row).reduce((sum, value, column) => sum + value * solved[column], 0)) / lower[row][row];
  return solved;
}

function tLogLikelihood(values: number[][], matrix: number[][], df: number, fitValues: number[][]): number {
  const dimensions = matrix.length;
  const mus = matrix.map((_, asset) => mean(fitValues.map((row) => row[asset])));
  const sigmas = matrix.map((_, asset) => Math.sqrt(mean(fitValues.map((row) => (row[asset] - mus[asset]) ** 2))) || 1);
  const lower = cholesky(matrix);
  const determinant = determinantFromCholesky(lower);
  const constant = logGamma((df + dimensions) / 2) - logGamma(df / 2) - (dimensions / 2) * Math.log(df * Math.PI) - 0.5 * Math.log(determinant);
  return values.reduce((sum, row) => {
    const standardized = row.map((value, asset) => (value - mus[asset]) / sigmas[asset]);
    const solved = solveLower(lower, standardized);
    const quadratic = solved.reduce((total, value) => total + value * value, 0);
    return sum + constant - ((df + dimensions) / 2) * Math.log1p(quadratic / df);
  }, 0);
}

export function selectDegreesOfFreedom(rows: ReturnRecord[], sources: SourceEntry[], _seed = "replay", originMs = Number.POSITIVE_INFINITY, candidate?: CorrelationArtifact, fits?: Map<number, ReplayDependenceFit>): number {
  const causal = rows.filter((row) => observationTime(row) <= originMs);
  const fitted = candidate ? fitReplayDependence(causal, sources, candidate, originMs, fits) : fittedMatrix(causal, sources, originMs);
  const split = Math.max(3, Math.floor(fitted.values.length * 0.8));
  const fitValues = fitted.values.slice(0, split);
  const validation = fitted.values.slice(split);
  const cutoff = fitted.observationTimes[split - 1];
  const matrix = candidate
    ? fitReplayDependence(causal.filter((row) => observationTime(row) <= cutoff), sources, candidate, cutoff, fits).matrix
    : fittedMatrix(causal.filter((row) => observationTime(row) <= cutoff), sources, cutoff).matrix;
  let selected: number = DFS[0];
  let best = Number.NEGATIVE_INFINITY;
  for (const df of DFS) {
    const score = tLogLikelihood(validation, matrix, df, fitValues);
    if (score > best) { best = score; selected = df; }
  }
  return selected;
}

function degradation(baseline: number[], measured: number[]): number {
  const baselineMean = mean(baseline);
  return baselineMean === 0 ? 0 : (mean(measured) - baselineMean) / baselineMean;
}

export function blockBootstrap(origins: BootstrapOrigin[], blockHours = 96, samples = 2_000, seed = "replay"): Interval {
  if (!origins.length || !Number.isInteger(blockHours) || blockHours < 96 || !Number.isInteger(samples) || samples <= 0) throw new Error("bootstrap requires origins, blocks of at least 96 hours, and positive samples");
  const sorted = [...origins].sort((left, right) => left.originMs - right.originMs);
  if (sorted.at(-1)!.originMs - sorted[0].originMs < blockHours * HOUR) throw new Error("bootstrap origins do not span one complete block");
  const groups: BootstrapOrigin[][] = [];
  let current: BootstrapOrigin[] = [];
  for (const origin of sorted) {
    current.push(origin);
    if (origin.originMs - current[0].originMs >= blockHours * HOUR) { groups.push(current); current = []; }
  }
  if (current.length) {
    if (groups.length) groups[groups.length - 1].push(...current);
    else groups.push(current);
  }
  const random = seeded(seed);
  const estimates = Array.from({ length: samples }, () => {
    const selected = Array.from({ length: groups.length }, () => groups[Math.floor(random() * groups.length)]).flat();
    return degradation(selected.flatMap((origin) => origin.baselineLosses), selected.flatMap((origin) => origin.measuredLosses));
  }).sort((left, right) => left - right);
  return {
    point: degradation(sorted.flatMap((origin) => origin.baselineLosses), sorted.flatMap((origin) => origin.measuredLosses)),
    lower: estimates[Math.floor((samples - 1) * 0.025)],
    upper: estimates[Math.ceil((samples - 1) * 0.975)],
    groups: groups.map((group) => group.map((origin) => origin.originMs)),
    samples,
    blockHours,
  };
}

function gaussianProbability(ticket: SyntheticTicket, table: CorrelationTable): number {
  const legs: CorrLeg[] = ticket.legs.map((leg, index) => ({
    vault: `${ticket.key}:${index}`,
    isYes: true,
    probWad: BigInt(Math.round(clampProbability(leg.marginalProbability) * Number(WAD))),
    cluster: leg.cluster,
    underlying: leg.underlying,
    bullish: leg.direction === "up",
  }));
  return clampProbability(Number(jointProbWad(legs, table, 0)) / Number(WAD));
}

function measuredTable(clusters: CorrelationArtifact["clusters"]): CorrelationTable {
  return {
    underlyings: Object.fromEntries(Object.values(clusters).flatMap((entries) => Object.entries(entries).map(([underlying, loading]) => [underlying, { global: loading.global, cluster: loading.cluster, underlying: loading.underlying }]))),
    fallback: {},
    shrunkClusters: [],
  };
}

export function ticketStress(ticket: SyntheticTicket, series: ReplaySeries, future: ReturnRecord[]): StressThreshold {
  const underlyings = [...new Set(ticket.legs.map((leg) => leg.underlying))].sort();
  const interval = intervalFor(series, underlyings);
  const rows = alignedRows(series, underlyings, interval, ticket.originMs);
  const portfolio = rows.map((row) => mean(row.values));
  const dailyPortfolio = (values: number[]): number[] => interval === "1d" ? values : Array.from({ length: Math.floor(values.length / 24) }, (_, index) => values.slice(index * 24, index * 24 + 24).reduce((sum, value) => sum + value, 0));
  const volatilities = (values: number[]): number[] => interval === "1d" ? values.map(Math.abs) : Array.from({ length: Math.max(0, values.length - 23) }, (_, index) => {
    const window = values.slice(index, index + 24);
    const average = mean(window);
    return Math.sqrt(window.reduce((sum, value) => sum + (value - average) ** 2, 0) / window.length) * Math.sqrt(24);
  });
  const drawdowns = (values: number[]): number[] => {
    let cumulative = 0;
    let peak = 0;
    return values.map((value) => {
      cumulative += value;
      peak = Math.max(peak, cumulative);
      return cumulative - peak;
    });
  };
  const trainingVolatilities = volatilities(portfolio);
  const upperVolatilityTercile = percentile(trainingVolatilities, 2 / 3);
  const trainingDrawdowns = drawdowns(dailyPortfolio(portfolio));
  const drawdownFifthPercentile = percentile(trainingDrawdowns, 0.05);
  const size = interval === "1h" ? ticket.horizonHours : ticket.horizonHours / 24;
  const step = interval === "1h" ? HOUR : DAY;
  const futureByUnderlying = underlyings.map((underlying) => new Map(future.filter((row) => row.underlying === underlying && row.interval === interval).map((row) => [row.timestampMs, row.value])));
  const futurePortfolio = Array.from({ length: size }, (_, index) => mean(futureByUnderlying.map((values) => values.get(ticket.originMs + (index + 1) * step) ?? Number.NaN)));
  const futureDrawdowns = drawdowns(dailyPortfolio(futurePortfolio));
  const futureVolatilities = volatilities(futurePortfolio);
  const regime: StressRegime = futureDrawdowns.some((value) => value <= drawdownFifthPercentile) ? "drawdown-stress"
    : futureVolatilities.some((value) => value >= upperVolatilityTercile) ? "high-volatility" : "normal";
  return { originMs: ticket.originMs, ticketKey: ticket.key, upperVolatilityTercile, drawdownFifthPercentile, regime };
}

function byDimension(rows: ForecastRow[], key: keyof Pick<ForecastRow, "window" | "horizon" | "ticketSize" | "clusterCombination" | "direction" | "stressRegime">): Record<string, ScoreSummary> {
  return Object.fromEntries([...new Set(rows.map((row) => String(row[key])))].sort().map((value) => [value, scoreForecasts(rows.filter((row) => String(row[key]) === value))]));
}

function modelScore(rows: ForecastRow[]): ModelScore {
  const stress = Object.fromEntries(STRESS_REGIMES.map((regime) => [regime, scoreForecasts(rows.filter((row) => row.stressRegime === regime))]));
  return {
    overall: scoreForecasts(rows),
    byWindow: byDimension(rows, "window"),
    byHorizon: byDimension(rows, "horizon"),
    byTicketSize: byDimension(rows, "ticketSize"),
    byClusterCombination: byDimension(rows, "clusterCombination"),
    byDirection: byDimension(rows, "direction"),
    byStressRegime: Object.fromEntries(Object.entries(stress).map(([key, score]) => [key, { ...score, gateEligible: score.eligibleRows >= 1_000, exclusionReason: score.eligibleRows >= 1_000 ? null : "insufficient-stress-sample" }])),
  };
}

function ticketCountKey(ticket: SyntheticTicket): string { return `${ticket.stratum}:${ticket.legs.length}`; }

export function replayOrigins(series: ReplaySeries): number[] {
  const daily = [...new Set(series.rows.filter((row) => row.interval === "1d").map((row) => row.timestampMs))].sort((left, right) => left - right);
  if (daily.length >= 90) {
    const origins: number[] = [];
    for (let origin = daily[89]; origin <= daily.at(-1)! - 96 * HOUR; origin += DAY) origins.push(origin);
    return origins;
  }
  const hourly = [...new Set(series.rows.filter((row) => row.interval === "1h").map((row) => row.timestampMs))].sort((left, right) => left - right);
  if (hourly.length < 1_000) return [];
  const first = hourly[999];
  const last = hourly.at(-1)! - 96 * HOUR;
  const origins: number[] = [];
  for (let origin = first; origin <= last; origin += DAY) origins.push(origin);
  return origins;
}

function validationPath(root: string, modelVersion: string): string { return join(resolve(root), "artifacts", "candidates", `${modelVersion}.validation.json`); }

function readExisting(path: string, candidateSha256: string, inputManifestSha256: string, root: string): ValidationReport | null {
  if (!existsSync(path)) return null;
  const report = JSON.parse(readFileSync(path, "utf8")) as ValidationReport;
  if (report.candidateSha256 !== candidateSha256 || report.inputManifestSha256 !== inputManifestSha256) throw new Error("validation already exists for different immutable inputs");
  const snapshot = readFileSync(join(root, report.baselineSnapshotPath));
  if (sha256(snapshot) !== report.baselineSha256) throw new Error("baseline snapshot hash mismatch");
  return report;
}

interface ReplayComputation {
  ticketCounts: Record<string, number>;
  selectedTicketKeys: string[];
  modelScores: Record<ModelName, ModelScore>;
  bootstrap: Interval;
  stressThresholds: StressThreshold[];
  degreeOfFreedomSelections: { originMs: number; df: number }[];
  exclusions: ReplayExclusion[];
  matrixFailure: boolean;
  nonFinite: boolean;
  stressFailures: boolean;
}

export function runReplay(input: ReplayInput): ValidationReport {
  const root = resolve(input.root);
  if ("draws" in input) throw new Error("replay uses exactly 20,000 draws");
  if (!SAFE_MODEL_VERSION.test(input.candidate.modelVersion)) throw new Error("replay modelVersion is not a safe artifact filename");
  if (input.inputManifestSha256 !== input.candidate.dataManifestSha256 || input.series.manifestHash !== input.inputManifestSha256) throw new Error("replay immutable input identities differ");
  const candidateSha256 = sha256(input.candidateBytes ?? canonicalJson(input.candidate));
  const outputPath = validationPath(root, input.candidate.modelVersion);
  const existing = readExisting(outputPath, candidateSha256, input.inputManifestSha256, root);
  if (existing) return existing;
  const baselineCanonical = canonicalJson(JSON.parse(readFileSync(resolve(input.baselineFile), "utf8")));
  const baselineSha256 = sha256(baselineCanonical);
  const baselinePath = join(root, "facts", "baselines", `${baselineSha256}.json`);
  if (existsSync(baselinePath)) {
    if (readFileSync(baselinePath, "utf8") !== baselineCanonical) throw new Error("baseline snapshot already exists with different bytes");
  } else if (!atomicWriteNew(baselinePath, baselineCanonical) && readFileSync(baselinePath, "utf8") !== baselineCanonical) throw new Error("baseline snapshot already exists with different bytes");
  const baseline = parseCorrelations(baselineCanonical);
  const compute = (): ReplayComputation => {
  let matrixFailure = input.candidate.quality.matrixOrder.length !== input.candidate.quality.signedPsdTarget.length
    || input.candidate.quality.matrixOrder.some((underlying) => !input.series.sources.some((source) => source.underlying === underlying));
  try { cholesky(input.candidate.quality.signedPsdTarget); } catch { matrixFailure = true; }
  const draws = 20_000;
  const origins = replayOrigins(input.series);
  const forecastRows: ForecastRow[] = [];
  const exclusions: ReplayExclusion[] = [];
  let hadNonFinite = false;
  const stressThresholds: StressThreshold[] = [];
  const degreeOfFreedomSelections: { originMs: number; df: number }[] = [];
  const fittedByOrigin = new Map<number, ReplayDependenceFit>();
  const selectedTicketKeys: string[] = [];
  const ticketCounts: Record<string, number> = Object.fromEntries((["same-underlying", "same-cluster", "cross-cluster"] as TicketStratum[]).flatMap((stratum) => [2, 3, 4].map((size) => [`${stratum}:${size}`, 0])));
  for (const originMs of origins) {
    let df: number = DFS[0];
    let fitted: ReplayDependenceFit | null = null;
    try {
      fitted = fitReplayDependence(input.series.rows, input.series.sources, input.candidate, originMs, fittedByOrigin);
      if (fitted.admittedPairs.size) df = selectDegreesOfFreedom(input.series.rows, input.series.sources, `${input.seed}:${originMs}`, originMs, input.candidate, fittedByOrigin);
    } catch {
      matrixFailure = true;
      exclusions.push({ originMs, ticketKey: null, model: "measured-hierarchical-gaussian", reason: "non-finite-probability" });
    }
    const training = {
      ...input.series,
      sources: fitted?.sources ?? [],
      rows: input.series.rows.filter((row) => observationTime(row) <= originMs && row.timestampMs >= originMs - 180 * DAY),
    };
    const future = input.series.rows.filter((row) => observationTime(row) > originMs);
    const selected = syntheticEvents(originMs, training, future, fitted?.admittedPairs ?? new Set());
    const tickets = selected.filter((ticket) => ticket.outcome !== null);
    exclusions.push({ originMs, ticketKey: null, model: null, reason: "structurally-unavailable", stratum: "same-underlying", legCount: 4 });
    selectedTicketKeys.push(...selected.map((ticket) => ticket.key));
    for (const ticket of selected) ticketCounts[ticketCountKey(ticket)] = (ticketCounts[ticketCountKey(ticket)] ?? 0) + 1;
    degreeOfFreedomSelections.push({ originMs, df });
    const order = fitted?.sources.map((source) => source.underlying) ?? [];
    const generated = fitted && !matrixFailure ? tDraws(fitted.matrix, df, draws, `${input.seed}:${originMs}:${df}`) : [];
    const measuredCorrelation = fitted ? measuredTable(fitHierarchical(fitted.matrix, fitted.sources, fitted.admittedPairs).loadings) : null;
    const tThresholds = new Map<number, number>();
    const tThreshold = (probability: number): number => {
      const bounded = Math.min(1 - 1e-12, Math.max(1e-12, probability));
      const existing = tThresholds.get(bounded);
      if (existing !== undefined) return existing;
      const value = studentTInv(1 - bounded, df);
      tThresholds.set(bounded, value);
      return value;
    };
    for (const ticket of tickets) {
      const stress = ticketStress(ticket, training, future);
      stressThresholds.push(stress);
      const independence = clampProbability(ticket.legs.reduce((product, leg) => product * leg.marginalProbability, 1));
      const fhs = filteredHistoricalSimulation(ticket, training);
      if (!fhs.available) exclusions.push({ originMs, ticketKey: ticket.key, model: "filtered-historical-simulation", reason: "insufficient-sample" });
      const tResult = generated.length ? (() => {
        const thresholds = ticket.legs.map((leg) => tThreshold(leg.marginalProbability));
        let hits = 0;
        for (const draw of generated) if (ticket.legs.every((leg, index) => {
          const value = draw[order.indexOf(leg.underlying)];
          return leg.direction === "up" ? value > thresholds[index] : value < -thresholds[index];
        })) hits++;
        return (hits + 1) / (draws + 2);
      })() : Number.NaN;
      const probabilities: Record<ModelName, number | null> = {
        independence,
        "static-hierarchical-gaussian": gaussianProbability(ticket, baseline),
        "measured-hierarchical-gaussian": measuredCorrelation ? gaussianProbability(ticket, measuredCorrelation) : Number.NaN,
        "signed-t-copula": tResult,
        "filtered-historical-simulation": fhs.probability,
      };
      for (const model of MODELS) {
        const probability = probabilities[model];
        if (probability === null) continue;
        if (!Number.isFinite(probability)) {
          exclusions.push({ originMs, ticketKey: ticket.key, model, reason: "non-finite-probability" });
          hadNonFinite = true;
          continue;
        }
        forecastRows.push({
          p: clampProbability(probability), y: ticket.outcome!, originMs, model, window: "180d", horizon: `${ticket.horizonHours}h`, ticketSize: String(ticket.legs.length),
          clusterCombination: [...new Set(ticket.legs.map((leg) => leg.cluster))].sort().join("+"), direction: ticket.direction, stressRegime: stress.regime,
        });
      }
    }
  }
  const modelScores = Object.fromEntries(MODELS.map((model) => [model, modelScore(forecastRows.filter((row) => row.model === model))])) as Record<ModelName, ModelScore>;
  const baselineRows = forecastRows.filter((row) => row.model === "static-hierarchical-gaussian" && row.direction !== "band");
  const measuredRows = forecastRows.filter((row) => row.model === "measured-hierarchical-gaussian" && row.direction !== "band");
  const bootstrapOrigins: BootstrapOrigin[] = origins.map((originMs) => ({
    originMs,
    baselineLosses: baselineRows.filter((row) => row.originMs === originMs).map((row) => logLoss([row])),
    measuredLosses: measuredRows.filter((row) => row.originMs === originMs).map((row) => logLoss([row])),
  })).filter((origin) => origin.baselineLosses.length && origin.baselineLosses.length === origin.measuredLosses.length);
  const canBootstrap = bootstrapOrigins.length > 0 && bootstrapOrigins.at(-1)!.originMs - bootstrapOrigins[0].originMs >= 96 * HOUR;
  if (bootstrapOrigins.length && !canBootstrap) exclusions.push({ originMs: null, ticketKey: null, model: "measured-hierarchical-gaussian", reason: "insufficient-sample" });
  const bootstrap = canBootstrap ? blockBootstrap(bootstrapOrigins, 96, 2_000, input.seed) : { point: 0, lower: 0, upper: 0, groups: [], samples: 2_000, blockHours: 96 };
  const nonFinite = hadNonFinite || forecastRows.some((row) => !Number.isFinite(row.p)) || Object.values(modelScores).some((score) => !Number.isFinite(score.overall.logLoss) || !Number.isFinite(score.overall.brier));
  const stressFailures = Object.keys(modelScores["measured-hierarchical-gaussian"].byStressRegime).some((regime) => {
    const measuredStress = modelScores["measured-hierarchical-gaussian"].byStressRegime[regime];
    const baselineStress = modelScores["static-hierarchical-gaussian"].byStressRegime[regime];
    return measuredStress.gateEligible && baselineStress && (measuredStress.logLoss - baselineStress.logLoss) / baselineStress.logLoss > 0.05;
  });
  return { ticketCounts, selectedTicketKeys, modelScores, bootstrap, stressThresholds, degreeOfFreedomSelections, exclusions, matrixFailure, nonFinite, stressFailures };
  };
  const first = compute();
  const deterministicRerunMatches = canonicalJson(compute()) === canonicalJson(first);
  const decision = first.bootstrap.lower > 0.01 || first.nonFinite || !deterministicRerunMatches || first.matrixFailure || input.candidate.quality.maxProjectionError > 0.10
    ? "Rejected"
    : first.bootstrap.point < 0 && first.bootstrap.upper <= 0.01 && !first.stressFailures ? "Supported" : "Inconclusive";
  const report: ValidationReport = {
    schemaVersion: 1,
    modelVersion: input.candidate.modelVersion,
    candidateSha256,
    inputManifestSha256: input.inputManifestSha256,
    baselineSha256,
    baselineSnapshotPath: relative(root, baselinePath),
    seed: input.seed,
    drawCount: 20_000,
    originStrideHours: 24,
    policy: { maxProjectionError: 0.10, bootstrapBlockHours: 96, bootstrapSamples: 2_000 },
    ticketCounts: first.ticketCounts,
    selectedTicketKeys: first.selectedTicketKeys,
    modelScores: first.modelScores,
    bootstrap: first.bootstrap,
    stressThresholds: first.stressThresholds,
    degreeOfFreedomSelections: first.degreeOfFreedomSelections,
    exclusions: first.exclusions,
    decision,
    deterministicRerunMatches,
    resourcePolicy: { maxWallClockMs: 30_000, maxPeakRssBytes: 536_870_912 },
    limitations: ["testnet outcomes do not validate production price discovery", "signed t-copula and filtered historical simulation are report-only", "band markets are excluded from statistical success"],
  };
  const bytes = `${canonicalJson(report)}\n`;
  if (!atomicWriteNew(outputPath, bytes) && readFileSync(outputPath, "utf8") !== bytes) throw new Error("validation already exists with different bytes");
  return report;
}
