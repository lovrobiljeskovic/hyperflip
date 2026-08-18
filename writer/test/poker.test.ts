import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { Poker, type PokerDeps } from "../src/poker.js";
import { ExposureBook } from "../src/exposure.js";
import { newMetrics } from "../src/server.js";
import { WAD } from "../src/pure.js";

const V1 = "0x1111111111111111111111111111111111111111" as Address;
const VAULT = "0x9999999999999999999999999999999999999999" as Address;

test("tick: syncs mint event, resolves dead parlay, releases exposure on resolve event", async () => {
  const resolved: bigint[] = [];
  const exposure = new ExposureBook();
  // Fake chain: tick 1 delivers a mint of parlay #1 (one YES leg on V1, risk 3), leg settles lost;
  // tick 2 delivers its ParlayResolved event.
  let tickNo = 0;
  const deps: PokerDeps = {
    publicClient: null as unknown as PokerDeps["publicClient"], // unused: reads are injected below
    parlayVault: VAULT,
    exposure,
    metrics: newMetrics(),
    fromBlock: 0n,
    resolve: async (id) => { resolved.push(id); },
    log: () => {},
    // injected reads (see PokerDeps below — these have fake-friendly defaults in prod wiring)
    fetchEvents: async () => {
      tickNo++;
      if (tickNo === 1) {
        return {
          minted: [{ id: 1n, quoteId: "0xq1", premium: 1n, maxPayout: 4n }],
          resolvedIds: [], toBlock: 10n,
        };
      }
      return { minted: [], resolvedIds: [1n], toBlock: 20n };
    },
    fetchLegs: async () => [{ vault: V1, isYes: true }],
    fetchLegStates: async () => new Map([[V1.toLowerCase(), { settled: true, fractionWad: 0n }]]),
  };
  const poker = new Poker(deps);

  await poker.tick();
  assert.equal(poker.openCount(), 1);
  assert.equal(exposure.perMarket(V1, 0), 3n); // risk = maxPayout - premium
  assert.deepEqual(resolved, [1n]); // dead -> poked

  await poker.tick();
  assert.equal(poker.openCount(), 0);
  assert.equal(exposure.perMarket(V1, 0), 0n); // released on resolve
});

test("tick: won/unsettled parlays are not poked", async () => {
  const resolved: bigint[] = [];
  const deps: PokerDeps = {
    publicClient: null as unknown as PokerDeps["publicClient"],
    parlayVault: VAULT,
    exposure: new ExposureBook(),
    metrics: newMetrics(),
    fromBlock: 0n,
    resolve: async (id) => { resolved.push(id); },
    log: () => {},
    fetchEvents: async () => ({ minted: [{ id: 1n, quoteId: "0xq1", premium: 1n, maxPayout: 4n }], resolvedIds: [], toBlock: 10n }),
    fetchLegs: async () => [{ vault: V1, isYes: true }],
    fetchLegStates: async () => new Map([[V1.toLowerCase(), { settled: true, fractionWad: WAD }]]),
  };
  const poker = new Poker(deps);
  await poker.tick();
  assert.deepEqual(resolved, []);
});
