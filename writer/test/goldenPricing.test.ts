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
const BAND = 0.2;

let vaultSeq = 0;
const leg = (p: number, cluster: string, underlying: string, bullish: boolean | null = true): CorrLeg => ({
  vault: `0x${(++vaultSeq).toString(16).padStart(40, "0")}`,
  probWad: BigInt(Math.round(p * 1e18)),
  cluster,
  underlying,
  bullish,
});

function multiplier(legs: CorrLeg[]): number {
  const joint = jointProbWad(legs, TABLE, BAND);
  const edge = edgeBreakdown(legs.length, EDGE, LEG_EDGE);
  const r = priceParlay(joint, STAKE, totalEdgeBps(edge), MIN_PREMIUM);
  assert.ok(r.ok, `expected a price, got ${r.ok ? "ok" : r.reason}`);
  return Number(r.maxPayout) / Number(r.premium);
}

const BTC = (p: number, b = true) => leg(p, "crypto", "BTC", b);
const ETH = (p: number, b = true) => leg(p, "crypto", "ETH", b);
const NVDA = (p: number, b = true) => leg(p, "equity", "NVDA", b);
const SP500 = (p: number, b = true) => leg(p, "equity", "SP500", b);

/** Spec table, ~/docs/superpowers/specs/2026-08-22-parlay-correlation-pricing-design.md.
 * Wide tolerance: these pin behaviour and rough magnitude, not the quadrature's
 * last digit. A loadings change should move them and force a deliberate update. */
const GOLDEN: [string, CorrLeg[], number][] = [
  ["BTC yes + NVDA yes + SP500 yes", [BTC(0.5), NVDA(0.132), SP500(0.44)], 12.6],
  ["NVDA yes + SP500 yes", [NVDA(0.132), SP500(0.44)], 7.2],
  ["BTC yes + ETH yes", [BTC(0.5), ETH(0.55)], 2.0],
  ["NVDA yes + SP500 no", [NVDA(0.132), SP500(0.56, false)], 50.7],
  ["BTC yes + ETH no", [BTC(0.5), ETH(0.45, false)], 9.7],
  ["BTC yes + NVDA yes", [BTC(0.5), NVDA(0.132)], 12.5],
];

for (const [name, legs, want] of GOLDEN) {
  test(`golden: ${name} prices near ${want}x`, () => {
    const got = multiplier(legs);
    assert.ok(Math.abs(got - want) / want < 0.05, `${name}: got ${got.toFixed(2)}x, want ~${want}x`);
  });
}

test("correlated legs never pay more than the same legs would if independent", () => {
  const legs = [NVDA(0.132), SP500(0.44)];
  const joint = jointProbWad(legs, TABLE, BAND);
  const product = (BigInt(Math.round(0.132 * 1e18)) * BigInt(Math.round(0.44 * 1e18))) / WAD;
  assert.ok(joint > product, "same-direction correlated legs must raise the joint probability");
});
