import { test } from "node:test";
import assert from "node:assert/strict";
import { jointProbability, normCdf, normInv, type FactorNode } from "../src/copula.js";

/** Leg with no factor loadings at all — pure idiosyncratic noise. */
function indepLeg(p: number, bullish = true) {
  return { threshold: normInv(1 - p), sign: (bullish ? 1 : -1) as 1 | -1, loadings: [0] };
}

/** Leg fully loaded on the single (root) factor: correlation ~1 with its siblings. */
function lockstepLeg(p: number, bullish = true) {
  return { threshold: normInv(1 - p), sign: (bullish ? 1 : -1) as 1 | -1, loadings: [0.999] };
}

function flat(legs: ReturnType<typeof indepLeg>[]): FactorNode {
  return { legs, children: [] };
}

test("normCdf matches known values", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-12);
  assert.ok(Math.abs(normCdf(1.96) - 0.9750021048517796) < 1e-12);
  assert.ok(Math.abs(normCdf(-1.96) - 0.0249978951482204) < 1e-12);
  assert.ok(Math.abs(normCdf(-8) - 6.220960574271786e-16) < 1e-18);
});

test("normInv is the inverse of normCdf", () => {
  for (const p of [1e-6, 0.001, 0.132, 0.5, 0.44, 0.9, 0.999, 1 - 1e-6]) {
    assert.ok(Math.abs(normCdf(normInv(p)) - p) < 1e-9, `p=${p}`);
  }
});

test("zero loadings reproduce the independent product to 1e-9", () => {
  const ps = [0.5, 0.132, 0.44];
  const got = jointProbability(flat(ps.map((p) => indepLeg(p))));
  const want = ps.reduce((a, p) => a * p, 1);
  assert.ok(Math.abs(got - want) < 1e-9, `got ${got}, want ${want}`);
});

test("zero loadings, nested tree, still reproduces the product", () => {
  const tree: FactorNode = {
    legs: [indepLeg(0.5)],
    children: [{ legs: [indepLeg(0.132), indepLeg(0.44)], children: [] }],
  };
  const got = jointProbability(tree);
  assert.ok(Math.abs(got - 0.5 * 0.132 * 0.44) < 1e-9, `got ${got}`);
});

test("correlation 1, same stance, gives min(p) — the upper Frechet bound", () => {
  const got = jointProbability(flat([lockstepLeg(0.3), lockstepLeg(0.7)]));
  assert.ok(Math.abs(got - 0.3) < 1e-3, `got ${got}`);
});

test("correlation 1, opposite stance, gives max(0, p1+p2-1) — the lower bound", () => {
  const both = jointProbability(flat([lockstepLeg(0.7), lockstepLeg(0.6, false)]));
  assert.ok(Math.abs(both - 0.3) < 1e-3, `got ${both}`);
  const impossible = jointProbability(flat([lockstepLeg(0.3), lockstepLeg(0.6, false)]));
  assert.ok(impossible < 1e-3, `got ${impossible}`);
});

/** The regression test for the quadrature defect that killed the first attempt:
 * a plain Gauss-Legendre rule over [-8,8] returns 0.494 / 0.467 / 0.440 at
 * 32 / 48 / 96 nodes here — diverging. The converged value is 0.4399. */
test("resolves a near-step integrand: two legs sharing an underlying", () => {
  const strong = (p: number): ReturnType<typeof indepLeg> => ({
    threshold: normInv(1 - p),
    sign: 1,
    loadings: [0.3, 0.9, 0.29],
  });
  const tree: FactorNode = {
    legs: [],
    children: [{ legs: [], children: [{ legs: [strong(0.5), strong(0.45)], children: [] }] }],
  };
  const got = jointProbability(tree);
  assert.ok(Math.abs(got - 0.43991) < 1e-4, `got ${got}, want ~0.43991`);
});

test("joint rises with correlation for same-stance legs", () => {
  const at = (load: number) =>
    jointProbability(
      flat([
        { threshold: normInv(1 - 0.132), sign: 1, loadings: [load] },
        { threshold: normInv(1 - 0.44), sign: 1, loadings: [load] },
      ]),
    );
  const [a, b, c] = [at(0), at(0.5), at(0.9)];
  assert.ok(a < b && b < c, `${a} ${b} ${c}`);
});

test("joint falls with correlation for opposite-stance legs", () => {
  const at = (load: number) =>
    jointProbability(
      flat([
        { threshold: normInv(1 - 0.132), sign: 1, loadings: [load] },
        { threshold: normInv(1 - 0.56), sign: -1, loadings: [load] },
      ]),
    );
  const [a, b, c] = [at(0), at(0.5), at(0.9)];
  assert.ok(a > b && b > c, `${a} ${b} ${c}`);
});

test("bivariate normal orthant matches a published reference value", () => {
  // P(Z1 > 0, Z2 > 0) with rho = 0.5 is 1/4 + arcsin(0.5)/(2*pi) = 0.333333...
  const got = jointProbability(
    flat([
      { threshold: 0, sign: 1, loadings: [Math.sqrt(0.5)] },
      { threshold: 0, sign: 1, loadings: [Math.sqrt(0.5)] },
    ]),
  );
  const want = 0.25 + Math.asin(0.5) / (2 * Math.PI);
  assert.ok(Math.abs(got - want) < 1e-6, `got ${got}, want ${want}`);
});
