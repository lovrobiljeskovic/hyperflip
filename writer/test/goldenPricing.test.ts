import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { jointProbWad, parseCorrelations, type CorrLeg } from "../src/correlation.js";
import { edgeBreakdown, priceParlay, totalEdgeBps } from "../src/pricing.js";
import { WAD } from "../src/pure.js";

const TABLE = parseCorrelations(readFileSync(new URL("../../registry/correlations.json", import.meta.url), "utf8"));
const STAKE = 1_000_000n; // 1 USDC, 6 decimals
const EDGE = 500n;
const LEG_EDGE = 300n;
const MIN_PREMIUM = 100n;

let vaultSeq = 0;
const leg = (p: number, cluster: string, underlying: string, bullish: boolean | null = true): CorrLeg => ({
  vault: `0x${(++vaultSeq).toString(16).padStart(40, "0")}`,
  isYes: bullish !== false,
  probWad: BigInt(Math.round(p * 1e18)),
  cluster,
  underlying,
  bullish,
});

function multiplier(legs: CorrLeg[]): number {
  const joint = jointProbWad(legs, TABLE);
  const edge = edgeBreakdown(legs.length, EDGE, LEG_EDGE);
  const r = priceParlay(joint, STAKE, totalEdgeBps(edge), MIN_PREMIUM);
  assert.ok(r.ok, `expected a price, got ${r.ok ? "ok" : r.reason}`);
  return Number(r.maxPayout) / Number(r.premium);
}

const BTC = (p: number, b = true) => leg(p, "crypto", "BTC", b);
const ETH = (p: number, b = true) => leg(p, "crypto", "ETH", b);
const NVDA = (p: number, b = true) => leg(p, "equity", "NVDA", b);
const SP500 = (p: number, b = true) => leg(p, "equity", "SP500", b);
const SNDK = (p: number, b = true) => leg(p, "equity", "SNDK", b);

/** Spec table, ~/docs/superpowers/specs/2026-08-22-parlay-correlation-pricing-design.md,
 * re-pinned for the R5 point model: the deleted rho band priced opposite-
 * direction tickets at the 0.8 loading scale, so those rows moved (50.7 -> the
 * 100x min-premium floor, 9.7 -> 21.6) and the same-underlying SNDK row moved
 * 2.08 -> 2.19; same-direction rows are unchanged to within tolerance.
 * Wide tolerance: these pin behaviour and rough magnitude, not the quadrature's
 * last digit. A loadings change should move them and force a deliberate update. */
const GOLDEN: [string, CorrLeg[], number][] = [
  ["BTC yes + NVDA yes + SP500 yes", [BTC(0.5), NVDA(0.132), SP500(0.44)], 12.6],
  ["NVDA yes + SP500 yes", [NVDA(0.132), SP500(0.44)], 7.2],
  ["BTC yes + ETH yes", [BTC(0.5), ETH(0.55)], 2.0],
  // Joint ~0.0085 at rho 0.8 against 0.074 independent: the premium floor
  // (MIN_PREMIUM 1%) binds, so the multiplier is the 100x cap, not the model.
  ["NVDA yes + SP500 no", [NVDA(0.132), SP500(0.56, false)], 100],
  ["BTC yes + ETH no", [BTC(0.5), ETH(0.45, false)], 21.6],
  ["BTC yes + NVDA yes", [BTC(0.5), NVDA(0.132)], 12.5],
  // Two SNDK markets, same side: the same-underlying collapse in buildTree,
  // priced. joint ~0.4227, so 1 / (0.4227 * 1.08) = 2.19x, against 4.115x if
  // the legs were priced as independent.
  //
  // SNDK and not BTC deliberately. BTC's loadings explain 0.984 of variance,
  // so zeroing its `underlying` loading barely moves a two-BTC ticket and the
  // row would guard nothing. SNDK's explain 0.955 and 0.653, so the same
  // mutation moves this row materially.
  ["SNDK yes + SNDK yes (same underlying)", [SNDK(0.5), SNDK(0.45)], 2.19],
  // Two NVDA markets plus SP500: the only golden whose tree actually has three
  // levels — a same-underlying PAIR collapses cluster and underlying into one
  // factor, so it never reaches depth 2. joint 0.34778, and the 3-leg edge is
  // 500 + 2*300 = 1100bps, so 1 / (0.34778 * 1.11) = 2.590x.
  ["NVDA yes + NVDA yes + SP500 yes", [NVDA(0.5), NVDA(0.45), SP500(0.44)], 2.59],
];

for (const [name, legs, want] of GOLDEN) {
  test(`golden: ${name} prices near ${want}x`, () => {
    const got = multiplier(legs);
    assert.ok(Math.abs(got - want) / want < 0.05, `${name}: got ${got.toFixed(2)}x, want ~${want}x`);
  });
}

test("correlated legs never pay more than the same legs would if independent", () => {
  const legs = [NVDA(0.132), SP500(0.44)];
  const joint = jointProbWad(legs, TABLE);
  const product = (BigInt(Math.round(0.132 * 1e18)) * BigInt(Math.round(0.44 * 1e18))) / WAD;
  assert.ok(joint > product, "same-direction correlated legs must raise the joint probability");
});
