import { APPROVED_FIT_POLICY } from "./types.js";
import type { CorrelationArtifact, PairEvidenceRecord, ReturnMode, SourceEntry } from "./types.js";

const DAY_MS = 86_400_000;
const EIGEN_FLOOR = 1e-10;
const GATE_TOLERANCE = 1e-12;

export interface CorrelationRow { timestampMs: number; a: number; b: number }
export interface PairEstimate {
  pair: [string, string];
  correlation: number;
  effectiveN: number;
  eligible: boolean;
}

function finiteSquare(matrix: number[][]): void {
  const size = matrix.length;
  if (!size || matrix.some((row) => row.length !== size || row.some((value) => !Number.isFinite(value)))) throw new Error("matrix must be a non-empty finite square matrix");
  for (let row = 0; row < size; row++) for (let column = row + 1; column < size; column++) {
    if (Math.abs(matrix[row][column] - matrix[column][row]) > 1e-12) throw new Error("matrix must be symmetric");
  }
}

export function weightedCorrelation(rows: CorrelationRow[], halfLifeDays: number, asOfMs: number): { correlation: number; effectiveN: number } {
  if (!(halfLifeDays > 0) || !Number.isFinite(halfLifeDays) || !Number.isSafeInteger(asOfMs) || rows.length < 2) throw new Error("weighted correlation requires at least two rows and valid time parameters");
  const weights = rows.map((row) => {
    if (!Number.isSafeInteger(row.timestampMs) || row.timestampMs > asOfMs || !Number.isFinite(row.a) || !Number.isFinite(row.b)) throw new Error("weighted correlation rows must be finite and no later than asOfMs");
    return 2 ** (-((asOfMs - row.timestampMs) / DAY_MS) / halfLifeDays);
  });
  const sumWeights = weights.reduce((sum, weight) => sum + weight, 0);
  const meanA = rows.reduce((sum, row, index) => sum + weights[index] * row.a, 0) / sumWeights;
  const meanB = rows.reduce((sum, row, index) => sum + weights[index] * row.b, 0) / sumWeights;
  let varianceA = 0;
  let varianceB = 0;
  let covariance = 0;
  let sumSquaredWeights = 0;
  for (let index = 0; index < rows.length; index++) {
    const weight = weights[index];
    const centeredA = rows[index].a - meanA;
    const centeredB = rows[index].b - meanB;
    varianceA += weight * centeredA * centeredA;
    varianceB += weight * centeredB * centeredB;
    covariance += weight * centeredA * centeredB;
    sumSquaredWeights += weight * weight;
  }
  const denominator = Math.sqrt(varianceA * varianceB);
  if (!(denominator > 0)) throw new Error("weighted correlation requires non-constant series");
  return { correlation: Math.max(-1, Math.min(1, covariance / denominator)), effectiveN: sumWeights ** 2 / sumSquaredWeights };
}

// Acklam's rational approximation of the standard normal quantile (relative error below 1.2e-9);
// deterministic and dependency-free. Used only for Fisher-z critical values.
const ACKLAM_A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const ACKLAM_B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const ACKLAM_C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const ACKLAM_D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
const ACKLAM_LOW = 0.02425;

function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error("normal quantile requires a probability strictly inside (0, 1)");
  const tail = (q: number): number => (((((ACKLAM_C[0] * q + ACKLAM_C[1]) * q + ACKLAM_C[2]) * q + ACKLAM_C[3]) * q + ACKLAM_C[4]) * q + ACKLAM_C[5]) / ((((ACKLAM_D[0] * q + ACKLAM_D[1]) * q + ACKLAM_D[2]) * q + ACKLAM_D[3]) * q + 1);
  if (p < ACKLAM_LOW) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - ACKLAM_LOW) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5;
  const r = q * q;
  return (((((ACKLAM_A[0] * r + ACKLAM_A[1]) * r + ACKLAM_A[2]) * r + ACKLAM_A[3]) * r + ACKLAM_A[4]) * r + ACKLAM_A[5]) * q / (((((ACKLAM_B[0] * r + ACKLAM_B[1]) * r + ACKLAM_B[2]) * r + ACKLAM_B[3]) * r + ACKLAM_B[4]) * r + 1);
}

