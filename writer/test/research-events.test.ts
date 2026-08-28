import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Address } from "viem";
import { appendQuoteDecision, joinEvents, type JoinDeps } from "../src/research/journal.js";
import type { QuoteDecision } from "../src/research/types.js";

const VAULT = "0x9999999999999999999999999999999999999999" as Address;
const TAKER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const WAD = 1_000_000_000_000_000_000n;

type FakeLog = { blockNumber: bigint; blockHash: `0x${string}`; transactionHash: `0x${string}`; logIndex: number; args: Record<string, bigint | string> };

class FakeChain {
  head = 1003n;
  failFrom: bigint | null = null;
  requests: { from: bigint; to: bigint; event: string }[] = [];
  readonly hashes = new Map<bigint, `0x${string}`>();
  readonly logs: { minted: FakeLog[]; resolved: FakeLog[] } = { minted: [], resolved: [] };
  readonly parlays = new Map<bigint, { legs: { vault: Address; isYes: boolean }[]; premium: bigint; maxPayout: bigint; status: number }>();
  readonly states = new Map<string, { settled: boolean; fraction: bigint }>();

  constructor() {
    for (let block = 0n; block <= 2000n; block++) this.hashes.set(block, hash(block));
  }

  async getBlockNumber(): Promise<bigint> { return this.head; }
  async getBlock({ blockNumber }: { blockNumber: bigint }): Promise<{ hash: `0x${string}` }> {
    return { hash: this.hashes.get(blockNumber)! };
  }
  async getLogs({ event, fromBlock, toBlock }: { event: { name: string }; fromBlock: bigint; toBlock: bigint }): Promise<FakeLog[]> {
    if (toBlock - fromBlock + 1n > 1000n) throw new Error("range exceeds 1,000 blocks");
    this.requests.push({ from: fromBlock, to: toBlock, event: event.name });
    if (this.failFrom === fromBlock) throw new Error("simulated RPC failure");
    const logs = event.name === "ParlayMinted" ? this.logs.minted : this.logs.resolved;
    return logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock);
  }
  async readContract({ address, functionName, args }: { address: Address; functionName: string; args?: readonly bigint[] }): Promise<unknown> {
    if (functionName === "parlay") return this.parlays.get(args![0])!;
    const state = this.states.get(address.toLowerCase()) ?? { settled: false, fraction: 0n };
    if (functionName === "settled") return state.settled;
    if (functionName === "settleFractionWad") return state.fraction;
    throw new Error(`unexpected read: ${functionName}`);
  }
}

function hash(block: bigint): `0x${string}` { return `0x${block.toString(16).padStart(64, "0")}`; }
function tx(id: number): `0x${string}` { return `0x${id.toString(16).padStart(64, "0")}`; }

function quote(quoteId: string): QuoteDecision {
  return {
    schemaVersion: 1, recordedAtMs: 1_725_000_000_000, quoteId, quoteDigest: "0x02", chainId: 31337,
    parlayVault: VAULT, taker: TAKER, legs: [], bookInputs: [], modelVersion: "fixture", dataAsOf: "2024-08-09T00:00:00.000Z",
    dataManifestSha256: "a".repeat(64), sourceRegistrySha256: "b".repeat(64), bestEstimateJointProbWad: "1", riskAdjustedJointProbWad: "1", rhoBandPct: 0,
    edge: { baseBps: "0", legBps: "0", totalBps: "0" }, premium: "1", maxPayout: "4", deadline: "1", signatureHash: "c".repeat(64),
  };
}

function deps(chain: FakeChain): JoinDeps {
  return { client: chain as unknown as JoinDeps["client"], vault: VAULT, deployBlock: 0n, now: () => 1_725_000_000_000 };
}

function addMint(chain: FakeChain, id: bigint, quoteId: string, block: bigint): void {
  const leg = "0x1111111111111111111111111111111111111111" as Address;
  chain.parlays.set(id, { legs: [{ vault: leg, isYes: true }], premium: 1n, maxPayout: 4n, status: 0 });
  chain.logs.minted.push({ blockNumber: block, blockHash: hash(block), transactionHash: tx(Number(id)), logIndex: 0, args: { id, quoteId, taker: TAKER, premium: 1n, maxPayout: 4n } });
}

test("event resume: checkpoints an inclusive 1,001-block scan before a later RPC failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "hype-event-resume-"));
  const chain = new FakeChain();
  addMint(chain, 1n, "0x01", 1n);
  chain.logs.resolved.push({ blockNumber: 2n, blockHash: hash(2n), transactionHash: tx(2), logIndex: 1, args: { id: 1n, status: 2n } });
  appendQuoteDecision(root, quote("0x01"));
  chain.failFrom = 1000n;

  await assert.rejects(joinEvents(root, deps(chain)), /simulated RPC failure/);
  assert.deepEqual(chain.requests.filter((request) => request.event === "ParlayMinted").map(({ from, to }) => [from, to]), [[0n, 999n], [1000n, 1001n]]);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "state", "event-joiner.json"), "utf8")), {
    schemaVersion: 1, nextBlock: "1000",
    pending: [{ quoteId: "0x01", parlayId: "1", vault: "0x1111111111111111111111111111111111111111", isYes: true }],
  });

  chain.failFrom = null;
  chain.requests.length = 0;
  await joinEvents(root, deps(chain));
  assert.deepEqual(chain.requests.filter((request) => request.event === "ParlayMinted").map(({ from, to }) => [from, to]), [[990n, 1001n]]);
  const events = readFileSync(join(root, "journal", "events", "2024", "08", "30.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.kind === "minted").length, 1);
  const minted = events.find((event) => event.kind === "minted");
  assert.equal(minted.quoteId, "0x01");
  assert.equal(minted.parlayId, "1");
  assert.equal(minted.transactionHash, tx(1));
  assert.equal(minted.premium, "1");
  assert.equal(minted.maxPayout, "4");
  assert.equal(minted.taker, TAKER);
});

