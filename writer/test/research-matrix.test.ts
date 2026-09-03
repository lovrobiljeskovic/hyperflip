import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cholesky,
  directGate,
  fallbackGate,
  fallbackPrior,
  fisherInterval,
  fitSignedFactors,
  isPsd,
  nearestCorrelation,
  pairEvidence,
  reliabilityWeight,
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
  sourceNetwork: "testnet",
  sourceCoin: underlying,
  cluster,
  calendar: "continuous",
  measurementEnabled: true,
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

test("Fisher intervals use Kish effective sample size and Bonferroni-adjusted 95% coverage", () => {
  // Reference bounds from python3 statistics.NormalDist().inv_cdf (z_0.975 = 1.9599639845400534).
  const zero = fisherInterval(0, 403, 6);
  close(zero.lower, -0.09768568630528413, 1e-9);
  close(zero.upper, 0.09768568630528413, 1e-9);
  close(zero.adjustedLower, -0.13115301336047297, 1e-9);
  close(zero.adjustedUpper, 0.13115301336047297, 1e-9);
  assert.equal(zero.m, 6);
  const negative = fisherInterval(-0.3, 103, 1);
  close(negative.lower, -0.46644413153204434, 1e-9);
  close(negative.upper, -0.11303802922252026, 1e-9);
  assert.equal(negative.adjustedLower, negative.lower, "m = 1 leaves the interval unadjusted");
  assert.equal(negative.adjustedUpper, negative.upper);
  const rail = fisherInterval(0.999, 10, 4);
  close(rail.lower, 0.99560751565668, 1e-9);
  close(rail.upper, 0.9997726369209323, 1e-9);
  close(rail.adjustedLower, 0.9934117456015602, 1e-9);
  close(rail.adjustedUpper, 0.9998485747927066, 1e-9);
  assert.ok(rail.adjustedLower < rail.lower && rail.lower < 0.999 && 0.999 < rail.upper && rail.upper < rail.adjustedUpper && rail.adjustedUpper < 1);
  const barely = fisherInterval(0.2, 3.0001, 1);
  assert.deepEqual([barely.lower, barely.upper, barely.adjustedLower, barely.adjustedUpper], [-1, 1, -1, 1], "an effective sample just above 3 saturates to the rails but still nests");
  assert.deepEqual(fisherInterval(0.42, 57, 3), fisherInterval(0.42, 57, 3));
  for (const [correlation, effectiveN, m] of [[1, 50, 1], [-1, 50, 1], [Number.NaN, 50, 1], [0.2, 3, 1], [0.2, 2.5, 1], [0.2, Number.POSITIVE_INFINITY, 1], [0.2, 50, 0], [0.2, 50, 1.5]] as const) {
    assert.throws(() => fisherInterval(correlation, effectiveN, m), `${correlation} ${effectiveN} ${m}`);
  }
  assert.throws(() => fisherInterval(0.2, 50, 1, 1));
});

test("reliability weights and fallback priors follow the approved policy", () => {
  assert.equal(reliabilityWeight(2), 1);
  assert.equal(reliabilityWeight(103), 100);
  assert.throws(() => reliabilityWeight(Number.NaN));
  assert.throws(() => reliabilityWeight(0));
  assert.deepEqual(fallbackPrior(0.4), { target: 0.4, weight: 30, lower: 0.25, upper: 0.55 });
  assert.throws(() => fallbackPrior(1.2));
  assert.throws(() => fallbackPrior(Number.NaN));
});

test("direct and fallback residual gates are pure and match the approved thresholds", () => {
  const wide = fisherInterval(0.3, 103, 1);
  assert.deepEqual(directGate(0.35, 0.3, wide), { passed: true, reason: "direct-residual-and-fisher" });
  assert.deepEqual(directGate(0.25, 0.3, wide), { passed: true, reason: "direct-residual-and-fisher" });
  assert.deepEqual(directGate(0.3500001, 0.3, wide), { passed: false, reason: "direct-residual-out-of-range" });
  const tight = fisherInterval(0.5, 100_003, 1);
  assert.deepEqual(directGate(0.52, 0.5, tight), { passed: false, reason: "direct-outside-fisher-interval" });
  assert.deepEqual(directGate(-0.04, 0, fisherInterval(0, 403, 6)), { passed: true, reason: "direct-residual-and-fisher" });
  assert.throws(() => directGate(Number.NaN, 0.3, wide));
  assert.deepEqual(fallbackGate(0.55, 0.4), { passed: true, reason: "fallback-residual-range" });
  assert.deepEqual(fallbackGate(-0.1, 0.05), { passed: true, reason: "fallback-residual-range" });
  assert.deepEqual(fallbackGate(0.5500001, 0.4), { passed: false, reason: "fallback-residual-out-of-range" });
  assert.throws(() => fallbackGate(0.4, Number.POSITIVE_INFINITY));
});