function correlationValue(value: number, label: string): number {
  if (!Number.isFinite(value) || Math.abs(value) > 1) throw new Error(`${label} must be a finite correlation inside [-1, 1]`);
  return value;
}

export type FisherInterval = NonNullable<PairEvidenceRecord["interval"]>;
export type GateVerdict = PairEvidenceRecord["gate"];

/** Two-sided Fisher-z interval from the Kish effective sample size (math section 9) plus the
 * Bonferroni-adjusted simultaneous interval over `m` admitted direct pairs (policy rule 2). Throws for
 * rail values (|r| = 1), non-finite inputs, and effective samples at or below 3, which have no
 * defined standard error and therefore cannot be admitted as direct evidence. */
export function fisherInterval(correlation: number, effectiveN: number, m: number, coverage: number = APPROVED_FIT_POLICY.fisherCoverage): FisherInterval {
  if (!Number.isFinite(correlation) || Math.abs(correlation) >= 1) throw new Error("Fisher interval requires a finite correlation strictly inside (-1, 1)");
  if (!Number.isFinite(effectiveN) || !(effectiveN > 3)) throw new Error("Fisher interval requires an effective sample size above 3");
  if (!Number.isSafeInteger(m) || m < 1) throw new Error("Fisher interval requires m >= 1 admitted direct pairs");
  if (!(coverage > 0 && coverage < 1)) throw new Error("Fisher interval requires coverage strictly inside (0, 1)");
  const z = Math.atanh(correlation);
  const standardError = 1 / Math.sqrt(effectiveN - 3);
  const halfWidth = (alpha: number): number => normalQuantile(1 - alpha / 2) * standardError;
  const half = halfWidth(1 - coverage);
  const adjustedHalf = halfWidth((1 - coverage) / m);
  return { lower: Math.tanh(z - half), upper: Math.tanh(z + half), adjustedLower: Math.tanh(z - adjustedHalf), adjustedUpper: Math.tanh(z + adjustedHalf), m };
}

/** Fisher-information reliability weight for direct evidence (math section 10). */
export function reliabilityWeight(effectiveN: number): number {
  if (!Number.isFinite(effectiveN) || !(effectiveN > 0)) throw new Error("reliability weight requires a positive finite effective sample size");
  return Math.max(1, effectiveN - 3);
}

/** Labeled point prior for a retained static fallback value (policy rule 3). */
export function fallbackPrior(target: number): { target: number; weight: number; lower: number; upper: number } {
  correlationValue(target, "fallback prior target");
  const { omegaFallback, fallbackResidualRange } = APPROVED_FIT_POLICY;
  return { target, weight: omegaFallback, lower: target - fallbackResidualRange, upper: target + fallbackResidualRange };
}

/** Direct-pair promotion gate: residual within maxDirectResidual and fitted inside the adjusted
 * Fisher interval (policy rules 1 and 2). Residual failure is reported first. */
export function directGate(fitted: number, target: number, interval: FisherInterval): GateVerdict {
  const residual = correlationValue(fitted, "fitted correlation") - correlationValue(target, "direct target");
  if (Math.abs(residual) > APPROVED_FIT_POLICY.maxDirectResidual + GATE_TOLERANCE) return { passed: false, reason: "direct-residual-out-of-range" };
  if (fitted < interval.adjustedLower - GATE_TOLERANCE || fitted > interval.adjustedUpper + GATE_TOLERANCE) return { passed: false, reason: "direct-outside-fisher-interval" };
  return { passed: true, reason: "direct-residual-and-fisher" };
}

/** Fallback-pair gate: fitted within the approved absolute residual range of the point prior. */
export function fallbackGate(fitted: number, target: number): GateVerdict {
  const residual = correlationValue(fitted, "fitted correlation") - correlationValue(target, "fallback target");
  return Math.abs(residual) <= APPROVED_FIT_POLICY.fallbackResidualRange + GATE_TOLERANCE
    ? { passed: true, reason: "fallback-residual-range" }
    : { passed: false, reason: "fallback-residual-out-of-range" };
}

