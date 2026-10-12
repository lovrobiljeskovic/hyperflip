import assert from "node:assert/strict";
import { test } from "node:test";
import { coreVault } from "../../services/markets.mjs";

test("coreVault: sourceVault when present, else vault", () => {
  assert.equal(coreVault({ vault: "0xleg", sourceVault: "0xcore" }), "0xcore");
  assert.equal(coreVault({ vault: "0xcore" }), "0xcore");
  assert.equal(coreVault({ vault: "0xcore", sourceVault: null }), "0xcore");
});
