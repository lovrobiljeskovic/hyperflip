import { test } from "node:test";
import assert from "node:assert/strict";
import { bankrollRoom, lowBankrollAlerter } from "../src/bankroll.js";

test("bankrollRoom is min(allowance, balance)", () => {
  assert.equal(bankrollRoom(500n, 200n), 200n);
  assert.equal(bankrollRoom(100n, 200n), 100n);
});

test("lowBankrollAlerter fires once per dip and re-arms on recovery", () => {
  const alert = lowBankrollAlerter(100n);
  assert.equal(alert(150n), false);
  assert.equal(alert(50n), true);
  assert.equal(alert(10n), false);
  assert.equal(alert(100n), false);
  assert.equal(alert(99n), true);
});