export type PairEvidenceInput =
  | { evidence: "direct"; pair: [string, string]; mode: ReturnMode; target: number; effectiveN: number; fitted: number; m: number }
  | { evidence: "fallback"; pair: [string, string]; target: number; fitted: number }
  | { evidence: "quarantined"; pair: [string, string]; reason: string; target?: number; fitted?: number };

/** Builds the immutable per-pair evidence record the schemaVersion 3 validator enforces. Direct
 * evidence carries its Kish effectiveN, Fisher-information weight, and Fisher interval; fallback
 * evidence is the labeled point prior; quarantined pairs carry zero weight and never pass. */
export function pairEvidence(input: PairEvidenceInput): PairEvidenceRecord {
  const { pair } = input;
  if (!(pair[0] < pair[1])) throw new Error("pair evidence requires a canonical pair");
  if (input.evidence === "quarantined") {
    const target = input.target === undefined ? null : correlationValue(input.target, "quarantined target");
    const fitted = input.fitted === undefined ? null : correlationValue(input.fitted, "quarantined fitted");
    if ((target === null) !== (fitted === null)) throw new Error("quarantined pair evidence needs both target and fitted or neither");
    return { pair, evidence: "quarantined", mode: null, effectiveN: null, weight: 0, target, interval: null, fitted, residual: target === null || fitted === null ? null : fitted - target, gate: { passed: false, reason: input.reason } };
  }
  const target = correlationValue(input.target, `${input.evidence} target`);
  const fitted = correlationValue(input.fitted, "fitted correlation");
  if (input.evidence === "fallback") {
    return { pair, evidence: "fallback", mode: null, effectiveN: null, weight: fallbackPrior(target).weight, target, interval: null, fitted, residual: fitted - target, gate: fallbackGate(fitted, target) };
  }
  const interval = fisherInterval(target, input.effectiveN, input.m);
  return { pair, evidence: "direct", mode: input.mode, effectiveN: input.effectiveN, weight: reliabilityWeight(input.effectiveN), target, interval, fitted, residual: fitted - target, gate: directGate(fitted, target, interval) };
}

export type FitEvidenceInput =
  | { evidence: "direct"; pair: [string, string]; mode: ReturnMode; target: number; effectiveN: number }
  | { evidence: "fallback"; pair: [string, string]; target: number }
  | { evidence: "quarantined"; pair: [string, string]; reason: string };

export interface SignedFactorFit {
  /** Lexically sorted underlyings; the row/column order of `matrix`. */
  order: string[];
  loadings: CorrelationArtifact["clusters"];
  /** `R = B * transpose(B) + D` over `order` (math section 4). */
  matrix: number[][];
  /** One record per supplied pair, canonical order. Fallback pairs outside their approved range are
   * recorded as quarantined with their residual and the model is refitted without them. */
  pairEvidence: PairEvidenceRecord[];
  /** Weighted least-squares objective over the admitted pairs (math section 10). */
  objective: number;
  /** Every admitted direct pair passed its residual and Fisher gates. */
  passed: boolean;
}

interface FitTarget { left: number; right: number; target: number; weight: number }

/** Weighted least squares in two unknowns subject to `x1^2 + x2^2 <= radius2` (one asset's `g_i`,
 * `c_i` with every other loading held fixed). A relative ridge keeps an unidentified direction (no
 * same-cluster neighbour, so `c_i` never enters) at zero; when the unconstrained minimum leaves the
 * ball, the Lagrange multiplier is found by bisection, which is exact for a quadratic. */
function ballLeastSquares(a11: number, a12: number, a22: number, b1: number, b2: number, radius2: number): [number, number] {
  const scale = a11 + a22;
  if (!(scale > 0)) return [0, 0];
  const solve = (mu: number): [number, number] => {
    const det = (a11 + mu) * (a22 + mu) - a12 * a12;
    return [((a22 + mu) * b1 - a12 * b2) / det, ((a11 + mu) * b2 - a12 * b1) / det];
  };
  const norm2 = (x: [number, number]): number => x[0] * x[0] + x[1] * x[1];
  // Exact solve when the normal matrix is well conditioned; a relative ridge only when it is singular
  // (no same-cluster neighbour), which pins the unidentified loading at zero.
  let low = a11 * a22 - a12 * a12 > 1e-12 * scale * scale ? 0 : 1e-12 * scale;
  const free = solve(low);
  if (norm2(free) <= radius2) return free;
  let high = scale;
  while (norm2(solve(high)) > radius2) high *= 2;
  for (let iteration = 0; iteration < 200; iteration++) {
    const mid = (low + high) / 2;
    if (norm2(solve(mid)) > radius2) low = mid;
    else high = mid;
  }
  return solve(high);
}

