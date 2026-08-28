import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { jointProbWad, parseCorrelations, type CorrLeg, type CorrelationTable } from "../correlation.js";
import { fitHierarchical } from "./calibration.js";
import { cholesky, nearestCorrelation, shrinkPair, structuredTargets, weightedCorrelation, type PairEstimate } from "./matrix.js";
import type { ReturnRecord } from "./returns.js";
import { atomicWriteNew, canonicalJson, sha256 } from "./store.js";
import type { CorrelationArtifact, SourceEntry } from "./types.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const WAD = 10n ** 18n;
const HORIZONS = [24, 48, 72, 96] as const;
const QUANTILES = [0.25, 0.5, 0.75] as const;
const DFS = [4, 6, 8, 12, 20, 30] as const;
const MODELS = ["independence", "static-hierarchical-gaussian", "measured-hierarchical-gaussian", "signed-t-copula", "filtered-historical-simulation"] as const;

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
  direction: "all-up" | "alternating" | "all-down";
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
  draws?: number;
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
  modelElapsedMs: Record<ModelName, number>;
  peakRssBytes: number;
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

type StressRegime = "drawdown-stress" | "high-volatility" | "normal";
interface StressThreshold { originMs: number; ticketKey: string; upperVolatilityTercile: number; drawdownFifthPercentile: number; regime: StressRegime }
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
  const own = rows.filter((row) => row.underlying === underlying && row.interval === interval && row.timestampMs <= originMs).sort((left, right) => left.timestampMs - right.timestampMs);
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
  const block = rows.filter((row) => row.underlying === underlying && row.interval === interval && row.timestampMs > originMs).sort((left, right) => left.timestampMs - right.timestampMs).slice(0, size);
  if (block.length !== size || (interval === "1h" && block.some((row, index) => index > 0 && row.timestampMs - block[index - 1].timestampMs !== HOUR))) return null;
  return block.reduce((sum, row) => sum + row.value, 0);
}

