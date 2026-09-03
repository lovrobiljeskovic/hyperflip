import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTree, jointProbWad, pairCorrelation, parseCorrelations, type CorrLeg, type Loadings } from "../src/correlation.js";
import { jointProbability, normInv, TooComplexError } from "../src/copula.js";

const WAD = 10n ** 18n;
const wad = (p: number) => BigInt(Math.round(p * 1e18));

const TABLE = parseCorrelations(
  JSON.stringify({
    clusters: {
      crypto: {
        BTC: { global: 0.3, cluster: 0.9, underlying: 0.29 },
        ETH: { global: 0.3, cluster: 0.92, underlying: 0.2 },
      },
      equity: {
        NVDA: { global: 0.3, cluster: 0.8426, underlying: 0.4 },
        SP500: { global: 0.3, cluster: 0.8426, underlying: 0.4 },
      },
    },
  }),
);

/** The operator-reviewed testnet table: eleven underlyings across three clusters. */
const REGISTRY_RAW = readFileSync(new URL("../../registry/correlations.json", import.meta.url), "utf8");
const REGISTRY = parseCorrelations(REGISTRY_RAW);

let vaultSeq = 0;
/** Distinct vault per call unless one is passed — most tests are about
 * different markets, and same-market cases must say so explicitly. */
const leg = (
  p: number,
  cluster: string,
  underlying: string,
  bullish: boolean | null = true,
  vault = `0x${(++vaultSeq).toString(16).padStart(40, "0")}`,
  isYes = bullish !== false,
): CorrLeg => ({ vault, isYes, probWad: wad(p), cluster, underlying, bullish });

const SAME_VAULT = "0xdead00000000000000000000000000000000beef";

/** Every loading multiplied by sqrt(scale), so every pairwise correlation is
 * multiplied by exactly scale, shrunk back to the 0.99 variance ceiling when
 * the scale over-explains — the transform the deleted rho band applied. */
function scaledTable(raw: string, scale: number) {
  const parsed = JSON.parse(raw) as { clusters: Record<string, Record<string, Loadings>> };
  const k = Math.sqrt(scale);
  for (const members of Object.values(parsed.clusters)) {
    for (const [name, l] of Object.entries(members)) {
      const s = { global: l.global * k, cluster: l.cluster * k, underlying: l.underlying * k };
      const explained = s.global ** 2 + s.cluster ** 2 + s.underlying ** 2;
      const shrink = explained > 0.99 ? Math.sqrt(0.99 / explained) : 1;
      members[name] = { global: s.global * shrink, cluster: s.cluster * shrink, underlying: s.underlying * shrink };
    }
  }
  return parseCorrelations(JSON.stringify({ clusters: parsed.clusters }));
}

const REGISTRY_CLUSTER: Record<string, string> = {};
for (const [cluster, members] of Object.entries((JSON.parse(REGISTRY_RAW) as { clusters: Record<string, Record<string, unknown>> }).clusters)) {
  for (const name of Object.keys(members)) REGISTRY_CLUSTER[name] = cluster;
}

/** Mixed-direction ticket on distinct registry underlyings: alternating
 * up/down, marginals spread across (0.15, 0.85). */
function mixedTicket(underlyings: string[]): CorrLeg[] {
  return underlyings.map((u, i) => leg(0.15 + (0.7 * i) / Math.max(underlyings.length - 1, 1), REGISTRY_CLUSTER[u], u, i % 2 === 0));
}

function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

test("pairCorrelation composes the shared factors", () => {
  const nvda = TABLE.underlyings.NVDA;
  const sp = TABLE.underlyings.SP500;
  const btc = TABLE.underlyings.BTC;
  assert.ok(Math.abs(pairCorrelation(nvda, sp, true, false) - 0.8) < 0.01);
  assert.ok(Math.abs(pairCorrelation(nvda, btc, false, false) - 0.09) < 1e-9);
  assert.ok(pairCorrelation(btc, btc, true, true) > 0.95);
});

test("rejects loadings whose squares reach 1", () => {
  assert.throws(() =>
    parseCorrelations(JSON.stringify({ clusters: { c: { X: { global: 0.8, cluster: 0.8, underlying: 0.1 } } } })),
  );
});