/** Alternating exact block minimisation of the weighted objective (math section 10) initialised
 * from the two principal factors of the pairwise target matrix. Every operation runs in canonical
 * order, so identical inputs yield bit-identical loadings. */
function solveLoadings(size: number, clusterIndex: number[], targets: FitTarget[], vMax: number): { g: number[]; c: number[] } {
  const seed: number[][] = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => row === column ? 1 : 0));
  for (const { left, right, target } of targets) seed[left][right] = seed[right][left] = target;
  const { values, vectors } = eigendecompose(seed);
  const [first, second] = values.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value || a.index - b.index);
  const g = vectors.map((row) => Math.sqrt(Math.max(0, first.value)) * row[first.index]);
  const c = vectors.map((row) => second ? Math.sqrt(Math.max(0, second.value)) * row[second.index] : 0);
  for (let i = 0; i < size; i++) {
    const norm2 = g[i] * g[i] + c[i] * c[i];
    if (norm2 > vMax) { const shrink = Math.sqrt(vMax / norm2); g[i] *= shrink; c[i] *= shrink; }
  }
  const neighbours: { other: number; target: number; weight: number; shared: number }[][] = Array.from({ length: size }, () => []);
  for (const { left, right, target, weight } of targets) {
    const shared = clusterIndex[left] === clusterIndex[right] ? 1 : 0;
    neighbours[left].push({ other: right, target, weight, shared });
    neighbours[right].push({ other: left, target, weight, shared });
  }
  let previous = Number.POSITIVE_INFINITY;
  for (let sweep = 0; sweep < 10_000; sweep++) {
    let largestStep = 0;
    for (let i = 0; i < size; i++) {
      if (!neighbours[i].length) { g[i] = 0; c[i] = 0; continue; }
      let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
      for (const { other, target, weight, shared } of neighbours[i]) {
        const row1 = g[other];
        const row2 = shared * c[other];
        a11 += weight * row1 * row1;
        a12 += weight * row1 * row2;
        a22 += weight * row2 * row2;
        b1 += weight * row1 * target;
        b2 += weight * row2 * target;
      }
      const [nextG, nextC] = ballLeastSquares(a11, a12, a22, b1, b2, vMax);
      largestStep = Math.max(largestStep, Math.abs(nextG - g[i]), Math.abs(nextC - c[i]));
      g[i] = nextG;
      c[i] = nextC;
    }
    const objective = targets.reduce((sum, { left, right, target, weight }) => sum + weight * (g[left] * g[right] + (clusterIndex[left] === clusterIndex[right] ? c[left] * c[right] : 0) - target) ** 2, 0);
    // Exact block steps never increase the objective; along an exactly flat (unidentified) direction
    // an ill-conditioned block solve can jitter at ~1e-8 forever, so stagnation of the objective is
    // the terminating criterion, and the loading step is the fast path.
    if (largestStep <= 1e-12 || (sweep > 0 && previous - objective <= 1e-14 * Math.max(1, previous))) return { g, c };
    previous = objective;
  }
  throw new Error("signed factor fit did not converge after 10000 sweeps");
}

/** Deterministic signed asset-specific factor fitter (canonical plan Phase 3). Direct pairs enter
 * with their Fisher-information weight, fallback pairs as the weaker labeled point prior, quarantined
 * pairs not at all. Returns the loadings, the PSD-by-construction matrix, and per-pair evidence built
 * through `pairEvidence` so the recorded gates are the real ones. */