test("pair evidence records are built from real effective sample sizes and gates", () => {
  const direct = pairEvidence({ evidence: "direct", pair: ["BTC", "ETH"], mode: "hourly", target: 0.72, effectiveN: 2_749, fitted: 0.7, m: 3 });
  assert.equal(direct.weight, 2_746);
  assert.equal(direct.effectiveN, 2_749);
  assert.deepEqual(direct.interval, fisherInterval(0.72, 2_749, 3));
  close(direct.residual!, -0.02);
  assert.deepEqual(direct.gate, { passed: true, reason: "direct-residual-and-fisher" });
  assert.equal(JSON.stringify(direct), JSON.stringify(pairEvidence({ evidence: "direct", pair: ["BTC", "ETH"], mode: "hourly", target: 0.72, effectiveN: 2_749, fitted: 0.7, m: 3 })));
  const fallback = pairEvidence({ evidence: "fallback", pair: ["BTC", "GOLD"], target: 0.1, fitted: 0.3 });
  assert.deepEqual(fallback, { pair: ["BTC", "GOLD"], evidence: "fallback", mode: null, effectiveN: null, weight: 30, target: 0.1, interval: null, fitted: 0.3, residual: 0.3 - 0.1, gate: { passed: false, reason: "fallback-residual-out-of-range" } });
  const quarantined = pairEvidence({ evidence: "quarantined", pair: ["BTC", "GOLD"], reason: "fallback-residual-out-of-range", target: 0.1, fitted: 0.3 });
  assert.deepEqual(quarantined, { pair: ["BTC", "GOLD"], evidence: "quarantined", mode: null, effectiveN: null, weight: 0, target: 0.1, interval: null, fitted: 0.3, residual: 0.3 - 0.1, gate: { passed: false, reason: "fallback-residual-out-of-range" } });
  assert.deepEqual(pairEvidence({ evidence: "quarantined", pair: ["A", "B"], reason: "ineligible-source" }).residual, null);
  assert.throws(() => pairEvidence({ evidence: "quarantined", pair: ["A", "B"], reason: "x", target: 0.1 }));
  assert.throws(() => pairEvidence({ evidence: "direct", pair: ["ETH", "BTC"], mode: "hourly", target: 0.72, effectiveN: 2_749, fitted: 0.7, m: 3 }));
  assert.throws(() => pairEvidence({ evidence: "direct", pair: ["BTC", "ETH"], mode: "hourly", target: 1, effectiveN: 2_749, fitted: 0.7, m: 3 }));
  assert.throws(() => pairEvidence({ evidence: "direct", pair: ["BTC", "ETH"], mode: "daily", target: 0.5, effectiveN: 3, fitted: 0.5, m: 1 }));
});

// The six measured crypto pairs the legacy hierarchical fitter flattened to 0.212225
// (docs/research/testnet-correlation-multivariate-improvements.md, evidence 1).
const SIX_PAIRS: [string, string, number][] = [
  ["BTC", "ETH", 0.4820301407807348],
  ["BTC", "HYPE", -0.035233305987373204],
  ["BTC", "SOL", 0.38379767563644],
  ["ETH", "HYPE", -0.007088306614043628],
  ["ETH", "SOL", 0.40257857652651635],
  ["HYPE", "SOL", 0.006721482766762755],
];
const cryptoSources = ["BTC", "ETH", "HYPE", "SOL"].map((underlying) => source(underlying, "crypto"));
const sixDirect = SIX_PAIRS.map(([a, b, target]) => ({ evidence: "direct" as const, pair: [a, b] as [string, string], mode: "hourly" as const, target, effectiveN: 2_749 }));

const assertModelInvariants = (fit: ReturnType<typeof fitSignedFactors>, sources: SourceEntry[]): void => {
  const { matrix, order } = fit;
  assert.deepEqual(order, [...sources.map((entry) => entry.underlying)].sort());
  for (let row = 0; row < order.length; row++) {
    close(matrix[row][row], 1);
    for (let column = 0; column < order.length; column++) {
      assert.ok(Number.isFinite(matrix[row][column]));
      assert.equal(matrix[row][column], matrix[column][row]);
    }
  }
  assert.equal(isPsd(matrix), true);
  assert.doesNotThrow(() => cholesky(matrix));
  for (const entries of Object.values(fit.loadings)) for (const loading of Object.values(entries)) {
    assert.ok([loading.global, loading.cluster, loading.underlying].every(Number.isFinite));
    assert.ok(Math.abs(loading.global) <= 1 && Math.abs(loading.cluster) <= 1 && loading.underlying >= 0);
    close(loading.global ** 2 + loading.cluster ** 2 + loading.underlying ** 2, 0.99, 1e-9);
    assert.equal(loading.underlyingBasis, "structural-underlying");
  }
};

