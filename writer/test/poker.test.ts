import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { Address, PublicClient } from "viem";
import { Poker, blockRanges, chainFetchers, isStalled, stallThresholdMs, type PokerDeps } from "../src/poker.js";
import { ExposureBook } from "../src/exposure.js";
import { newMetrics } from "../src/server.js";
import { WAD } from "../src/units.js";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const V1 = "0x1111111111111111111111111111111111111111" as Address;
const VAULT = "0x9999999999999999999999999999999999999999" as Address;
const T = "0x3333333333333333333333333333333333333333" as Address;

const tmpDirs: string[] = [];
const tmpDir = (): string => { const d = mkdtempSync(path.join(os.tmpdir(), "parlay-index-")); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

const unexpected = (name: string) => async (): Promise<never> => { throw new Error(`unexpected ${name}`); };
function pokerDeps(overrides: Partial<PokerDeps>): PokerDeps {
  return {
    exposure: new ExposureBook(),
    metrics: newMetrics(),
    fromBlock: 0n,
    indexFile: path.join(tmpDir(), "parlays.json"),
    resolve: async () => {},
    log: () => {},
    fetchEvents: unexpected("fetchEvents"),
    fetchLegs: unexpected("fetchLegs"),
    fetchLegStates: unexpected("fetchLegStates"),
    fetchOpenParlays: unexpected("fetchOpenParlays"),
    ...overrides,
  };
}

test("tick: syncs mint event, resolves dead parlay, releases exposure on resolve event", async () => {
  const resolved: bigint[] = [];
  const exposure = new ExposureBook();
  // Fake chain: tick 1 delivers a mint of parlay #1 (one YES leg on V1, risk 3), leg settles lost;
  // tick 2 delivers its ParlayResolved event.
  let tickNo = 0;
  const deps = pokerDeps({
    exposure,
    resolve: async (id) => { resolved.push(id); },
    fetchEvents: async () => {
      tickNo++;
      if (tickNo === 1) {
        return {
          minted: [{ id: 1n, quoteId: "0xq1", premium: 1n, maxPayout: 4n, taker: T, block: 5n }],
          resolvedIds: [], toBlock: 10n,
        };
      }
      return { minted: [], resolvedIds: [1n], toBlock: 20n };
    },
    fetchLegs: async () => [{ vault: V1, isYes: true }],
    fetchLegStates: async () => new Map([[V1.toLowerCase(), { settled: true, fractionWad: 0n }]]),
  });
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
  const deps = pokerDeps({
    resolve: async (id) => { resolved.push(id); },
    fetchEvents: async () => ({ minted: [{ id: 1n, quoteId: "0xq1", premium: 1n, maxPayout: 4n, taker: T, block: 5n }], resolvedIds: [], toBlock: 10n }),
    fetchLegs: async () => [{ vault: V1, isYes: true }],
    fetchLegStates: async () => new Map([[V1.toLowerCase(), { settled: true, fractionWad: WAD }]]),
  });
  const poker = new Poker(deps);
  await poker.tick();
  assert.deepEqual(resolved, []);
});

test("tick: a failing resolve() does not abort poking the rest of the batch", async () => {
  const V2 = "0x2222222222222222222222222222222222222222" as Address;
  const attempted: bigint[] = [];
  const deps = pokerDeps({
    resolve: async (id) => {
      attempted.push(id);
      if (id === 1n) throw new Error("rpc hiccup");
    },
    fetchEvents: async () => ({
      minted: [
        { id: 1n, quoteId: "0xq1", premium: 1n, maxPayout: 4n, taker: T, block: 5n },
        { id: 2n, quoteId: "0xq2", premium: 1n, maxPayout: 4n, taker: T, block: 5n },
      ],
      resolvedIds: [],
      toBlock: 10n,
    }),
    fetchLegs: async (id) => [{ vault: id === 1n ? V1 : V2, isYes: true }],
    fetchLegStates: async () =>
      new Map([
        [V1.toLowerCase(), { settled: true, fractionWad: 0n }],
        [V2.toLowerCase(), { settled: true, fractionWad: 0n }],
      ]),
  });
  const poker = new Poker(deps);
  await poker.tick();
  assert.deepEqual(attempted, [1n, 2n]); // both attempted despite id 1 throwing
});

test("tick: a resolve() that times out does not stop subsequent ticks from poking again", async () => {
  // Regression for P0-2: the old unbounded waitForTransactionReceipt let a stuck resolveParlay
  // tx hang forever, which hung tick() forever, which stopped the poker dead. With a timeout,
  // resolve() rejects instead of hanging — tick() must still return, and the next tick must
  // still attempt the poke again (the dead parlay stays open until ParlayResolved lands).
  const attempts: bigint[] = [];
  let shouldTimeout = true;
  const deps = pokerDeps({
    resolve: async (id) => {
      attempts.push(id);
      if (shouldTimeout) throw new Error("TimeoutError: waitForTransactionReceipt timed out");
    },
    fetchEvents: async () => ({ minted: [{ id: 1n, quoteId: "0xq1", premium: 1n, maxPayout: 4n, taker: T, block: 5n }], resolvedIds: [], toBlock: 10n }),
    fetchLegs: async () => [{ vault: V1, isYes: true }],
    fetchLegStates: async () => new Map([[V1.toLowerCase(), { settled: true, fractionWad: 0n }]]),
  });
  const poker = new Poker(deps);

  await poker.tick(); // resolve() times out
  assert.deepEqual(attempts, [1n]);
  assert.equal(poker.openCount(), 1); // still open — no ParlayResolved event landed

  shouldTimeout = false;
  await poker.tick(); // next tick retries the poke, this time it succeeds
  assert.deepEqual(attempts, [1n, 1n]);
  assert.equal(poker.openCount(), 1); // still open until the resolve event lands (asserted elsewhere)
});

test("fetchEvents: a failed chunk keeps earlier chunks and resumes there next tick", async () => {
  // Regression for the 8/20 wedge: an all-or-nothing chunk scan meant one rate-limited
  // chunk discarded the whole batch and left nextBlock untouched, so a cold start far
  // behind head never completed a tick and the poker stayed blind to every open parlay.
  const requested: bigint[] = [];
  let failFrom: bigint | null = 200n;
  const publicClient = {
    getBlockNumber: async () => 250n,
    getLogs: async ({ event, fromBlock, toBlock }: { event: { name: string }; fromBlock: bigint; toBlock: bigint }) => {
      assert(toBlock - fromBlock + 1n <= 100n, "public RPC rejects larger ranges");
      if (event.name === "ParlayMinted") requested.push(fromBlock);
      if (fromBlock === failFrom) throw new Error("rate limited");
      if (event.name === "ParlayMinted" && fromBlock === 0n) {
        return [{ args: { id: 1n, quoteId: "0xq1", premium: 1n, maxPayout: 4n, taker: T }, blockNumber: 5n }];
      }
      return [];
    },
  } as unknown as PublicClient;

  const poker = new Poker(pokerDeps({
    ...chainFetchers(publicClient, VAULT, () => {}),
    fetchLegs: async () => [{ vault: V1, isYes: true }],
    fetchLegStates: async () => new Map([[V1.toLowerCase(), { settled: false, fractionWad: 0n }]]),
  }));

  await poker.tick();
  assert.equal(poker.openCount(), 1); // chunk 0's mint survived the chunk-2 failure
  assert.deepEqual(requested, [0n, 100n, 200n]); // stopped at the failure, no retry storm

  failFrom = null;
  requested.length = 0;
  await poker.tick();
  assert.deepEqual(requested, [200n]); // resumed without rescanning completed chunks

  requested.length = 0;
  await poker.tick();
  assert.deepEqual(requested, []); // the final partial chunk reached the head
});

// mainnet-hardening P1-6: a restart with N open parlays on-chain must rebuild `open`
// (and thus the caps) without scanning from deployBlock.
test("seed: rebuilds open (and caps) from on-chain state, then tick resumes at head not deployBlock", async () => {
  const V2 = "0x2222222222222222222222222222222222222222" as Address;
  const exposure = new ExposureBook();
  const requestedFrom: bigint[] = [];
  const deps = pokerDeps({
    exposure,
    fromBlock: 0n, // would rescan from genesis if seed() didn't override nextBlock
    fetchOpenParlays: async () => ({
      open: [
        { id: 5n, legs: [{ vault: V1, isYes: true }], risk: 30n },
        { id: 9n, legs: [{ vault: V2, isYes: false }], risk: 20n },
      ],
      headBlock: 500_000n,
    }),
    fetchEvents: async (fromBlock) => {
      requestedFrom.push(fromBlock);
      return { minted: [], resolvedIds: [], toBlock: fromBlock };
    },
    fetchLegStates: async () => new Map(),
  });
  const poker = new Poker(deps);
  await poker.seed();

  assert.equal(poker.openCount(), 2); // both open parlays rebuilt, N=2
  assert.equal(exposure.perMarket(V1, 0), 30n); // per-market cap sees true exposure immediately
  assert.equal(exposure.perMarket(V2, 0), 20n);

  await poker.tick();
  assert.deepEqual(requestedFrom, [500_001n]); // resumed at head+1, not deployBlock (fromBlock=0n)
});

test("fetchOpenParlays default: reads nextId + parlay(id), keeps only Status.Open ids", async () => {
  const nextId = 4n;
  const parlays: Record<string, { legs: { vault: Address; isYes: boolean }[]; premium: bigint; maxPayout: bigint; status: number }> = {
    "1": { legs: [{ vault: V1, isYes: true }], premium: 1n, maxPayout: 5n, status: 0 }, // Open
    "2": { legs: [{ vault: V1, isYes: true }], premium: 1n, maxPayout: 5n, status: 2 }, // Dead
    "3": { legs: [{ vault: V1, isYes: true }], premium: 1n, maxPayout: 5n, status: 0 }, // Open
    "4": { legs: [{ vault: V1, isYes: true }], premium: 1n, maxPayout: 5n, status: 1 }, // Won
  };
  const publicClient = {
    getBlockNumber: async () => 777n,
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === "nextId") return nextId;
      if (functionName === "parlay") return parlays[(args![0] as bigint).toString()];
      throw new Error(`unexpected readContract call: ${functionName}`);
    },
  } as unknown as PublicClient;
  const exposure = new ExposureBook();

  const poker = new Poker(pokerDeps({
    ...chainFetchers(publicClient, VAULT, () => {}),
    exposure,
  }));
  await poker.seed();

  assert.equal(poker.openCount(), 2); // only ids 1 and 3 are Status.Open
  assert.equal(exposure.perMarket(V1, 0), 8n); // (5-1) + (5-1)
});

