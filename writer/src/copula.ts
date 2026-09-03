/** Gaussian factor copula: joint probabilities for correlated binary outcomes.
 *
 * Pure math — no markets, no money, no bigints. Every leg is reduced to a
 * threshold on a latent standard normal built from shared factors, so the
 * marginal probability that produced the threshold is preserved exactly and
 * only the dependence between legs is modelled here.
 *
 * Floating point throughout: the inputs are order-book estimates, so exact
 * arithmetic would buy nothing. The caller converts at the boundary. */

/** Gauss-Legendre nodes inside each panel. */
export const PANEL_NODES = 8;

/** Integration half-width in standard deviations. Beyond 8 the normal density
 * contributes below 1e-15. */
const HALF_WIDTH = 8;

/** Panel counts we precompute grids for, coarsest first. */
const PANEL_COUNTS = [8, 12, 16, 24, 32] as const;

/** Upper-tail probability 1 - Phi(x) for x >= 0, via the West/Hart rational
 * form — accurate to 2.2e-16 across [0, 8]. Kept separate from normCdf so the
 * tiny tail value for very negative x can be returned directly: routing it
 * through "1 - (1 - tail)" would round-trip through a double near 1.0, whose
 * ULP (2.22e-16) is larger than tails beyond about x=8 and silently eats the
 * value's precision. */
function upperTail(x: number): number {
  const e = Math.exp((-x * x) / 2);
  if (x < 7.07106781186547) {
    let b = 3.52624965998911e-2 * x + 0.700383064443688;
    b = b * x + 6.37396220353165;
    b = b * x + 33.912866078383;
    b = b * x + 112.079291497871;
    b = b * x + 221.213596169931;
    b = b * x + 220.206867912376;
    let c = 8.83883476483184e-2 * x + 1.75566716318264;
    c = c * x + 16.064177579207;
    c = c * x + 86.7807322029461;
    c = c * x + 296.564248779674;
    c = c * x + 637.333633378831;
    c = c * x + 793.826512519948;
    c = c * x + 440.413735824752;
    return (e * b) / c;
  }
  const b = x + 1 / (x + 2 / (x + 3 / (x + 4 / (x + 0.65))));
  return e / (b * Math.sqrt(2 * Math.PI));
}

/** West/Hart rational approximation — accurate to 2.2e-16 across [-8, 8].
 *
 * The cheaper Abramowitz & Stegun 26.2.17 form is deliberately NOT used: at
 * 7.5e-8 it puts a visible kink at x = 0 (its polynomial coefficients sum to
 * 1 only to ~5e-10), which shows up as a ~1e-9 floor on every round trip
 * through normInv and makes the independence assertion marginal. */
export function normCdf(x: number): number {
  return x < 0 ? upperTail(-x) : 1 - upperTail(x);
}

/** Acklam's inverse normal CDF, refined by two Halley steps against normCdf.
 * The refinement is what carries it to a round-trip error near machine
 * epsilon; Acklam alone is only good to ~1e-9. */
export function normInv(p: number): number {
  if (!(p > 0) || !(p < 1)) throw new Error(`normInv out of range: ${p}`);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  let x: number;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  for (let i = 0; i < 2; i++) {
    const e = normCdf(x) - p;
    const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
    x = x - u / (1 + (x * u) / 2);
  }
  return x;
}

function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Gauss-Legendre nodes and weights on [-1,1] by Newton iteration on P_n. */
function gaussLegendre(n: number): { nodes: number[]; weights: number[] } {
  const nodes: number[] = [];
  const weights: number[] = [];
  for (let i = 1; i <= n; i++) {
    let x = Math.cos((Math.PI * (i - 0.25)) / (n + 0.5));
    let dp = 0;
    for (let iter = 0; iter < 100; iter++) {
      let p0 = 1;
      let p1 = 0;
      for (let j = 1; j <= n; j++) {
        const p2 = p1;
        p1 = p0;
        p0 = ((2 * j - 1) * x * p1 - (j - 1) * p2) / j;
      }
      dp = (n * (x * p0 - p1)) / (x * x - 1);
      const dx = -p0 / dp;
      x += dx;
      if (Math.abs(dx) < 1e-15) break;
    }
    nodes.push(x);
    weights.push(2 / ((1 - x * x) * dp * dp));
  }
  return { nodes, weights };
}