test("event join: preserves confirmed canonical records when rerun", async () => {
  const root = mkdtempSync(join(tmpdir(), "hype-event-idempotent-"));
  const chain = new FakeChain();
  addMint(chain, 1n, "0x01", 1n);
  appendQuoteDecision(root, quote("0x01"));
  await joinEvents(root, deps(chain));
  const file = join(root, "journal", "events", "2024", "08", "30.jsonl");
  const first = readFileSync(file, "utf8");
  await joinEvents(root, deps(chain));
  assert.equal(readFileSync(file, "utf8"), first);
});

test("void outcome: reads each leg at one confirmed block, delays detail, and restores orphaned observations to pending", async () => {
  const root = mkdtempSync(join(tmpdir(), "hype-event-outcome-"));
  const chain = new FakeChain();
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/research/parlay-events.json", import.meta.url), "utf8")) as { parlays: { id: string; quoteId: string; status: "won" | "dead" | "void"; legs: { vault: Address; isYes: boolean; fraction: string | null }[] }[] };
  for (const [index, p] of fixture.parlays.entries()) {
    const id = BigInt(p.id);
    appendQuoteDecision(root, quote(p.quoteId));
    chain.parlays.set(id, { legs: p.legs.map(({ vault, isYes }) => ({ vault, isYes })), premium: 1n, maxPayout: 4n, status: p.status === "won" ? 1 : p.status === "dead" ? 2 : 3 });
    chain.logs.minted.push({ blockNumber: 1n + BigInt(index), blockHash: hash(1n + BigInt(index)), transactionHash: tx(index + 1), logIndex: 0, args: { id, quoteId: p.quoteId, taker: TAKER, premium: 1n, maxPayout: 4n } });
    chain.logs.resolved.push({ blockNumber: 10n + BigInt(index), blockHash: hash(10n + BigInt(index)), transactionHash: tx(index + 10), logIndex: 1, args: { id, status: BigInt(p.status === "won" ? 1 : p.status === "dead" ? 2 : 3) } });
    for (const leg of p.legs) if (leg.fraction !== null) chain.states.set(leg.vault.toLowerCase(), { settled: true, fraction: BigInt(leg.fraction) });
  }
  await joinEvents(root, deps(chain));
  const first = await joinEvents(root, deps(chain));
  assert.deepEqual(first.resolutions["0x01"], { status: "won", allLegsFinal: true });
  assert.deepEqual(first.resolutions["0x02"], { status: "dead", allLegsFinal: false });
  assert.deepEqual(first.resolutions["0x03"], { status: "void", allLegsFinal: false });

  const eventFile = join(root, "journal", "events", "2024", "08", "30.jsonl");
  let records = readFileSync(eventFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.find((record) => record.kind === "resolved" && record.parlayId === "1").legs[0].result, "win");
  assert.equal(records.find((record) => record.kind === "resolved" && record.parlayId === "3").legs[0].result, "void");
  assert.equal(records.find((record) => record.kind === "leg-finalized" && record.parlayId === "1").observedBlockNumber, "10");
  assert.equal(records.find((record) => record.kind === "leg-finalized" && record.parlayId === "3").settleFractionWad, "500000000000000000");
  assert.ok(!records.some((record) => record.kind === "leg-finalized" && record.parlayId === "2" && record.vault.endsWith("3333")));

  const deadLate = fixture.parlays[1].legs[1];
  const voidLate = fixture.parlays[2].legs[1];
  chain.states.set(deadLate.vault.toLowerCase(), { settled: true, fraction: 0n }); // NO win
  chain.states.set(voidLate.vault.toLowerCase(), { settled: true, fraction: WAD }); // NO loss
  chain.head = 1015n;
  const final = await joinEvents(root, deps(chain));
  assert.deepEqual(final.resolutions["0x02"], { status: "dead", allLegsFinal: true });
  assert.deepEqual(final.resolutions["0x03"], { status: "void", allLegsFinal: true });

  records = readFileSync(eventFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const observed = records.find((record) => record.kind === "leg-finalized" && record.parlayId === "2" && record.vault === deadLate.vault);
  chain.hashes.set(BigInt(observed.observedBlockNumber), "0x" + "f".repeat(64) as `0x${string}`);
  chain.states.set(deadLate.vault.toLowerCase(), { settled: false, fraction: 0n });
  const reorged = await joinEvents(root, deps(chain));
  assert.deepEqual(reorged.resolutions["0x02"], { status: "dead", allLegsFinal: false });
  records = readFileSync(eventFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(records.some((record) => record.kind === "orphaned" && record.targetKind === "state-observation" && record.targetKey === observed.observationKey));
  assert.ok(existsSync(join(root, "state", "event-joiner.json")));
  chain.states.set(deadLate.vault.toLowerCase(), { settled: true, fraction: 0n });
  const reobserved = await joinEvents(root, deps(chain));
  assert.deepEqual(reobserved.resolutions["0x02"], { status: "dead", allLegsFinal: true });
});
