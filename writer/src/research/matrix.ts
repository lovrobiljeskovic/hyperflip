import type { SourceEntry } from "./types.js";

const DAY_MS = 86_400_000;
const EIGEN_FLOOR = 1e-10;

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
