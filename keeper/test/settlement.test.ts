import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { createSettlementLoop } from "../src/settlement.js";
import type { KeeperState } from "../src/state.js";

const VAULT = "0x1111111111111111111111111111111111111111" as Address;
const LEG = "0x2222222222222222222222222222222222222222" as Address;

test("relays wait for state.elysiumClient to be set after the loop is built, settlement does not", async () => {
  let legReads = 0;
  const elysium = { readContract: async () => { legReads++; return true; } };
  const state = {
    config: {
      vaultAddresses: [VAULT], legs: new Map([[VAULT, LEG]]), marketExpiries: new Map(),
      settlementRelay: "0x3333333333333333333333333333333333333333", settlementCachePath: "/dev/null",
    },
    elysiumClient: undefined,
    vaultInfo: new Map([[VAULT, { outcome: 1, question: 1, evmUnitsPerShare: 1n, verifier: VAULT }]]),
    settledVaults: new Set<Address>(),
    lastKnownFraction: new Map(),
    readVault: async () => true, // every vault reads settled: the tick goes straight to relayIfNeeded
  } as unknown as KeeperState;
  const loop = createSettlementLoop(state);

  await loop.tick(); // Elysium unverified: settlement path runs, no leg read
  assert.equal(state.settledVaults.has(VAULT), true);
  assert.equal(legReads, 0);

  state.elysiumClient = elysium as unknown as KeeperState["elysiumClient"]; // background check passed
  await loop.tick();
  assert.equal(legReads, 1);
});
