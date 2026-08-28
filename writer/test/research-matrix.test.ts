import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cholesky,
  isPsd,
  nearestCorrelation,
  shrinkPair,
  structuredTargets,
  weightedCorrelation,
} from "../src/research/matrix.js";
import type { SourceEntry } from "../src/research/types.js";

const close = (actual: number, expected: number, tolerance = 1e-12): void => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
};

const source = (underlying: string, cluster: SourceEntry["cluster"]): SourceEntry => ({
  schemaVersion: 1,
  underlying,
  sourceNetwork: "mainnet",
  sourceCoin: underlying,
  cluster,
  calendar: "continuous",
  eligible: true,
  fallbackEligible: false,
});

test("weighted correlation uses 45-day half-life weights and effective sample size", () => {
  const asOfMs = Date.parse("2026-08-28T00:00:00.000Z");
  const day = 86_400_000;
  const result = weightedCorrelation([
    { timestampMs: asOfMs, a: 1, b: 1 },
    { timestampMs: asOfMs - 45 * day, a: 2, b: 4 },
    { timestampMs: asOfMs - 90 * day, a: 4, b: 2 },
  ], 45, asOfMs);
  close(result.correlation, 0.42365927286816174);
  close(result.effectiveN, 2.3333333333333335);
});

test("structured shrinkage uses Fisher targets and the exact scalar formula", () => {
  const sources = [source("A", "crypto"), source("B", "crypto"), source("C", "equity"), source("D", "equity"), source("E", "commodity")];
  const targets = structuredTargets([
    { pair: ["A", "B"], correlation: 0.5, effectiveN: 13, eligible: true },
    { pair: ["C", "D"], correlation: -0.2, effectiveN: 8, eligible: true },
    { pair: ["A", "C"], correlation: 0.2, effectiveN: 13, eligible: true },
    { pair: ["A", "D"], correlation: -0.4, effectiveN: 8, eligible: true },
  ], sources);
  close(targets.global, -0.0060611998011011956);
  close(targets.clusters.crypto, 0.5);
  close(targets.clusters.equity, -0.2);
  close(targets.clusters.commodity, targets.global);
  close(shrinkPair({ correlation: 0.6, effectiveN: 11 }, 0.2), 0.4976);
  close(shrinkPair({ correlation: 1, effectiveN: 11 }, 1), 1);
});

test("nearest correlation projects a known indefinite matrix with Higham Dykstra iterations", () => {
  const projected = nearestCorrelation([
    [1, 1, 1],
    [1, 1, -1],
    [1, -1, 1],
  ]);
  const expected = [
    [1, 0.49999999995, 0.49999999995],
    [0.49999999995, 1, -0.49999999995],
    [0.49999999995, -0.49999999995, 1],
  ];
  for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) close(projected[row][column], expected[row][column], 2e-9);
  assert.equal(isPsd(projected), true);
});

test("Cholesky reconstructs a positive definite matrix", () => {
  const matrix = [[1, 0.3, 0.2], [0.3, 1, 0.4], [0.2, 0.4, 1]];
  const lower = cholesky(matrix);
  for (let row = 0; row < matrix.length; row++) {
    for (let column = 0; column < matrix.length; column++) {
      let reconstructed = 0;
      for (let k = 0; k < matrix.length; k++) reconstructed += (lower[row][k] ?? 0) * (lower[column][k] ?? 0);
      close(reconstructed, matrix[row][column], 1e-10);
    }
  }
});
