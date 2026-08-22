import { jointProbability, normInv, type FactorLeg, type FactorNode } from "./copula.js";

const WAD = 10n ** 18n;
/** Keeps idiosyncratic variance strictly positive so the latent stays non-degenerate. */
const MAX_EXPLAINED = 0.99;
/** Phi^-1 is unbounded at the ends; book prices can and do arrive at the rail. */
const P_MIN = 1e-6;

export interface Loadings {
  global: number;
  cluster: number;
  underlying: number;
}

export interface CorrelationTable {
  /** Keyed by cluster name — the fallback for an underlying not in the table. */
  defaults: Record<string, Loadings>;
  underlyings: Record<string, Loadings>;
}

export interface CorrLeg {
  /** The market this leg is on. Two legs sharing it are the same event, not
   * two correlated ones — see resolveSameMarket. */
  vault: string;
  probWad: bigint;
  cluster: string;
  underlying: string;
  /** (direction === "up") === isYes, or null for a non-directional market. */
  bullish: boolean | null;
}

function parseLoadings(what: string, v: unknown): Loadings {
  const o = v as Record<string, unknown>;
  const read = (k: string) => {
    const x = o?.[k];
    if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 1) {
      throw new Error(`correlations: ${what}.${k} must be a number in [0,1], got ${String(x)}`);
    }
    return x;
  };
  const l = { global: read("global"), cluster: read("cluster"), underlying: read("underlying") };
  const explained = l.global ** 2 + l.cluster ** 2 + l.underlying ** 2;
  if (explained > MAX_EXPLAINED) {
    throw new Error(`correlations: ${what} loadings explain ${explained.toFixed(3)} of variance, max ${MAX_EXPLAINED}`);
  }
  return l;
}

export function parseCorrelations(raw: string): CorrelationTable {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const defaults: Record<string, Loadings> = {};
  for (const [k, v] of Object.entries((parsed.defaults ?? {}) as Record<string, unknown>)) {
    defaults[k] = parseLoadings(`defaults.${k}`, v);
  }
  const underlyings: Record<string, Loadings> = {};
  for (const [k, v] of Object.entries((parsed.underlyings ?? {}) as Record<string, unknown>)) {
    underlyings[k] = parseLoadings(`underlyings.${k}`, v);
  }
  return { defaults, underlyings };
}

export function pairCorrelation(a: Loadings, b: Loadings, sameCluster: boolean, sameUnderlying: boolean): number {
  let rho = a.global * b.global;
  if (sameCluster) rho += a.cluster * b.cluster;
  if (sameUnderlying) rho += a.underlying * b.underlying;
  return rho;
}

/** Loadings for a leg, falling back to the most conservative entry in its
 * cluster when the underlying is unknown. Missing data must never quote looser
 * than known data. */
function loadingsFor(leg: CorrLeg, table: CorrelationTable): Loadings {
  const exact = table.underlyings[leg.underlying];
  if (exact) return exact;
  const fallback = table.defaults[leg.cluster];
  if (fallback) {
    console.warn(JSON.stringify({ event: "correlation-fallback", underlying: leg.underlying, cluster: leg.cluster }));
    return fallback;
  }
  // No cluster default either: assume the tightest thing the table knows about.
  console.warn(JSON.stringify({ event: "correlation-unknown", underlying: leg.underlying, cluster: leg.cluster }));
  const all = Object.values(table.underlyings).concat(Object.values(table.defaults));
  if (all.length === 0) return { global: 0, cluster: 0, underlying: 0 };
  return all.reduce((best, l) =>
    l.global ** 2 + l.cluster ** 2 + l.underlying ** 2 > best.global ** 2 + best.cluster ** 2 + best.underlying ** 2 ? l : best,
  );
}

/** Multiplying each loading by sqrt(scale) multiplies every pairwise
 * correlation by exactly scale, since each correlation term is a product of
 * two loadings. Clamped so explained variance stays under MAX_EXPLAINED. */
function scaleLoadings(l: Loadings, scale: number): Loadings {
  const k = Math.sqrt(scale);
  const s = { global: l.global * k, cluster: l.cluster * k, underlying: l.underlying * k };
  const explained = s.global ** 2 + s.cluster ** 2 + s.underlying ** 2;
  if (explained <= MAX_EXPLAINED) return s;
  const shrink = Math.sqrt(MAX_EXPLAINED / explained);
  return { global: s.global * shrink, cluster: s.cluster * shrink, underlying: s.underlying * shrink };
}

function thresholdOf(probWad: bigint): number {
  const p = Math.min(Math.max(Number(probWad) / Number(WAD), P_MIN), 1 - P_MIN);
  return normInv(1 - p);
}