export function fitSignedFactors(sources: SourceEntry[], evidence: FitEvidenceInput[]): SignedFactorFit {
  const order = [...new Set(sources.map((source) => source.underlying))].sort();
  if (order.length !== sources.length || !order.length) throw new Error("signed factor fit requires unique underlyings");
  const index = new Map(order.map((underlying, position) => [underlying, position]));
  const clusters = [...new Set(sources.map((source) => source.cluster))].sort();
  const clusterOf = new Map(sources.map((source) => [source.underlying, source.cluster]));
  const clusterIndex = order.map((underlying) => clusters.indexOf(clusterOf.get(underlying)!));
  const inputs = [...evidence].sort((a, b) => a.pair[0] < b.pair[0] || (a.pair[0] === b.pair[0] && a.pair[1] < b.pair[1]) ? -1 : 1);
  const seen = new Set<string>();
  for (const input of inputs) {
    if (!(input.pair[0] < input.pair[1])) throw new Error(`signed factor fit requires canonical pairs: ${input.pair.join("/")}`);
    if (!index.has(input.pair[0]) || !index.has(input.pair[1])) throw new Error(`signed factor fit received an unknown underlying: ${input.pair.join("/")}`);
    const key = input.pair.join("\0");
    if (seen.has(key)) throw new Error(`signed factor fit requires each pair at most once: ${input.pair.join("/")}`);
    seen.add(key);
    if (input.evidence === "direct") { correlationValue(input.target, "direct target"); reliabilityWeight(input.effectiveN); if (!(input.effectiveN > 3)) throw new Error("direct evidence requires an effective sample size above 3"); }
    if (input.evidence === "fallback") correlationValue(input.target, "fallback target");
  }
  const m = inputs.filter((input) => input.evidence === "direct").length;
  const { vMax } = APPROVED_FIT_POLICY;
  const quarantinedByFit = new Set<string>();
  let g: number[] = [];
  let c: number[] = [];
  let targets: FitTarget[] = [];
  const implied = (left: number, right: number): number => g[left] * g[right] + (clusterIndex[left] === clusterIndex[right] ? c[left] * c[right] : 0);
  for (;;) {
    targets = [];
    for (const input of inputs) {
      if (input.evidence === "quarantined" || quarantinedByFit.has(input.pair.join("\0"))) continue;
      targets.push({ left: index.get(input.pair[0])!, right: index.get(input.pair[1])!, target: input.target, weight: input.evidence === "direct" ? reliabilityWeight(input.effectiveN) : fallbackPrior(input.target).weight });
    }
    ({ g, c } = solveLoadings(order.length, clusterIndex, targets, vMax));
    const failing = inputs.filter((input) => input.evidence === "fallback" && !quarantinedByFit.has(input.pair.join("\0")) && !fallbackGate(implied(index.get(input.pair[0])!, index.get(input.pair[1])!), input.target).passed);
    if (!failing.length) break;
    for (const input of failing) quarantinedByFit.add(input.pair.join("\0"));
  }
  // Canonical factor signs: the first non-zero loading of each factor column is positive.
  const canonicalize = (column: number[], members: number[]): void => {
    const leader = members.find((position) => Math.abs(column[position]) > 1e-9);
    if (leader !== undefined && column[leader] < 0) for (const position of members) column[position] = -column[position];
    for (const position of members) column[position] = column[position] === 0 ? 0 : column[position];
  };
  const everyone = order.map((_, position) => position);
  canonicalize(g, everyone);
  for (let cluster = 0; cluster < clusters.length; cluster++) canonicalize(c, everyone.filter((position) => clusterIndex[position] === cluster));
  const u = order.map((_, position) => Math.sqrt(Math.max(0, vMax - g[position] ** 2 - c[position] ** 2)));
  const loadings: CorrelationArtifact["clusters"] = {};
  for (const cluster of clusters) loadings[cluster] = {};
  order.forEach((underlying, position) => { loadings[clusterOf.get(underlying)!][underlying] = { global: g[position], cluster: c[position], underlying: u[position], underlyingBasis: "structural-underlying" }; });
  // R = B * transpose(B) + D with one global, one column per cluster, and one column per underlying.
  const width = 1 + clusters.length + order.length;
  const B = order.map((_, position) => { const row = new Array<number>(width).fill(0); row[0] = g[position]; row[1 + clusterIndex[position]] = c[position]; row[1 + clusters.length + position] = u[position]; return row; });
  const D = B.map((row) => 1 - row.reduce((sum, value) => sum + value * value, 0));
  const matrix = B.map((left, row) => B.map((right, column) => left.reduce((sum, value, k) => sum + value * right[k], 0) + (row === column ? D[row] : 0)));
  // Independent invariant checks (math section 15): an implementation defect fails closed here.
  if (![...g, ...c, ...u].every(Number.isFinite) || D.some((value) => !(value >= -GATE_TOLERANCE))) throw new Error("signed factor fit produced non-finite loadings or negative residual variance");
  finiteSquare(matrix);
  if (matrix.some((row, position) => Math.abs(row[position] - 1) > GATE_TOLERANCE) || !isPsd(matrix)) throw new Error("signed factor fit failed unit-diagonal or PSD verification");
  cholesky(matrix);
  const records = inputs.map((input): PairEvidenceRecord => {
    const { pair } = input;
    if (input.evidence === "quarantined") return pairEvidence(input);
    const fitted = implied(index.get(pair[0])!, index.get(pair[1])!);
    if (input.evidence === "direct") return pairEvidence({ ...input, fitted, m });
    if (quarantinedByFit.has(pair.join("\0"))) return pairEvidence({ evidence: "quarantined", pair, reason: "fallback-residual-out-of-range", target: input.target, fitted });
    return pairEvidence({ evidence: "fallback", pair, target: input.target, fitted });
  });
  const objective = targets.reduce((sum, { left, right, target, weight }) => sum + weight * (implied(left, right) - target) ** 2, 0);
  return { order, loadings, matrix, pairEvidence: records, objective, passed: records.every((record) => record.evidence !== "direct" || record.gate.passed) };
}

