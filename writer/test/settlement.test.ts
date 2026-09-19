import { test } from "node:test";
import assert from "node:assert/strict";
import { parlayIsDead, parlayIsVoid, type LegState } from "../src/settlement.js";
import { WAD } from "../src/pure.js";
import type { QuoteLeg } from "../src/quotes.js";

const V1 = "0x1111111111111111111111111111111111111111";
const V2 = "0x2222222222222222222222222222222222222222";

const legs: QuoteLeg[] = [
  { vault: V1 as QuoteLeg["vault"], isYes: true },
  { vault: V2 as QuoteLeg["vault"], isYes: false },
];

function states(entries: [string, LegState][]): Map<string, LegState> {
  return new Map(entries.map(([k, v]) => [k.toLowerCase(), v]));
}

test("YES leg lost when settled fraction == 0", () => {
  assert.equal(parlayIsDead(legs, states([[V1, { settled: true, fractionWad: 0n }]])), true);
});

test("NO leg lost when settled fraction == 1e18", () => {
  assert.equal(parlayIsDead(legs, states([[V2, { settled: true, fractionWad: WAD }]])), true);
});

test("unsettled or won or fractional legs are not dead", () => {
  assert.equal(parlayIsDead(legs, states([])), false);
  assert.equal(parlayIsDead(legs, states([[V1, { settled: false, fractionWad: 0n }]])), false);
  assert.equal(parlayIsDead(legs, states([[V1, { settled: true, fractionWad: WAD }]])), false); // YES hit
  assert.equal(parlayIsDead(legs, states([[V1, { settled: true, fractionWad: WAD / 2n }]])), false); // fractional -> VOID path, not dead
});

test("void when all legs settled, none lost, one fractional", () => {
  const half: LegState = { settled: true, fractionWad: WAD / 2n };
  const yesHit: LegState = { settled: true, fractionWad: WAD };
  const noHit: LegState = { settled: true, fractionWad: 0n };
  // V1 is a YES leg, V2 a NO leg.
  assert.equal(parlayIsVoid(legs, states([[V1, yesHit], [V2, half]])), true);
  assert.equal(parlayIsVoid(legs, states([[V1, half], [V2, noHit]])), true);
  // all hit -> Won, not void
  assert.equal(parlayIsVoid(legs, states([[V1, yesHit], [V2, noHit]])), false);
  // a lost leg wins over fractional -> Dead, not void
  assert.equal(parlayIsVoid(legs, states([[V1, noHit], [V2, half]])), false);
  // still open legs -> not resolvable yet
  assert.equal(parlayIsVoid(legs, states([[V1, half]])), false);
});