/** Build the factor tree: root = global, children = clusters, grandchildren =
 * underlyings. A leg hangs off the deepest node it shares with another leg;
 * deeper loadings fold into its idiosyncratic term, which is exact — a factor
 * only one leg loads on is indistinguishable from that leg's own noise. */
export function buildTree(legs: CorrLeg[], table: CorrelationTable, scale: number): FactorNode {
  const byCluster = new Map<string, CorrLeg[]>();
  for (const l of legs) {
    const list = byCluster.get(l.cluster);
    if (list) list.push(l);
    else byCluster.set(l.cluster, [l]);
  }
  // ponytail: a "band" market wins when the underlying stays put, which a
  // directional latent cannot express, so it is modelled as uncorrelated with
  // everything. Upgrade to a second latent (level, and dispersion) if band
  // markets ever ship.
  const loadingsOf = (leg: CorrLeg): Loadings =>
    leg.bullish === null
      ? { global: 0, cluster: 0, underlying: 0 }
      : scaleLoadings(loadingsFor(leg, table), scale);
  const fl = (leg: CorrLeg, loadings: number[]): FactorLeg => ({
    threshold: thresholdOf(leg.probWad),
    sign: leg.bullish === false ? -1 : 1,
    loadings,
  });

  const root: FactorNode = { legs: [], children: [] };
  for (const [, clusterLegs] of byCluster) {
    if (clusterLegs.length === 1) {
      // Lone cluster member: nothing to share below the global factor.
      const l = loadingsOf(clusterLegs[0]);
      root.legs.push(fl(clusterLegs[0], [l.global]));
      continue;
    }
    const byUnderlying = new Map<string, CorrLeg[]>();
    for (const l of clusterLegs) {
      const list = byUnderlying.get(l.underlying);
      if (list) list.push(l);
      else byUnderlying.set(l.underlying, [l]);
    }
    if (byUnderlying.size === 1) {
      // Every leg in this cluster is on one underlying, so the cluster and
      // underlying factors are indistinguishable to them: merge into a single
      // factor with loading sqrt(cluster^2 + underlying^2). Exact — it
      // preserves every pairwise correlation in the group — and it removes a
      // whole integration level from the common two-legs-on-one-underlying
      // ticket, whose three-level cost would otherwise be ~16M CDF evaluations.
      root.children.push({
        legs: clusterLegs.map((leg) => {
          const l = loadingsOf(leg);
          return fl(leg, [l.global, Math.hypot(l.cluster, l.underlying)]);
        }),
        children: [],
      });
      continue;
    }
    const clusterNode: FactorNode = { legs: [], children: [] };
    for (const [, group] of byUnderlying) {
      if (group.length === 1) {
        const l = loadingsOf(group[0]);
        clusterNode.legs.push(fl(group[0], [l.global, l.cluster]));
      } else {
        clusterNode.children.push({
          legs: group.map((leg) => {
            const l = loadingsOf(leg);
            return fl(leg, [l.global, l.cluster, l.underlying]);
          }),
          children: [],
        });
      }
    }
    root.children.push(clusterNode);
  }
  return root;
}

/** P(every leg wins), as WAD, at the house-favorable end of the rho band.
 *
 * House-favorable is always the higher joint probability: a higher joint means
 * a lower payout. Taking the max over both ends therefore needs no sign
 * special-case — it raises assumed correlation on same-direction tickets and
 * lowers it on anti-correlated ones in a single rule. */
/** Two legs on the SAME market are one random variable, not two correlated
 * ones, and the copula cannot express that: MAX_EXPLAINED caps every modelled
 * correlation strictly below 1, and the rho band then quotes the loosest end.
 * Left to the model, a YES and a NO on one vault come out at a joint of ~0.106
 * — an 8.8x payout on a ticket that can never win. So exact duplicates are
 * resolved here, before any modelling: opposite sides on one vault is
 * impossible, and the same side twice is a single event whose duplicate
 * carries no information.
 *
 * Returns null when the ticket cannot win. */
function resolveSameMarket(legs: CorrLeg[]): CorrLeg[] | null {
  const seen = new Map<string, CorrLeg>();
  for (const leg of legs) {
    const key = leg.vault.toLowerCase();
    const prior = seen.get(key);
    if (prior === undefined) {
      seen.set(key, leg);
      continue;
    }
    if (prior.bullish !== leg.bullish) return null;
  }
  return [...seen.values()];
}

export function jointProbWad(legs: CorrLeg[], table: CorrelationTable, bandPct: number): bigint {
  const resolved = resolveSameMarket(legs);
  if (resolved === null) return 0n;
  const scales = bandPct > 0 ? [1 - bandPct, 1 + bandPct] : [1];
  let best = 0;
  for (const s of scales) {
    const p = jointProbability(buildTree(resolved, table, s));
    if (p > best) best = p;
  }
  return BigInt(Math.round(best * Number(WAD)));
}