function fisherMean(estimates: PairEstimate[]): number | null {
  let weighted = 0;
  let totalWeight = 0;
  for (const estimate of estimates) {
    if (!estimate.eligible) continue;
    const weight = estimate.effectiveN - 3;
    if (!(weight > 0)) continue;
    const correlation = Math.max(-1 + 1e-15, Math.min(1 - 1e-15, estimate.correlation));
    weighted += weight * Math.atanh(correlation);
    totalWeight += weight;
  }
  return totalWeight ? Math.tanh(weighted / totalWeight) : null;
}

export function structuredTargets(estimates: PairEstimate[], sources: SourceEntry[]): { global: number; clusters: Record<string, number> } {
  const byUnderlying = new Map(sources.map((source) => [source.underlying, source]));
  const cross = estimates.filter((estimate) => byUnderlying.get(estimate.pair[0])?.cluster !== byUnderlying.get(estimate.pair[1])?.cluster);
  const global = fisherMean(cross) ?? 0;
  const clusters: Record<string, number> = {};
  for (const cluster of [...new Set(sources.map((source) => source.cluster))].sort()) {
    const within = estimates.filter((estimate) => byUnderlying.get(estimate.pair[0])?.cluster === cluster && byUnderlying.get(estimate.pair[1])?.cluster === cluster);
    clusters[cluster] = fisherMean(within) ?? global;
  }
  return { global, clusters };
}

export function shrinkPair(estimate: Pick<PairEstimate, "correlation" | "effectiveN">, target: number): number {
  const lambda = shrinkLambda(estimate, target);
  return (1 - lambda) * estimate.correlation + lambda * target;
}

export function shrinkLambda(estimate: Pick<PairEstimate, "correlation" | "effectiveN">, target: number): number {
  const variance = (1 - estimate.correlation * estimate.correlation) ** 2 / Math.max(1, estimate.effectiveN - 1);
  const denominator = Math.max(variance, (estimate.correlation - target) ** 2);
  return denominator === 0 ? 1 : Math.max(0, Math.min(1, variance / denominator));
}