/** Composite rule for the integral of f(z)*phi(z) dz: [-8,8] split into equal
 * panels with an 8-node Gauss-Legendre rule inside each.
 *
 * A single Gauss-Legendre rule over the whole interval does NOT work. Its
 * nodes cluster at the ends, and the integrand here is a near-step function
 * in the middle whenever a leg's idiosyncratic sigma is small next to its
 * loading — the transition is only about sigma/loading wide. Measured on a
 * real two-leg same-underlying case, the single-rule version returned 0.494,
 * 0.467 and 0.440 at 32, 48 and 96 nodes: diverging. Uniform panels give
 * uniform resolution, and the integrand is smooth within a panel. */
function buildGrid(panels: number): { z: number[]; w: number[] } {
  const { nodes, weights } = gaussLegendre(PANEL_NODES);
  const z: number[] = [];
  const w: number[] = [];
  const h = (2 * HALF_WIDTH) / panels;
  for (let panel = 0; panel < panels; panel++) {
    const mid = -HALF_WIDTH + panel * h + h / 2;
    for (let i = 0; i < nodes.length; i++) {
      const point = mid + (nodes[i] * h) / 2;
      z.push(point);
      w.push(((weights[i] * h) / 2) * normPdf(point));
    }
  }
  return { z, w };
}

const GRIDS = new Map(PANEL_COUNTS.map((p) => [p, buildGrid(p)]));

/** Panels needed to resolve a transition of width sigma/loading: enough that
 * several panels land inside it. Clamped to the precomputed set — the coarsest
 * is plenty for a smooth integrand, the finest is where cost stops being worth
 * it.
 *
 * `minSigma` is the residual sigma AT THIS LEVEL, not the leg's final
 * idiosyncratic sigma: at an outer level the deeper integrations smooth the
 * integrand too, so the transition there is wider and a fine grid buys
 * nothing while its cost multiplies through every level below. */
function gridFor(maxLoading: number, minSigma: number): { z: number[]; w: number[] } {
  // ponytail: floors minSigma at 1e-6 instead of throwing on ~0 (only reachable
  // via the residualSigma clamp below, i.e. an already-invalid leg). Same
  // ceiling and upgrade path as residualSigma.
  const want = Math.ceil((PANEL_NODES * maxLoading) / Math.max(minSigma, 1e-6));
  const panels = PANEL_COUNTS.find((p) => p >= want) ?? PANEL_COUNTS[PANEL_COUNTS.length - 1];
  return GRIDS.get(panels)!;
}

/** One leg, reduced to what the integral needs.
 * `threshold` is Phi^-1(1 - p); the leg wins when sign * latent > threshold.
 * `loadings[k]` is the leg's loading on the factor at tree depth k, outermost
 * first, for every level from the root down to the node it hangs off. */
export interface FactorLeg {
  threshold: number;
  sign: 1 | -1;
  loadings: number[];
}

/** A factor in the tree. `legs` hang directly off this factor — they share
 * every factor from the root down to here and nothing deeper. */
export interface FactorNode {
  legs: FactorLeg[];
  children: FactorNode[];
}

/** Sigma of everything still unresolved once the factors down to `depth` are
 * fixed: the leg's own noise plus every factor deeper than this level. That is
 * the width the integrand at this level actually transitions over, because the
 * deeper levels are integrated out inside it. */
function residualSigma(leg: FactorLeg, depth: number): number {
  let explained = 0;
  for (let k = 0; k <= depth && k < leg.loadings.length; k++) explained += leg.loadings[k] * leg.loadings[k];
  // ponytail: floors at 1e-12 instead of throwing when loadings' squares sum
  // to >= 1 (zero or negative idiosyncratic variance — a physically invalid
  // factor structure). Safe today because every caller in this repo builds
  // loadings itself and keeps them under 1; validate and throw here, or at
  // FactorLeg construction, once an untrusted caller can set loadings.
  return Math.sqrt(Math.max(1 - explained, 1e-12));
}

/** The leg's idiosyncratic sigma: residual once every factor it loads on is
 * fixed. This is the divisor in the conditional marginal, always. */