test("signed fitter reproduces the six recorded crypto pairs with distinct positive, near-zero, and negative behavior", () => {
  const fit = fitSignedFactors(cryptoSources, sixDirect);
  assertModelInvariants(fit, cryptoSources);
  assert.equal(fit.passed, true);
  assert.equal(fit.pairEvidence.length, 6);
  for (const record of fit.pairEvidence) {
    assert.equal(record.evidence, "direct");
    assert.deepEqual(record.gate, { passed: true, reason: "direct-residual-and-fisher" });
    assert.equal(record.weight, 2_746);
    assert.equal(record.interval!.m, 6);
    assert.ok(Math.abs(record.residual!) <= 0.05);
  }
  const fitted = Object.fromEntries(fit.pairEvidence.map((record) => [record.pair.join("/"), record.fitted!]));
  assert.ok(fitted["BTC/ETH"] > 0.43 && fitted["ETH/SOL"] > 0.35 && fitted["BTC/SOL"] > 0.33, "positive pairs stay positive");
  assert.ok(fitted["BTC/HYPE"] < 0 && Math.abs(fitted["BTC/HYPE"]) < 0.09, "negative pair stays negative");
  assert.ok(Math.abs(fitted["ETH/HYPE"]) < 0.06 && Math.abs(fitted["HYPE/SOL"]) < 0.06, "near-zero pairs stay near zero");
  assert.ok(new Set(Object.values(fitted).map((value) => value.toFixed(3))).size === 6, "no flattening to a single implied value");
  assert.ok(Object.values(fit.loadings.crypto).some((loading) => loading.global < 0 || loading.cluster < 0), "the fit uses a signed loading");
});

test("signed fitter is deterministic and canonical under source, pair, and sign permutations", () => {
  const first = fitSignedFactors(cryptoSources, sixDirect);
  const shuffledSources = [cryptoSources[3], cryptoSources[1], cryptoSources[0], cryptoSources[2]];
  const shuffledPairs = [sixDirect[5], sixDirect[2], sixDirect[0], sixDirect[4], sixDirect[1], sixDirect[3]];
  assert.equal(JSON.stringify(fitSignedFactors(shuffledSources, shuffledPairs)), JSON.stringify(first));
  assert.equal(JSON.stringify(fitSignedFactors(cryptoSources, sixDirect)), JSON.stringify(first));
  const firstGlobal = first.order.map((underlying) => first.loadings.crypto[underlying].global).find((value) => value !== 0);
  const firstCluster = first.order.map((underlying) => first.loadings.crypto[underlying].cluster).find((value) => value !== 0);
  assert.ok(firstGlobal === undefined || firstGlobal > 0, "first non-zero global loading is positive");
  assert.ok(firstCluster === undefined || firstCluster > 0, "first non-zero cluster loading is positive");
  assert.ok(!Object.values(first.loadings.crypto).some((loading) => Object.is(loading.global, -0) || Object.is(loading.cluster, -0)));
});