test("accepts a signed loading, rejects magnitude over 1 or non-numeric", () => {
  assert.deepEqual(parseCorrelations(JSON.stringify({ clusters: { c: { X: { global: -0.1, cluster: -0.2, underlying: 0 } } } })).underlyings.X, { global: -0.1, cluster: -0.2, underlying: 0 });
  assert.throws(() => parseCorrelations(JSON.stringify({ clusters: { c: { X: { global: -1.1, cluster: 0, underlying: 0 } } } })));
  assert.throws(() => parseCorrelations(JSON.stringify({ clusters: { c: { X: { global: "a", cluster: 0, underlying: 0 } } } })));
});

test("the computed fallback is never looser than any member of its cluster", () => {
  // The whole point of the fallback: an underlying nobody tabulated must not
  // price more cheaply than one that was. Component-wise domination is the
  // property that guarantees it, since every pairwise correlation term is a
  // product of two loadings.
  for (const [cluster, fb] of Object.entries(TABLE.fallback)) {
    const members = cluster === "crypto" ? ["BTC", "ETH"] : ["NVDA", "SP500"];
    const explained = fb.global ** 2 + fb.cluster ** 2 + fb.underlying ** 2;
    assert.ok(explained <= 0.99 + 1e-12, `${cluster} fallback over-explains: ${explained}`);
    if (explained < 0.99 - 1e-9) {
      // Only when the shrink did NOT bite can domination be strict.
      for (const m of members) {
        const l = TABLE.underlyings[m];
        assert.ok(fb.global >= l.global - 1e-12, `${cluster} fallback global below ${m}`);
        assert.ok(fb.cluster >= l.cluster - 1e-12, `${cluster} fallback cluster below ${m}`);
        assert.ok(fb.underlying >= l.underlying - 1e-12, `${cluster} fallback underlying below ${m}`);
      }
    }
  }
});

test("a signed cluster's fallback dominates every member by magnitude and keeps the dominant sign", () => {
  // A fitted champion can carry negative loadings. The unsigned component-wise
  // max would pick +0.2 over -0.5 for `global` and hand an unknown underlying
  // a looser same-underlying correlation than either listed member has.
  const signed = parseCorrelations(JSON.stringify({ clusters: { c: {
    A: { global: -0.5, cluster: 0.3, underlying: 0.1 },
    B: { global: 0.2, cluster: -0.7, underlying: -0.4 },
  } } }));
  assert.deepEqual(signed.fallback.c, { global: -0.5, cluster: -0.7, underlying: -0.4 });
  const selfCorrelation = (l: Loadings) => pairCorrelation(l, l, true, true);
  for (const name of ["A", "B"]) {
    assert.ok(selfCorrelation(signed.fallback.c) >= selfCorrelation(signed.underlyings[name]) - 1e-12, `fallback looser than ${name}`);
  }
});

test("parseCorrelations reports which clusters' fallback had to be shrunk, without logging", () => {
  // crypto's component-wise max (global 0.3, cluster 0.92, underlying 0.29)
  // explains 1.0205 of variance, past MAX_EXPLAINED — must shrink and be
  // reported. equity's (0.3, 0.8426, 0.4) explains ~0.96 — must not.
  assert.deepEqual(TABLE.shrunkClusters, ["crypto"]);
});

test("correlated same-direction legs price above the independent product", () => {
  const legs = [leg(0.132, "equity", "NVDA"), leg(0.44, "equity", "SP500")];
  const joint = jointProbWad(legs, TABLE);
  assert.ok(joint > wad(0.132 * 0.44), `${joint}`);
});

test("anti-correlated legs price below the independent product", () => {
  const legs = [leg(0.132, "equity", "NVDA"), leg(0.56, "equity", "SP500", false)];
  const joint = jointProbWad(legs, TABLE);
  assert.ok(joint < wad(0.132 * 0.56), `${joint}`);
});

test("a negative loading prices same-direction legs as anti-correlated", () => {
  // Signed loadings reach the runtime unchanged: two up legs whose global
  // loadings have opposite signs must land below independence, and flipping
  // one leg's direction must land above it.
  const signed = parseCorrelations(JSON.stringify({ clusters: {
    crypto: { BTC: { global: 0.8, cluster: 0, underlying: 0 } },
    equity: { NVDA: { global: -0.8, cluster: 0, underlying: 0 } },
  } }));
  const product = wad(0.5 * 0.4);
  assert.ok(jointProbWad([leg(0.5, "crypto", "BTC"), leg(0.4, "equity", "NVDA")], signed) < product);
  assert.ok(jointProbWad([leg(0.5, "crypto", "BTC"), leg(0.4, "equity", "NVDA", false)], signed) > product);
});