function idioOf(leg: FactorLeg): number {
  return residualSigma(leg, leg.loadings.length - 1);
}

function collectLegs(node: FactorNode): FactorLeg[] {
  return node.legs.concat(...node.children.map(collectLegs));
}

/** The grid this node's own factor gets, or null when nothing hangs below it. */
function gridForNode(node: FactorNode, depth: number): { z: number[]; w: number[] } | null {
  const subtree = collectLegs(node);
  if (subtree.length === 0) return null;
  const maxLoading = subtree.reduce((m, l) => Math.max(m, Math.abs(l.loadings[depth] ?? 0)), 0);
  const minSigma = subtree.reduce((m, l) => Math.min(m, residualSigma(l, depth)), 1);
  return gridFor(maxLoading, minSigma);
}

/** Quadrature points the whole tree visits: a node's grid runs once per point
 * of every grid above it, so the cost multiplies down the levels. */
function quadratureCost(node: FactorNode, depth: number, outer: number): number {
  const grid = gridForNode(node, depth);
  if (grid === null) return 0;
  const here = outer * grid.z.length;
  return node.children.reduce((sum, c) => sum + quadratureCost(c, depth + 1, here), here);
}

/** Ceiling on quadratureCost. The integral runs in CorrelationWorker under a
 * one-second task timeout, so a ticket past this budget would not price
 * slowly, it would time out and take the worker's queue with it. A ticket the
 * house cannot price in bounded time is refused up front instead.
 *
 * Measured here at ~45ns per point, so 4e6 is ~180ms per quote (one point-
 * model integration). That admits every shape the current registry can build
 * — the most expensive is all seven live markets with BTC, BTC and ETH in one
 * cluster, at 3.17e6 — and refuses the ten-leg two-per-underlying tickets that
 * cost 1.6e7 and seconds of wall clock.
 *
 * ponytail: a flat budget with a hard refusal, not an adaptive coarsening.
 * Coarsening silently trades accuracy on a money path. */
const MAX_QUADRATURE_POINTS = 4_000_000;

/** Thrown when the factor tree would cost more than MAX_QUADRATURE_POINTS. */
export class TooComplexError extends Error {
  constructor(readonly cost: number) {
    super(`parlay too complex to price: ${cost} quadrature points, max ${MAX_QUADRATURE_POINTS}`);
    this.name = "TooComplexError";
  }
}

/** P(every leg in the tree wins).
 *
 * `carried` is the running sum of ancestor-factor contributions to each leg's
 * latent score, threaded down the recursion. At a node we integrate that
 * node's factor: for each quadrature point the legs hanging here become
 * conditionally independent (their remaining randomness is idiosyncratic), and
 * the children are conditionally independent of each other, so both multiply.
 *
 * Throws TooComplexError rather than blocking the event loop for seconds. */
export function jointProbability(root: FactorNode): number {
  const cost = quadratureCost(root, 0, 1);
  if (cost > MAX_QUADRATURE_POINTS) throw new TooComplexError(cost);
  return integrate(root, new Map(), 0);
}

function integrate(node: FactorNode, carried: Map<FactorLeg, number>, depth: number): number {
  const grid = gridForNode(node, depth);
  if (grid === null) return 1;
  let total = 0;
  for (let q = 0; q < grid.z.length; q++) {
    const f = grid.z[q];
    let product = 1;
    for (const leg of node.legs) {
      const mean = (carried.get(leg) ?? 0) + (leg.loadings[depth] ?? 0) * f;
      const idio = idioOf(leg);
      // Leg wins when sign * latent > threshold.
      product *=
        leg.sign === 1
          ? 1 - normCdf((leg.threshold - mean) / idio)
          : normCdf((-leg.threshold - mean) / idio);
      if (product === 0) break;
    }
    if (product > 0) {
      for (const child of node.children) {
        const next = new Map(carried);
        for (const leg of collectLegs(child)) {
          next.set(leg, (carried.get(leg) ?? 0) + (leg.loadings[depth] ?? 0) * f);
        }
        product *= integrate(child, next, depth + 1);
        if (product === 0) break;
      }
    }
    total += grid.w[q] * product;
  }
  return Math.min(Math.max(total, 0), 1);
}