test("index: persists taker refs, serves them newest first, and resumes from the checkpoint after restart", async () => {
  const dir = tmpDir();
  const indexFile = path.join(dir, "parlays.json");
  const requestedFrom: bigint[] = [];
  const deps = () => pokerDeps({
    indexFile,
    indexFromBlock: 100n,
    fetchOpenParlays: async () => ({ open: [], headBlock: 500n }),
    fetchEvents: async (fromBlock) => {
      requestedFrom.push(fromBlock);
      return {
        minted: [
          { id: 1n, quoteId: "0xq1", premium: 1n, maxPayout: 4n, taker: T, block: 120n },
          { id: 2n, quoteId: "0xq2", premium: 1n, maxPayout: 4n, taker: V1, block: 130n },
          { id: 3n, quoteId: "0xq3", premium: 1n, maxPayout: 4n, taker: T, block: 140n },
        ],
        resolvedIds: [],
        toBlock: 500n,
      };
    },
    fetchLegs: async () => [{ vault: V1, isYes: true }],
    fetchLegStates: async () => new Map(),
  });

  const first = new Poker(deps());
  await first.seed();
  await first.tick();
  assert.deepEqual(requestedFrom, [100n]); // fresh index starts at PARLAY_INDEX_FROM_BLOCK, not head
  assert.deepEqual(first.parlaysOf(T), [{ id: 3n, block: 140n }, { id: 1n, block: 120n }]);
  assert.deepEqual(first.parlaysOf(T.toUpperCase() as Address), first.parlaysOf(T)); // case-insensitive

  const second = new Poker(deps());
  assert.deepEqual(second.parlaysOf(V1), [{ id: 2n, block: 130n }]); // loaded from disk before any tick
  await second.seed();
  await second.tick();
  assert.deepEqual(requestedFrom, [100n, 501n]); // resumed after the checkpoint (min with head+1)
});