test("the two-endpoint band is not a bound: an interior loading scale beats both ends", () => {
  // BTC up 0.85, ETH up 0.50, NVDA down 0.30 on the checked-in table. The
  // deleted band evaluated scales 0.8 and 1.2 and called the larger joint
  // house-favorable; the scale 0.95 in between is higher than either, so the
  // band could overpay. See the implementation plan, failure mechanism 2.
  const ticket = [leg(0.85, "crypto", "BTC"), leg(0.5, "crypto", "ETH"), leg(0.3, "equity", "NVDA", false)];
  const at = (scale: number) => Number(jointProbWad(ticket, scaledTable(REGISTRY_RAW, scale))) / 1e18;
  const lower = at(0.8);
  const interior = at(0.95);
  const upper = at(1.2);
  assert.ok(Math.abs(lower - 0.137117320390844) < 1e-9, `${lower}`);
  assert.ok(Math.abs(interior - 0.13770786042946592) < 1e-9, `${interior}`);
  assert.ok(Math.abs(upper - 0.13717848214066466) < 1e-9, `${upper}`);
  assert.ok(interior > Math.max(lower, upper), "interior scale must exceed both endpoints");
});

test("the same market on both sides cannot win", () => {
  // Exactly zero, not merely small. The copula cannot reach this on its own:
  // MAX_EXPLAINED caps modelled correlation at 0.99, which would price this
  // pair at a joint near 0.1.
  const legs = [
    leg(0.5, "crypto", "BTC", true, SAME_VAULT),
    leg(0.5, "crypto", "BTC", false, SAME_VAULT),
  ];
  assert.equal(jointProbWad(legs, TABLE), 0n);
});

test("the same market twice on the same side is one event", () => {
  const twice = jointProbWad(
    [leg(0.37, "crypto", "BTC", true, SAME_VAULT), leg(0.37, "crypto", "BTC", true, SAME_VAULT)],
    TABLE,
  );
  const once = jointProbWad([leg(0.37, "crypto", "BTC")], TABLE);
  assert.equal(twice, once, "a duplicated leg must not change the price");
});

test("two DIFFERENT markets on one underlying, opposite sides, stay possible", () => {
  // BTC above 69k YES + BTC above 72k NO is satisfied whenever BTC lands
  // between the strikes, so this must price, not round to zero. The model has
  // no strike parsing, so it prices the general same-underlying case.
  const legs = [leg(0.5, "crypto", "BTC"), leg(0.5, "crypto", "BTC", false)];
  const joint = jointProbWad(legs, TABLE);
  assert.ok(joint > 0n, "distinct markets must not be treated as contradictory");
  assert.ok(joint < wad(0.2), `expected a low joint for opposing legs, got ${joint}`);
});

test("an unknown underlying prices at least as tight as a known one", () => {
  const known = jointProbWad([leg(0.132, "equity", "NVDA"), leg(0.44, "equity", "SP500")], TABLE);
  const unknown = jointProbWad([leg(0.132, "equity", "MYSTERY"), leg(0.44, "equity", "SP500")], TABLE);
  // Same-direction legs: tighter means a HIGHER joint probability, i.e. a
  // smaller payout. Missing data must never be the cheaper ticket.
  assert.ok(unknown >= known, `unknown ${unknown} priced looser than known ${known}`);
});

test("a lone leg returns its own marginal", () => {
  const joint = jointProbWad([leg(0.37, "crypto", "BTC")], TABLE);
  assert.ok(Math.abs(Number(joint - wad(0.37))) < Number(WAD) * 1e-6, `${joint}`);
});

test("zero loadings reproduce the independent product for ten distinct underlyings", () => {
  const zero = parseCorrelations(JSON.stringify({ clusters: Object.fromEntries(
    ["crypto", "equity", "commodity"].map((cluster) => [cluster, Object.fromEntries(
      Object.entries(REGISTRY_CLUSTER).filter(([, c]) => c === cluster).map(([u]) => [u, { global: 0, cluster: 0, underlying: 0 }]),
    )]),
  ) }));
  const legs = mixedTicket(["BTC", "ETH", "SOL", "HYPE", "ZEC", "NVDA", "SP500", "SNDK", "TSLA", "GOLD"]);
  const product = legs.reduce((acc, l) => acc * (Number(l.probWad) / 1e18), 1);
  const joint = Number(jointProbWad(legs, zero)) / 1e18;
  assert.ok(Math.abs(joint - product) < 1e-9, `joint ${joint} product ${product}`);
});