test("signed fitter weights direct evidence over fallback priors, quarantines out-of-range fallbacks, and refits without them", () => {
  const sources = [source("BTC", "crypto"), source("ETH", "crypto"), source("NVDA", "equity"), source("SP500", "equity"), source("GOLD", "commodity")];
  const fit = fitSignedFactors(sources, [
    { evidence: "direct", pair: ["BTC", "ETH"], mode: "hourly", target: 0.48, effectiveN: 2_749 },
    { evidence: "direct", pair: ["NVDA", "SP500"], mode: "daily", target: 0.68, effectiveN: 403 },
    { evidence: "fallback", pair: ["BTC", "NVDA"], target: 0.09 },
    { evidence: "fallback", pair: ["BTC", "SP500"], target: 0.09 },
    { evidence: "fallback", pair: ["ETH", "NVDA"], target: 0.09 },
    { evidence: "fallback", pair: ["ETH", "SP500"], target: 0.09 },
    { evidence: "fallback", pair: ["GOLD", "NVDA"], target: 0.09 },
    { evidence: "fallback", pair: ["GOLD", "SP500"], target: 0.09 },
    { evidence: "fallback", pair: ["BTC", "GOLD"], target: 0.9 },
    { evidence: "fallback", pair: ["ETH", "GOLD"], target: -0.9 },
  ]);
  assertModelInvariants(fit, sources);
  assert.equal(fit.passed, true);
  assert.equal(fit.pairEvidence.length, 10);
  assert.deepEqual(fit.pairEvidence.map((record) => record.pair), [["BTC", "ETH"], ["BTC", "GOLD"], ["BTC", "NVDA"], ["BTC", "SP500"], ["ETH", "GOLD"], ["ETH", "NVDA"], ["ETH", "SP500"], ["GOLD", "NVDA"], ["GOLD", "SP500"], ["NVDA", "SP500"]]);
  const byPair = Object.fromEntries(fit.pairEvidence.map((record) => [record.pair.join("/"), record]));
  assert.deepEqual(byPair["BTC/ETH"].gate, { passed: true, reason: "direct-residual-and-fisher" });
  assert.equal(byPair["BTC/ETH"].interval!.m, 2);
  close(byPair["BTC/ETH"].fitted!, 0.48, 0.02);
  assert.deepEqual(byPair["NVDA/SP500"].gate, { passed: true, reason: "direct-residual-and-fisher" });
  close(byPair["NVDA/SP500"].fitted!, 0.68, 0.05);
  for (const key of ["BTC/NVDA", "BTC/SP500", "ETH/NVDA", "ETH/SP500", "GOLD/NVDA", "GOLD/SP500"]) {
    assert.equal(byPair[key].evidence, "fallback", key);
    assert.equal(byPair[key].weight, 30, key);
    assert.deepEqual(byPair[key].gate, { passed: true, reason: "fallback-residual-range" }, key);
  }
  // BTC/GOLD +0.9 and ETH/GOLD -0.9 cannot both hold beside BTC/ETH +0.48; the fitter records the
  // offending fallback residuals and quarantines them rather than bending the direct evidence.
  const quarantined = fit.pairEvidence.filter((record) => record.evidence === "quarantined");
  assert.ok(quarantined.length >= 1 && quarantined.every((record) => record.gate.reason === "fallback-residual-out-of-range" && record.weight === 0 && record.target !== null && record.fitted !== null && Math.abs(record.residual!) > 0.15));
  assert.ok(quarantined.some((record) => ["BTC/GOLD", "ETH/GOLD"].includes(record.pair.join("/"))));
});

test("signed fitter fails closed on contradictory direct evidence and passes through input quarantines", () => {
  const sources = [source("A", "crypto"), source("B", "crypto"), source("C", "crypto"), source("D", "equity")];
  const fit = fitSignedFactors(sources, [
    { evidence: "direct", pair: ["A", "B"], mode: "hourly", target: 0.9, effectiveN: 10_003 },
    { evidence: "direct", pair: ["B", "C"], mode: "hourly", target: 0.9, effectiveN: 10_003 },
    { evidence: "direct", pair: ["A", "C"], mode: "hourly", target: -0.9, effectiveN: 10_003 },
    { evidence: "quarantined", pair: ["A", "D"], reason: "ineligible-source" },
    { evidence: "quarantined", pair: ["B", "D"], reason: "ineligible-source" },
    { evidence: "quarantined", pair: ["C", "D"], reason: "ineligible-source" },
  ]);
  assertModelInvariants(fit, sources);
  assert.equal(fit.passed, false);
  const direct = fit.pairEvidence.filter((record) => record.evidence === "direct");
  assert.equal(direct.length, 3);
  assert.ok(direct.some((record) => record.gate.reason === "direct-residual-out-of-range"));
  assert.ok(direct.every((record) => record.interval!.m === 3));
  const passthrough = fit.pairEvidence.filter((record) => record.evidence === "quarantined");
  assert.deepEqual(passthrough.map((record) => [record.pair.join("/"), record.gate.reason, record.weight, record.target, record.fitted]), [["A/D", "ineligible-source", 0, null, null], ["B/D", "ineligible-source", 0, null, null], ["C/D", "ineligible-source", 0, null, null]]);
  assert.deepEqual(fit.loadings.equity.D, { global: 0, cluster: 0, underlying: Math.sqrt(0.99), underlyingBasis: "structural-underlying" });
  assert.throws(() => fitSignedFactors(sources, [{ evidence: "direct", pair: ["B", "A"], mode: "hourly", target: 0.5, effectiveN: 100 }]), /canonical/);
  assert.throws(() => fitSignedFactors(sources, [{ evidence: "direct", pair: ["A", "B"], mode: "hourly", target: 0.5, effectiveN: 100 }, { evidence: "fallback", pair: ["A", "B"], target: 0.5 }]), /once/);
  assert.throws(() => fitSignedFactors(sources, [{ evidence: "direct", pair: ["A", "Z"], mode: "hourly", target: 0.5, effectiveN: 100 }]), /unknown/);
  assert.throws(() => fitSignedFactors(sources, [{ evidence: "direct", pair: ["A", "B"], mode: "hourly", target: 0.5, effectiveN: 3 }]), /effective sample/);
});