test("blockRanges: single range when span fits", () => {
  assert.deepEqual(blockRanges(10n, 20n, 1000n), [{ from: 10n, to: 20n }]);
});

test("blockRanges: chunks at exact size boundaries, inclusive", () => {
  assert.deepEqual(blockRanges(0n, 2999n, 1000n), [
    { from: 0n, to: 999n },
    { from: 1000n, to: 1999n },
    { from: 2000n, to: 2999n },
  ]);
});

test("blockRanges: partial tail chunk", () => {
  assert.deepEqual(blockRanges(100n, 1150n, 1000n), [
    { from: 100n, to: 1099n },
    { from: 1100n, to: 1150n },
  ]);
});

test("blockRanges: empty when to < from", () => {
  assert.deepEqual(blockRanges(5n, 4n, 1000n), []);
});

test("blockRanges: single block", () => {
  assert.deepEqual(blockRanges(7n, 7n, 1000n), [{ from: 7n, to: 7n }]);
});

test("stallThresholdMs: scales with open count and tick interval, plus fixed margin", () => {
  assert.equal(stallThresholdMs(0, 60_000, 15_000), 15_000 + 120_000);
  assert.equal(stallThresholdMs(3, 60_000, 15_000), 3 * 60_000 + 15_000 + 120_000);
  assert.equal(stallThresholdMs(0, 60_000, 15_000, 5_000), 15_000 + 5_000);
});

test("isStalled: false within threshold, true once elapsed exceeds it", () => {
  const lastTickAt = 1_000_000;
  assert.equal(isStalled(lastTickAt, lastTickAt + 120_000, 120_000), false); // exactly at bound: not yet stalled
  assert.equal(isStalled(lastTickAt, lastTickAt + 120_001, 120_000), true);
  assert.equal(isStalled(lastTickAt, lastTickAt, 120_000), false); // no time elapsed
});

