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
  /** Every underlying in the file, flattened for lookup. */
  underlyings: Record<string, Loadings>;
  /** Per-cluster fallback for an underlying the file does not list. COMPUTED
   * from that cluster's members (see computeFallback) rather than hand-set:
   * a hand-set default silently drifts looser than the members it is meant to
   * bound, and for some clusters no hand-set value can bound them at all —
   * crypto's BTC is the conservative one on the underlying axis (0.29) while
   * ETH is on the cluster axis (0.92), and a vector dominating both explains
   * 1.0205 of variance, past MAX_EXPLAINED. */
  fallback: Record<string, Loadings>;
  /** Clusters whose computed fallback had to be shrunk to respect MAX_EXPLAINED
   * (see computeFallback) — the fallback is no longer a strict per-axis bound
   * on every member for these. Parsing stays pure; the caller decides whether
   * and how loudly to surface this. */
  shrunkClusters: string[];
}

export interface CorrLeg {
  /** The market this leg is on. Two legs sharing it are the same event, not
   * two correlated ones — see resolveSameMarket. */
  vault: string;
  /** Which side of that market. Identity of a position is a side question, so
   * this — not `bullish` — is what resolveSameMarket keys on. */
  isYes: boolean;
  probWad: bigint;
  cluster: string;
  underlying: string;
  /** (direction === "up") === isYes, or null for a non-directional market.
   * Only the copula's sign uses it; a band market has no direction, so both
   * of its sides are null. */
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

/** The most conservative loadings a cluster's members justify: the
 * component-wise maximum, shrunk to MAX_EXPLAINED if that combination
 * over-explains. Component-wise max is what the fallback invariant needs —
 * using it can never yield a lower pairwise correlation than any single
 * member would have. When the shrink bites, the fallback is no longer a
 * strict bound on every axis; the caller (parseCorrelations) records that in
 * shrunkClusters rather than this function logging it — parsing stays pure. */
function computeFallback(members: Loadings[]): { loadings: Loadings; shrunk: boolean } {
  const max = members.reduce(
    (m, l) => ({
      global: Math.max(m.global, l.global),
      cluster: Math.max(m.cluster, l.cluster),
      underlying: Math.max(m.underlying, l.underlying),
    }),
    { global: 0, cluster: 0, underlying: 0 },
  );
  const explained = max.global ** 2 + max.cluster ** 2 + max.underlying ** 2;
  if (explained <= MAX_EXPLAINED) return { loadings: max, shrunk: false };
  const shrink = Math.sqrt(MAX_EXPLAINED / explained);
  return {
    loadings: { global: max.global * shrink, cluster: max.cluster * shrink, underlying: max.underlying * shrink },
    shrunk: true,
  };
}

export function parseCorrelations(raw: string): CorrelationTable {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const clusters = (parsed.clusters ?? {}) as Record<string, unknown>;
  const underlyings: Record<string, Loadings> = {};
  const fallback: Record<string, Loadings> = {};
  const shrunkClusters: string[] = [];
  for (const [cluster, entries] of Object.entries(clusters)) {
    const members: Loadings[] = [];
    for (const [name, v] of Object.entries(entries as Record<string, unknown>)) {
      const l = parseLoadings(`clusters.${cluster}.${name}`, v);
      underlyings[name] = l;
      members.push(l);
    }
    if (members.length > 0) {
      const { loadings, shrunk } = computeFallback(members);
      fallback[cluster] = loadings;
      if (shrunk) shrunkClusters.push(cluster);
    }
  }
  return { underlyings, fallback, shrunkClusters };
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
  const fallback = table.fallback[leg.cluster];
  if (fallback) {
    console.warn(JSON.stringify({ event: "correlation-fallback", underlying: leg.underlying, cluster: leg.cluster }));
    return fallback;
  }
  // The cluster itself is unknown, so there is no in-cluster evidence to bound
  // this leg with. Borrow the tightest thing the whole table knows about: it
  // may come from an unrelated cluster, which is a blunt over-estimate rather
  // than an under-estimate, and it is loud in the log either way.
  console.warn(JSON.stringify({ event: "correlation-unknown-cluster", underlying: leg.underlying, cluster: leg.cluster }));
  const all = Object.values(table.underlyings);
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

/** Two legs on the SAME market are one random variable, not two correlated
 * ones, and the copula cannot express that: MAX_EXPLAINED caps every modelled
 * correlation strictly below 1, and the rho band then quotes the loosest end.
 * Left to the model, a YES and a NO on one vault come out at a joint of ~0.106
 * — an 8.8x payout on a ticket that can never win. So exact duplicates are
 * resolved here, before any modelling: opposite sides on one vault is
 * impossible, and the same side twice is a single event whose duplicate
 * carries no information.
 *
 * Sides are compared by `isYes`, not by `bullish`: a band market sets `bullish`
 * to null on BOTH sides, so comparing stance would collapse a YES and a NO on
 * one band vault into a single leg and sell a ~1.9x payout on a ticket that
 * cannot win.
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
    if (prior.isYes !== leg.isYes) return null;
    if (prior.probWad !== leg.probWad) {
      // Same market, same side, two different prices: an upstream bug. The
      // first price wins, but never silently — this is a money path.
      console.warn(
        JSON.stringify({
          event: "duplicate-leg-price-mismatch",
          vault: key,
          kept: prior.probWad.toString(),
          dropped: leg.probWad.toString(),
        }),
      );
    }
  }
  return [...seen.values()];
}

/** P(every leg wins), as WAD, at the house-favorable end of the rho band.
 *
 * House-favorable is always the higher joint probability: a higher joint means
 * a lower payout. Taking the max over both ends therefore needs no sign
 * special-case — it raises assumed correlation on same-direction tickets and
 * lowers it on anti-correlated ones in a single rule.
 *
 * `bandPct` is clamped here rather than trusted from the caller: every caller
 * routes through this function, and a value at or above 1 would make
 * scaleLoadings take the square root of a negative number, quietly producing
 * NaN loadings and a meaningless price. */
export function jointProbWad(legs: CorrLeg[], table: CorrelationTable, bandPct: number): bigint {
  const resolved = resolveSameMarket(legs);
  if (resolved === null) return 0n;
  const band = Number.isFinite(bandPct) ? Math.min(Math.max(bandPct, 0), 0.99) : 0;
  // Widest scale first: its tree is the most expensive to integrate, so a
  // ticket over the quadrature budget throws before the cheap end is spent.
  // Only an optimisation — the result is the max either way.
  const scales = band > 0 ? [1 + band, 1 - band] : [1];
  let best = 0;
  for (const s of scales) {
    const p = jointProbability(buildTree(resolved, table, s));
    if (p > best) best = p;
  }
  return BigInt(Math.round(best * Number(WAD)));
}