// The runtime matrix: mixed directions across 2, 3, 4, 5, 6, and 10 distinct
// underlyings, crypto-only, TradFi-only, and mixed clusters. Every shape must
// price inside (0,1), never above its tightest marginal, and give the same WAD
// for every leg-order permutation.
const MATRIX: [string, string[]][] = [
  ["2 crypto", ["BTC", "ETH"]],
  ["2 mixed", ["BTC", "NVDA"]],
  ["3 TradFi", ["NVDA", "SP500", "GOLD"]],
  ["3 mixed", ["BTC", "ETH", "NVDA"]],
  ["4 crypto", ["BTC", "ETH", "SOL", "HYPE"]],
  ["4 mixed", ["BTC", "SOL", "NVDA", "GOLD"]],
  ["5 crypto", ["BTC", "ETH", "SOL", "HYPE", "ZEC"]],
  ["5 TradFi", ["NVDA", "SP500", "SNDK", "TSLA", "AAPL"]],
  ["6 TradFi", ["NVDA", "SP500", "SNDK", "TSLA", "AAPL", "GOLD"]],
  ["6 mixed", ["BTC", "ETH", "SOL", "NVDA", "SP500", "GOLD"]],
  ["10 mixed", ["BTC", "ETH", "SOL", "HYPE", "ZEC", "NVDA", "SP500", "SNDK", "TSLA", "GOLD"]],
];

for (const [name, underlyings] of MATRIX) {
  test(`matrix: ${name} distinct underlyings price inside the marginal bound and ignore leg order`, () => {
    const legs = mixedTicket(underlyings);
    const t0 = performance.now();
    const joint = jointProbWad(legs, REGISTRY);
    const elapsed = performance.now() - t0;
    const tightest = legs.reduce((m, l) => (l.probWad < m ? l.probWad : m), WAD);
    assert.ok(joint > 0n && joint <= tightest, `${name}: ${joint} outside (0, ${tightest}]`);
    assert.ok(elapsed < 1_000, `${name}: ${elapsed.toFixed(0)}ms is past the worker timeout`);
    for (const seed of [1, 2, 3]) {
      assert.equal(jointProbWad(shuffled(legs, seed), REGISTRY), joint, `${name}: permutation ${seed} changed the price`);
    }
  });
}

test("repeated underlyings ignore leg order too", () => {
  const legs = [leg(0.5, "crypto", "BTC"), leg(0.45, "crypto", "BTC", false), leg(0.55, "crypto", "ETH"), leg(0.3, "equity", "NVDA", false), leg(0.6, "equity", "NVDA")];
  const joint = jointProbWad(legs, REGISTRY);
  for (const seed of [4, 5, 6]) assert.equal(jointProbWad(shuffled(legs, seed), REGISTRY), joint);
});

test("buildTree nests underlying under cluster only when the cluster is mixed", () => {
  const tree = buildTree(
    [
      leg(0.5, "crypto", "BTC"),
      leg(0.4, "crypto", "BTC"),
      leg(0.55, "crypto", "ETH"),
      leg(0.3, "equity", "NVDA"),
      leg(0.6, "equity", "SP500"),
    ],
    TABLE,
  );
  assert.equal(tree.legs.length, 0, "no cluster here has a single member");
  assert.equal(tree.children.length, 2);
  // crypto: two underlyings, so the BTC pair gets its own node and ETH hangs
  // off the cluster directly.
  const crypto = tree.children.find((c) => c.children.length === 1)!;
  assert.ok(crypto !== undefined, "crypto should nest the BTC pair one level deeper");
  assert.equal(crypto.legs.length, 1, "ETH hangs off the cluster node");
  assert.equal(crypto.children[0].legs.length, 2, "the BTC pair shares an underlying factor");
  assert.equal(crypto.children[0].legs[0].loadings.length, 3, "BTC legs load on all three factors");
  assert.equal(crypto.legs[0].loadings.length, 2, "ETH loads on global and cluster only");
  // equity: two lone underlyings, both directly on the cluster node.
  const equity = tree.children.find((c) => c.children.length === 0)!;
  assert.ok(equity !== undefined, "equity should hold two lone-underlying legs directly");
  assert.equal(equity.legs.length, 2);
  assert.ok(jointProbability(tree) > 0);
});

