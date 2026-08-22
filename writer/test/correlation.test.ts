import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, jointProbWad, pairCorrelation, parseCorrelations, type CorrLeg } from "../src/correlation.js";
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

test("rejects a negative or non-numeric loading", () => {
  assert.throws(() => parseCorrelations(JSON.stringify({ clusters: { c: { X: { global: -0.1, cluster: 0, underlying: 0 } } } })));
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

test("parseCorrelations reports which clusters' fallback had to be shrunk, without logging", () => {
  // crypto's component-wise max (global 0.3, cluster 0.92, underlying 0.29)
  // explains 1.0205 of variance, past MAX_EXPLAINED — must shrink and be
  // reported. equity's (0.3, 0.8426, 0.4) explains ~0.96 — must not.
  assert.deepEqual(TABLE.shrunkClusters, ["crypto"]);
});

test("an out-of-range band is clamped, not propagated as NaN", () => {
  const legs = [leg(0.132, "equity", "NVDA"), leg(0.44, "equity", "SP500")];
  for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const joint = jointProbWad(legs, TABLE, bad);
    assert.ok(joint > 0n && joint < WAD, `band ${bad} produced ${joint}`);
  }
});

test("correlated same-direction legs price above the independent product", () => {
  const legs = [leg(0.132, "equity", "NVDA"), leg(0.44, "equity", "SP500")];
  const joint = jointProbWad(legs, TABLE, 0);
  assert.ok(joint > wad(0.132 * 0.44), `${joint}`);
});

test("anti-correlated legs price below the independent product", () => {
  const legs = [leg(0.132, "equity", "NVDA"), leg(0.56, "equity", "SP500", false)];
  const joint = jointProbWad(legs, TABLE, 0);
  assert.ok(joint < wad(0.132 * 0.56), `${joint}`);
});

test("the band always returns the house-favorable (higher) joint", () => {
  for (const legs of [
    [leg(0.132, "equity", "NVDA"), leg(0.44, "equity", "SP500")],
    [leg(0.132, "equity", "NVDA"), leg(0.56, "equity", "SP500", false)],
    [leg(0.5, "crypto", "BTC"), leg(0.132, "equity", "NVDA")],
  ]) {
    assert.ok(jointProbWad(legs, TABLE, 0.2) >= jointProbWad(legs, TABLE, 0), "band must not quote below mid");
  }
});

test("the same market on both sides cannot win", () => {
  // Exactly zero, not merely small. The copula cannot reach this on its own:
  // MAX_EXPLAINED caps modelled correlation at 0.99 and the band quotes the
  // loosest end, which would price this pair at a joint near 0.106.
  const legs = [
    leg(0.5, "crypto", "BTC", true, SAME_VAULT),
    leg(0.5, "crypto", "BTC", false, SAME_VAULT),
  ];
  assert.equal(jointProbWad(legs, TABLE, 0.2), 0n);
});

test("the same market twice on the same side is one event", () => {
  const twice = jointProbWad(
    [leg(0.37, "crypto", "BTC", true, SAME_VAULT), leg(0.37, "crypto", "BTC", true, SAME_VAULT)],
    TABLE,
    0.2,
  );
  const once = jointProbWad([leg(0.37, "crypto", "BTC")], TABLE, 0.2);
  assert.equal(twice, once, "a duplicated leg must not change the price");
});

test("two DIFFERENT markets on one underlying, opposite sides, stay possible", () => {
  // BTC above 69k YES + BTC above 72k NO is satisfied whenever BTC lands
  // between the strikes, so this must price, not round to zero. The model has
  // no strike parsing, so it prices the general same-underlying case.
  const legs = [leg(0.5, "crypto", "BTC"), leg(0.5, "crypto", "BTC", false)];
  const joint = jointProbWad(legs, TABLE, 0.2);
  assert.ok(joint > 0n, "distinct markets must not be treated as contradictory");
  assert.ok(joint < wad(0.2), `expected a low joint for opposing legs, got ${joint}`);
});

test("an unknown underlying prices at least as tight as a known one", () => {
  const known = jointProbWad([leg(0.132, "equity", "NVDA"), leg(0.44, "equity", "SP500")], TABLE, 0);
  const unknown = jointProbWad([leg(0.132, "equity", "MYSTERY"), leg(0.44, "equity", "SP500")], TABLE, 0);
  // Same-direction legs: tighter means a HIGHER joint probability, i.e. a
  // smaller payout. Missing data must never be the cheaper ticket.
  assert.ok(unknown >= known, `unknown ${unknown} priced looser than known ${known}`);
});

test("a lone leg returns its own marginal", () => {
  const joint = jointProbWad([leg(0.37, "crypto", "BTC")], TABLE, 0.2);
  assert.ok(Math.abs(Number(joint - wad(0.37))) < Number(WAD) * 1e-6, `${joint}`);
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
    1,
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
  const tree = buildTree([leg(0.5, "crypto", "BTC"), leg(0.45, "crypto", "BTC")], TABLE, 1);
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
  assert.equal(jointProbWad(legs, TABLE, 0.2), 0n);
});

test("a band market's same side twice on one vault is still one event", () => {
  const twice = jointProbWad(
    [leg(0.4, "crypto", "BTC", null, SAME_VAULT, true), leg(0.4, "crypto", "BTC", null, SAME_VAULT, true)],
    TABLE,
    0.2,
  );
  const once = jointProbWad([leg(0.4, "crypto", "BTC", null, SAME_VAULT, true)], TABLE, 0.2);
  assert.equal(twice, once);
});

test("a ticket past the quadrature budget is refused, not integrated for seconds", () => {
  // Eight legs, two per underlying across two clusters: three integration
  // levels in both, well past the budget and seconds of a single-threaded
  // event loop. The house refuses tickets it cannot price in bounded time.
  const legs = ["BTC", "ETH"]
    .flatMap((u) => [leg(0.5, "crypto", u), leg(0.45, "crypto", u)])
    .concat(["NVDA", "SP500"].flatMap((u) => [leg(0.4, "equity", u), leg(0.35, "equity", u)]));
  assert.equal(legs.length, 8);
  const t0 = performance.now();
  assert.throws(() => jointProbWad(legs, TABLE, 0.2), TooComplexError);
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
  const joint = jointProbWad(legs, TABLE, 0.2);
  assert.ok(joint > 0n && joint < WAD, `${joint}`);
});