function eigendecompose(matrix: number[][]): { values: number[]; vectors: number[][] } {
  finiteSquare(matrix);
  const size = matrix.length;
  const values = matrix.map((row) => [...row]);
  const vectors: number[][] = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => row === column ? 1 : 0));
  for (let iteration = 0; iteration < Math.max(1, 100 * size * size); iteration++) {
    let p = 0;
    let q = 0;
    let largest = 0;
    for (let row = 0; row < size; row++) for (let column = row + 1; column < size; column++) {
      const magnitude = Math.abs(values[row][column]);
      if (magnitude > largest) { largest = magnitude; p = row; q = column; }
    }
    if (largest <= 1e-14) return { values: values.map((row, index) => row[index]), vectors };
    const angle = 0.5 * Math.atan2(2 * values[p][q], values[q][q] - values[p][p]);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const pp = values[p][p];
    const qq = values[q][q];
    const pq = values[p][q];
    values[p][p] = cosine * cosine * pp - 2 * sine * cosine * pq + sine * sine * qq;
    values[q][q] = sine * sine * pp + 2 * sine * cosine * pq + cosine * cosine * qq;
    values[p][q] = 0;
    values[q][p] = 0;
    for (let index = 0; index < size; index++) {
      if (index !== p && index !== q) {
        const ip = values[index][p];
        const iq = values[index][q];
        values[index][p] = values[p][index] = cosine * ip - sine * iq;
        values[index][q] = values[q][index] = sine * ip + cosine * iq;
      }
      const vectorP = vectors[index][p];
      const vectorQ = vectors[index][q];
      vectors[index][p] = cosine * vectorP - sine * vectorQ;
      vectors[index][q] = sine * vectorP + cosine * vectorQ;
    }
  }
  throw new Error("Jacobi eigendecomposition did not converge");
}

function projectPsd(matrix: number[][]): number[][] {
  const { values, vectors } = eigendecompose(matrix);
  return matrix.map((_, row) => matrix.map((__, column) => values.reduce((sum, value, index) => sum + vectors[row][index] * Math.max(EIGEN_FLOOR, value) * vectors[column][index], 0)));
}

const frobenius = (matrix: number[][]): number => Math.sqrt(matrix.reduce((sum, row) => sum + row.reduce((inner, value) => inner + value * value, 0), 0));

export function nearestCorrelationResult(matrix: number[][]): { matrix: number[][]; delta: number } {
  finiteSquare(matrix);
  let current = matrix.map((row) => [...row]);
  let correction = matrix.map((row) => row.map(() => 0));
  for (let iteration = 0; iteration < 1_000; iteration++) {
    const residual = current.map((row, i) => row.map((value, j) => value - correction[i][j]));
    const psd = projectPsd(residual);
    correction = psd.map((row, i) => row.map((value, j) => value - residual[i][j]));
    const next = psd.map((row, i) => row.map((value, j) => i === j ? 1 : value));
    const delta = frobenius(next.map((row, i) => row.map((value, j) => value - current[i][j])));
    current = next;
    if (delta <= 1e-10) {
      finiteSquare(current);
      if (current.some((row, index) => Math.abs(row[index] - 1) > 1e-12) || !isPsd(current)) throw new Error("nearest correlation projection failed validation");
      return { matrix: current, delta };
    }
  }
  throw new Error("nearest correlation projection did not converge after 1000 iterations");
}

export function nearestCorrelation(matrix: number[][]): number[][] { return nearestCorrelationResult(matrix).matrix; }

export function isPsd(matrix: number[][], tolerance = 1e-10): boolean {
  try {
    return eigendecompose(matrix).values.every((value) => value >= -tolerance);
  } catch {
    return false;
  }
}

export function cholesky(matrix: number[][]): number[][] {
  finiteSquare(matrix);
  const lower = matrix.map((row) => row.map(() => 0));
  for (let row = 0; row < matrix.length; row++) {
    for (let column = 0; column <= row; column++) {
      let value = matrix[row][column];
      for (let index = 0; index < column; index++) value -= lower[row][index] * lower[column][index];
      if (row === column) {
        if (value < -1e-10) throw new Error("matrix is not positive semidefinite");
        lower[row][column] = Math.sqrt(Math.max(0, value));
      } else if (lower[column][column] > 0) lower[row][column] = value / lower[column][column];
      else if (Math.abs(value) > 1e-10) throw new Error("matrix is not positive semidefinite");
    }
  }
  return lower;
}