test("a cluster whose legs share one underlying collapses to a single factor", () => {
  // Two BTC legs and nothing else in crypto: the cluster and underlying
  // factors are indistinguishable to them, so the tree must not spend an
  // integration level separating them.
  const tree = buildTree([leg(0.5, "crypto", "BTC"), leg(0.45, "crypto", "BTC")], TABLE);
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].children.length, 0, "no third level for a single-underlying cluster");
  assert.equal(tree.children[0].legs.length, 2);
  const merged = tree.children[0].legs[0].loadings;
  assert.equal(merged.length, 2);
  const btc = TABLE.underlyings.BTC;
  assert.ok(Math.abs(merged[1] - Math.hypot(btc.cluster, btc.underlying)) < 1e-12);
  // Collapsing is exact: the same legs priced through an explicit three-level
  // tree give the same answer.
  const explicit = jointProbability({
    legs: [],
    children: [
      {
        legs: [],
        children: [
          {
            legs: [
              { threshold: normInv(1 - 0.5), sign: 1, loadings: [btc.global, btc.cluster, btc.underlying] },
              { threshold: normInv(1 - 0.45), sign: 1, loadings: [btc.global, btc.cluster, btc.underlying] },
            ],
            children: [],
          },
        ],
      },
    ],
  });
  assert.ok(Math.abs(jointProbability(tree) - explicit) < 1e-6, "collapse must not change the answer");
});

test("a band market's two sides on one vault cannot win", () => {
  // A band market has no direction, so `bullish` is null on BOTH sides. Keying
  // the collapse on stance instead of side would fold these into one leg and
  // quote ~1.9x on a ticket that is guaranteed to lose.
  const legs = [
    leg(0.5, "crypto", "BTC", null, SAME_VAULT, true),
    leg(0.5, "crypto", "BTC", null, SAME_VAULT, false),
  ];
  assert.equal(jointProbWad(legs, TABLE), 0n);
});

test("a band market's same side twice on one vault is still one event", () => {
  const twice = jointProbWad(
    [leg(0.4, "crypto", "BTC", null, SAME_VAULT, true), leg(0.4, "crypto", "BTC", null, SAME_VAULT, true)],
    TABLE,
  );
  const once = jointProbWad([leg(0.4, "crypto", "BTC", null, SAME_VAULT, true)], TABLE);
  assert.equal(twice, once);
});

test("a ticket past the quadrature budget is refused, not integrated for seconds", () => {
  // Eight legs, two per underlying across two clusters: three integration
  // levels in both, well past the budget. The house refuses tickets it cannot
  // price in bounded time.
  const legs = ["BTC", "ETH"]
    .flatMap((u) => [leg(0.5, "crypto", u), leg(0.45, "crypto", u)])
    .concat(["NVDA", "SP500"].flatMap((u) => [leg(0.4, "equity", u), leg(0.35, "equity", u)]));
  assert.equal(legs.length, 8);
  const t0 = performance.now();
  const cost = () => {
    try { jointProbWad(legs, TABLE); assert.fail("expected TooComplexError"); }
    catch (error) { assert.ok(error instanceof TooComplexError); return error.cost; }
  };
  const first = cost();
  assert.equal(cost(), first, "work estimates must be deterministic");
  assert.ok(first > 4_000_000);
  assert.ok(performance.now() - t0 < 500, "the refusal must be cheap, not a full integration");
});

test("a realistic ticket across every live cluster still prices", () => {
  // The budget must not refuse anything the registry can actually build. This
  // is the most expensive live shape: two BTC markets and ETH in one cluster,
  // so crypto integrates all three levels, plus a second cluster.
  const legs = [
    leg(0.5, "crypto", "BTC"),
    leg(0.45, "crypto", "BTC"),
    leg(0.55, "crypto", "ETH"),
    leg(0.132, "equity", "NVDA"),
    leg(0.44, "equity", "SP500"),
  ];
  const joint = jointProbWad(legs, TABLE);
  assert.ok(joint > 0n && joint < WAD, `${joint}`);
});