function ticketDirection(directions: Direction[]): SyntheticTicket["direction"] {
  if (directions.every((direction) => direction === "up")) return "all-up";
  if (directions.every((direction) => direction === "down")) return "all-down";
  return "alternating";
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

export function syntheticEvents(originMs: number, series: ReplaySeries, future: ReturnRecord[]): SyntheticTicket[] {
  if (!Number.isSafeInteger(originMs) || !/^[0-9a-f]{64}$/.test(series.manifestHash)) throw new Error("synthetic replay requires a safe origin and manifest hash");
  const sources = [...series.sources].filter((source) => source.eligible).sort((left, right) => left.underlying.localeCompare(right.underlying));
  const groups: Record<TicketStratum, SourceEntry[][]> = { "same-underlying": [], "same-cluster": [], "cross-cluster": [] };
  for (const size of [2, 3, 4]) {
    if (size <= 3) groups["same-underlying"].push(...sources.map((source) => Array.from({ length: size }, () => source)));
    for (const cluster of [...new Set(sources.map((source) => source.cluster))]) groups["same-cluster"].push(...combinations(sources.filter((source) => source.cluster === cluster), size));
    groups["cross-cluster"].push(...combinations(sources, size).filter((selected) => new Set(selected.map((source) => source.cluster)).size >= 2));
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
  for (const stratum of Object.keys(groups) as TicketStratum[]) {
    const chosen: { ticketJson: string; ticket: SyntheticTicket }[] = [];
    const compare = (left: { ticketJson: string; ticket: SyntheticTicket }, right: { ticketJson: string; ticket: SyntheticTicket }): number => left.ticket.key.localeCompare(right.ticket.key) || left.ticketJson.localeCompare(right.ticketJson);
    const hashPrefix = createHash("sha256").update(`${series.manifestHash}${originMs}${stratum}`);
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
      const interval = intervalFor(series, [...new Set(assets.map((source) => source.underlying))]);
      const quantileTuples = stratum === "same-underlying"
        ? combinations([...QUANTILES], assets.length)
        : tuples(QUANTILES, assets.length);
      const directionVectors: Direction[][] = [assets.map(() => "up"), assets.map((_, index) => index % 2 ? "down" : "up"), assets.map(() => "down")];
      for (const quantiles of quantileTuples) for (const directions of directionVectors) {
        const ticketLegs = assets.map((source, index) => cachedLeg(source, interval, horizonHours, quantiles[index], directions[index]));
        if (ticketLegs.some((leg) => leg === null)) continue;
        const complete = (ticketLegs as SyntheticLeg[]).sort((left, right) => left.underlying.localeCompare(right.underlying) || left.quantile - right.quantile);
        if (contradictory(complete)) continue;
        const futureByUnderlying = new Map([...new Set(complete.map((leg) => leg.underlying))].map((underlying) => [underlying, cachedFuture(underlying, interval, horizonHours)]));
        const known = [...futureByUnderlying.values()].every((value) => value !== null);
        const ticket = {
          originMs, horizonHours, stratum, direction: ticketDirection(complete.map((leg) => leg.direction)), legs: complete,
          outcome: known && complete.every((leg) => leg.direction === "up" ? futureByUnderlying.get(leg.underlying)! > leg.threshold : futureByUnderlying.get(leg.underlying)! < leg.threshold) ? 1 as const : known ? 0 as const : null,
        };
        const ticketJson = `{"direction":${JSON.stringify(ticket.direction)},"horizonHours":${horizonHours},"legs":[${complete.map(canonicalLeg).join(",")}],"originMs":${originMs},"stratum":${JSON.stringify(stratum)}}`;
        const key = hashPrefix.copy().update(ticketJson).digest("hex");
        const candidate = { ticketJson, ticket: { key, ...ticket } };
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
    output.push(...chosen.sort(compare).map((entry) => entry.ticket));
  }
  return output;
}

export function forecastAt(originMs: number, series: ReplaySeries): SyntheticTicket[] {
  return syntheticEvents(originMs, { ...series, rows: series.rows.filter((row) => row.timestampMs <= originMs) }, []);
}

interface FhsResult { available: boolean; probability: number | null; hits: number; blocks: number; originMean: number[]; originSigma: number[]; reason: "insufficient-sample" | null }

function alignedRows(series: ReplaySeries, underlyings: string[], interval: "1h" | "1d", originMs = Number.POSITIVE_INFINITY): { timestampMs: number; values: number[]; contiguous: boolean }[] {
  const ordered = underlyings.map((underlying) => series.rows.filter((row) => row.underlying === underlying && row.interval === interval && row.timestampMs <= originMs).sort((left, right) => left.timestampMs - right.timestampMs));
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

function fittedMatrix(rows: ReturnRecord[], sources: SourceEntry[], originMs = Number.POSITIVE_INFINITY): { matrix: number[][]; values: number[][]; sources: SourceEntry[] } {
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
  const daily = alignedRows(series, sorted.map((source) => source.underlying), "1d", asOfMs).map((row) => row.values);
  const interval: "1h" | "1d" = daily.length >= 3 ? "1d" : "1h";
  const values = interval === "1d" ? daily : alignedRows(series, sorted.map((source) => source.underlying), "1h", asOfMs).map((row) => row.values);
  if (values.length < 3) throw new Error("dependence fit requires at least three complete rows");
  return { matrix: nearestCorrelation(raw), values, sources: sorted };
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

export function selectDegreesOfFreedom(rows: ReturnRecord[], sources: SourceEntry[], _seed = "replay", originMs = Number.POSITIVE_INFINITY): number {
  const causal = rows.filter((row) => row.timestampMs <= originMs);
  const fitted = fittedMatrix(causal, sources, originMs);
  const split = Math.max(3, Math.floor(fitted.values.length * 0.8));
  const fitValues = fitted.values.slice(0, split);
  const validation = fitted.values.slice(split);
  const cutoff = [...new Set(causal.filter((row) => row.interval === "1d").map((row) => row.timestampMs))].sort((left, right) => left - right)[split - 1] ?? originMs;
  const matrix = fittedMatrix(causal.filter((row) => row.timestampMs <= cutoff), sources, cutoff).matrix;
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

function ticketStress(ticket: SyntheticTicket, series: ReplaySeries, future: ReturnRecord[]): StressThreshold {
  const underlyings = [...new Set(ticket.legs.map((leg) => leg.underlying))].sort();
  const interval = intervalFor(series, underlyings);
  const rows = alignedRows(series, underlyings, interval, ticket.originMs);
  const portfolio = rows.map((row) => mean(row.values));
  const dailyPortfolio = interval === "1d" ? portfolio : Array.from({ length: Math.floor(portfolio.length / 24) }, (_, index) => portfolio.slice(index * 24, index * 24 + 24).reduce((sum, value) => sum + value, 0));
  const volatilities = interval === "1d" ? portfolio.map(Math.abs) : Array.from({ length: Math.max(0, portfolio.length - 23) }, (_, index) => {
    const window = portfolio.slice(index, index + 24);
    const average = mean(window);
    return Math.sqrt(window.reduce((sum, value) => sum + (value - average) ** 2, 0) / window.length) * Math.sqrt(24);
  });
  const upperVolatilityTercile = percentile(volatilities, 2 / 3);
  let cumulative = 0;
  let peak = 0;
  const drawdowns = dailyPortfolio.map((value) => {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    return cumulative - peak;
  });
  const drawdownFifthPercentile = percentile(drawdowns, 0.05);
  const futureValues = underlyings.map((underlying) => futureReturn(future, underlying, interval, ticket.horizonHours, ticket.originMs) ?? 0);
  const futurePortfolio = mean(futureValues);
  const futureVolatility = Math.abs(futurePortfolio);
  const regime: StressRegime = futurePortfolio <= drawdownFifthPercentile ? "drawdown-stress" : futureVolatility >= upperVolatilityTercile ? "high-volatility" : "normal";
  return { originMs: ticket.originMs, ticketKey: ticket.key, upperVolatilityTercile, drawdownFifthPercentile, regime };
}

function byDimension(rows: ForecastRow[], key: keyof Pick<ForecastRow, "window" | "horizon" | "ticketSize" | "clusterCombination" | "direction" | "stressRegime">): Record<string, ScoreSummary> {
  return Object.fromEntries([...new Set(rows.map((row) => String(row[key])))].sort().map((value) => [value, scoreForecasts(rows.filter((row) => String(row[key]) === value))]));
}

function modelScore(rows: ForecastRow[]): ModelScore {
  const stress = byDimension(rows, "stressRegime");
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

function replayOrigins(series: ReplaySeries): number[] {
  const daily = [...new Set(series.rows.filter((row) => row.interval === "1d").map((row) => row.timestampMs))].sort((left, right) => left - right);
  if (daily.length >= 95) return daily.slice(89, -4);
  const hourly = [...new Set(series.rows.filter((row) => row.interval === "1h").map((row) => row.timestampMs))].sort((left, right) => left - right);
  if (hourly.length < 1_096) return [];
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

export function runReplay(input: ReplayInput): ValidationReport {
  const root = resolve(input.root);
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
  let matrixFailure = false;
  try { cholesky(input.candidate.quality.signedPsdTarget); } catch { matrixFailure = true; }
  const draws = input.draws ?? 20_000;
  const origins = replayOrigins(input.series);
  const forecastRows: ForecastRow[] = [];
  const exclusions: ReplayExclusion[] = [];
  const modelElapsedMs = Object.fromEntries(MODELS.map((model) => [model, 0])) as Record<ModelName, number>;
  let peakRssBytes = process.memoryUsage().rss;
  let hadNonFinite = false;
  const measured = <T>(model: ModelName, operation: () => T): T => {
    const started = performance.now();
    const result = operation();
    modelElapsedMs[model] += Math.max(Number.EPSILON, performance.now() - started);
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    return result;
  };
  const stressThresholds: StressThreshold[] = [];
  const degreeOfFreedomSelections: { originMs: number; df: number }[] = [];
  const selectedTicketKeys: string[] = [];
  const ticketCounts: Record<string, number> = Object.fromEntries((["same-underlying", "same-cluster", "cross-cluster"] as TicketStratum[]).flatMap((stratum) => [2, 3, 4].map((size) => [`${stratum}:${size}`, 0])));
  for (const originMs of origins) {
    const training = { ...input.series, rows: input.series.rows.filter((row) => row.timestampMs <= originMs) };
    const future = input.series.rows.filter((row) => row.timestampMs > originMs);
    const selected = syntheticEvents(originMs, training, future);
    const tickets = selected.filter((ticket) => ticket.outcome !== null);
    exclusions.push({ originMs, ticketKey: null, model: null, reason: "structurally-unavailable", stratum: "same-underlying", legCount: 4 });
    selectedTicketKeys.push(...selected.map((ticket) => ticket.key));
    for (const ticket of selected) ticketCounts[ticketCountKey(ticket)] = (ticketCounts[ticketCountKey(ticket)] ?? 0) + 1;
    let df: number = DFS[0];
    let fitted: ReturnType<typeof fittedMatrix> | null = null;
    try {
      df = selectDegreesOfFreedom(training.rows, training.sources, `${input.seed}:${originMs}`, originMs);
      fitted = fittedMatrix(training.rows, training.sources, originMs);
    } catch { matrixFailure = true; }
    degreeOfFreedomSelections.push({ originMs, df });
    const sortedSources = [...training.sources].sort((left, right) => left.underlying.localeCompare(right.underlying));
    const order = sortedSources.map((source) => source.underlying);
    const generated = fitted ? measured("signed-t-copula", () => tDraws(fitted.matrix, df, draws, `${input.seed}:${originMs}:${df}`)) : [];
    const measuredCorrelation = fitted ? measured("measured-hierarchical-gaussian", () => measuredTable(fitHierarchical(fitted.matrix, fitted.sources).loadings)) : null;
    for (const ticket of tickets) {
      const stress = ticketStress(ticket, training, future);
      stressThresholds.push(stress);
      const independence = measured("independence", () => clampProbability(ticket.legs.reduce((product, leg) => product * leg.marginalProbability, 1)));
      const fhs = measured("filtered-historical-simulation", () => filteredHistoricalSimulation(ticket, training));
      if (!fhs.available) exclusions.push({ originMs, ticketKey: ticket.key, model: "filtered-historical-simulation", reason: "insufficient-sample" });
      const tResult = generated.length ? measured("signed-t-copula", () => {
        const thresholds = ticket.legs.map((leg) => studentTInv(1 - Math.min(1 - 1e-12, Math.max(1e-12, leg.marginalProbability)), df));
        let hits = 0;
        for (const draw of generated) if (ticket.legs.every((leg, index) => {
          const value = draw[order.indexOf(leg.underlying)];
          return leg.direction === "up" ? value > thresholds[index] : value < -thresholds[index];
        })) hits++;
        return (hits + 1) / (draws + 2);
      }) : Number.NaN;
      const probabilities: Record<ModelName, number | null> = {
        independence,
        "static-hierarchical-gaussian": measured("static-hierarchical-gaussian", () => gaussianProbability(ticket, baseline)),
        "measured-hierarchical-gaussian": measuredCorrelation ? measured("measured-hierarchical-gaussian", () => gaussianProbability(ticket, measuredCorrelation)) : Number.NaN,
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
  const baselineRows = forecastRows.filter((row) => row.model === "static-hierarchical-gaussian");
  const measuredRows = forecastRows.filter((row) => row.model === "measured-hierarchical-gaussian");
  const bootstrapOrigins: BootstrapOrigin[] = origins.map((originMs) => ({
    originMs,
    baselineLosses: baselineRows.filter((row) => row.originMs === originMs).map((row) => logLoss([row])),
    measuredLosses: measuredRows.filter((row) => row.originMs === originMs).map((row) => logLoss([row])),
  })).filter((origin) => origin.baselineLosses.length && origin.baselineLosses.length === origin.measuredLosses.length);
  const canBootstrap = bootstrapOrigins.length > 0 && bootstrapOrigins.at(-1)!.originMs - bootstrapOrigins[0].originMs >= 96 * HOUR;
  if (bootstrapOrigins.length && !canBootstrap) exclusions.push({ originMs: null, ticketKey: null, model: "measured-hierarchical-gaussian", reason: "insufficient-sample" });
  const bootstrap = canBootstrap ? blockBootstrap(bootstrapOrigins, 96, 2_000, input.seed) : { point: 0, lower: 0, upper: 0, groups: [], samples: 2_000, blockHours: 96 };
  const deterministicRerunMatches = !canBootstrap || canonicalJson(blockBootstrap(bootstrapOrigins, 96, 2_000, input.seed)) === canonicalJson(bootstrap);
  const nonFinite = hadNonFinite || forecastRows.some((row) => !Number.isFinite(row.p)) || Object.values(modelScores).some((score) => !Number.isFinite(score.overall.logLoss) || !Number.isFinite(score.overall.brier));
  const stressFailures = Object.keys(modelScores["measured-hierarchical-gaussian"].byStressRegime).some((regime) => {
    const measuredStress = modelScores["measured-hierarchical-gaussian"].byStressRegime[regime];
    const baselineStress = modelScores["static-hierarchical-gaussian"].byStressRegime[regime];
    return measuredStress.gateEligible && baselineStress && (measuredStress.logLoss - baselineStress.logLoss) / baselineStress.logLoss > 0.05;
  });
  const decision = bootstrap.lower > 0.01 || nonFinite || !deterministicRerunMatches || matrixFailure || input.candidate.quality.maxProjectionError > 0.10
    ? "Rejected"
    : bootstrap.point < 0 && bootstrap.upper <= 0.01 && !stressFailures ? "Supported" : "Inconclusive";
  const report: ValidationReport = {
    schemaVersion: 1,
    modelVersion: input.candidate.modelVersion,
    candidateSha256,
    inputManifestSha256: input.inputManifestSha256,
    baselineSha256,
    baselineSnapshotPath: relative(root, baselinePath),
    seed: input.seed,
    drawCount: draws,
    originStrideHours: 24,
    policy: { maxProjectionError: 0.10, bootstrapBlockHours: 96, bootstrapSamples: 2_000 },
    ticketCounts,
    selectedTicketKeys,
    modelScores,
    bootstrap,
    stressThresholds,
    degreeOfFreedomSelections,
    exclusions,
    decision,
    deterministicRerunMatches,
    modelElapsedMs,
    peakRssBytes,
    limitations: ["testnet outcomes do not validate production price discovery", "signed t-copula and filtered historical simulation are report-only", "band markets are excluded from statistical success"],
  };
  const bytes = `${canonicalJson(report)}\n`;
  if (!atomicWriteNew(outputPath, bytes) && readFileSync(outputPath, "utf8") !== bytes) throw new Error("validation already exists with different bytes");
  return report;
}
