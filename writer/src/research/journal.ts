import { createHash } from "node:crypto";
import { parseAbiItem, type Address, type PublicClient } from "viem";
import { parlayVaultAbi, outcomeVaultAbi } from "../abi.js";
import { WAD, blockRanges } from "../pure.js";
import { openResearchPersistence, type ResearchPersistence } from "./persistence.js";
import { canonicalJson, operationError, writeOperationState } from "./store.js";
import { assertJoinedEventRecord } from "./types.js";
import type { ChainLogRecord, JoinedEventRecord, OrphanCorrectionRecord, QuoteDecision, StateObservationRecord } from "./types.js";

export interface PublicQuoteDecision extends Omit<QuoteDecision, "taker" | "quoteDigest" | "signatureHash" | "bookInputs" | "modelVersion" | "dataAsOf" | "dataManifestSha256" | "sourceRegistrySha256" | "bestEstimateJointProbWad" | "riskAdjustedJointProbWad" | "rhoBandPct" | "edge"> {
  taker: string;
  resolution: { status: "open" | "won" | "dead" | "void"; allLegsFinal: boolean };
  quoteDigest?: string;
  signatureHash?: string;
  bookInputs?: QuoteDecision["bookInputs"];
  modelVersion?: string;
  dataAsOf?: string;
  dataManifestSha256?: string;
  sourceRegistrySha256?: string;
  bestEstimateJointProbWad?: string;
  riskAdjustedJointProbWad?: string;
  rhoBandPct?: number;
  edge?: QuoteDecision["edge"];
}

export function initializeQuoteJournal(root: string): ResearchPersistence {
  return openResearchPersistence(root);
}

export function appendQuoteDecision(storage: ResearchPersistence, decision: QuoteDecision): void {
  const date = new Date(decision.recordedAtMs);
  storage.append(`journal/quotes/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}.jsonl`, canonicalJson(decision));
}

export type ChainEvent = {
  kind: "minted";
  blockNumber: bigint;
  blockHash: `0x${string}`;
  transactionHash: `0x${string}`;
  logIndex: number;
  id: bigint;
  quoteId: string;
  taker: string;
  premium: bigint;
  maxPayout: bigint;
} | {
  kind: "resolved";
  blockNumber: bigint;
  blockHash: `0x${string}`;
  transactionHash: `0x${string}`;
  logIndex: number;
  id: bigint;
  status: bigint;
};

export interface JoinDeps {
  client: PublicClient;
  vault: Address;
  deployBlock: bigint;
  now?: () => number;
}

export interface JoinSummary {
  scannedFrom: string | null;
  scannedTo: string | null;
  nextBlock: string;
  appended: number;
  resolutions: Record<string, PublicQuoteDecision["resolution"]>;
}

interface PendingLeg {
  quoteId: string;
  parlayId: string;
  vault: string;
  isYes: boolean;
}

interface EventJoinerState {
  schemaVersion: 1;
  nextBlock: string;
  pending: PendingLeg[];
}

const MINTED = parseAbiItem("event ParlayMinted(uint256 indexed id, address indexed taker, bytes32 quoteId, uint96 premium, uint96 maxPayout)");
const RESOLVED = parseAbiItem("event ParlayResolved(uint256 indexed id, uint8 status)");
const CONFIRMATIONS = 2n;
const OVERLAP = 10n;
const CHUNK_SIZE = 1000n;

function eventKey(transactionHash: string, logIndex: number): string {
  return `${transactionHash.toLowerCase()}:${logIndex}`;
}

function readState(storage: ResearchPersistence, deployBlock: bigint): EventJoinerState {
  if (!storage.exists("state/event-joiner.json")) return { schemaVersion: 1, nextBlock: deployBlock.toString(), pending: [] };
  const state = JSON.parse(storage.readText("state/event-joiner.json")) as EventJoinerState;
  if (state.schemaVersion !== 1 || !/^\d+$/.test(state.nextBlock) || !Array.isArray(state.pending)) throw new Error("event joiner state is invalid");
  return state;
}

function writeState(storage: ResearchPersistence, state: EventJoinerState): void {
  storage.writeAtomic("state/event-joiner.json", canonicalJson(state));
}

function readJsonl<T>(storage: ResearchPersistence, relative: string): T[] {
  return storage.list(relative).flatMap((file) => {
    const text = storage.readText(file).trim();
    return text ? text.split("\n").map((line) => JSON.parse(line) as T) : [];
  });
}

function appendEventRecord(storage: ResearchPersistence, record: JoinedEventRecord): void {
  assertJoinedEventRecord(record);
  const date = new Date(record.recordedAtMs);
  storage.append(`journal/events/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}.jsonl`, canonicalJson(record));
}

const physicalChainKey = (record: Pick<ChainLogRecord, "eventKey" | "blockHash">): string => `${record.eventKey}:${record.blockHash.toLowerCase()}`;

function activeRecords(records: JoinedEventRecord[]): { chain: ChainLogRecord[]; observations: StateObservationRecord[] } {
  const orphaned = new Set(records.filter((record): record is OrphanCorrectionRecord => record.kind === "orphaned").map((record) => `${record.targetKind}:${record.targetKey}`));
  return {
    chain: records.filter((record): record is ChainLogRecord => (record.kind === "minted" || record.kind === "resolved") && !orphaned.has(`chain-log:${physicalChainKey(record)}`)),
    observations: records.filter((record): record is StateObservationRecord => record.kind === "leg-finalized" && !orphaned.has(`state-observation:${record.observationKey}`)),
  };
}

async function canonicalHash(client: PublicClient, blockNumber: bigint): Promise<string> {
  const block = await client.getBlock({ blockNumber });
  if (!block.hash) throw new Error(`canonical block ${blockNumber} has no hash`);
  return block.hash.toLowerCase();
}

async function verifyOverlap(storage: ResearchPersistence, client: PublicClient, from: bigint, to: bigint, now: number): Promise<number> {
  const records = readJsonl<JoinedEventRecord>(storage, "journal/events");
  const active = activeRecords(records);
  let appended = 0;
  for (const record of [...active.chain, ...active.observations]) {
    const blockNumber = BigInt(record.kind === "leg-finalized" ? record.observedBlockNumber : record.blockNumber);
    if (blockNumber < from || blockNumber > to) continue;
    const storedHash = record.kind === "leg-finalized" ? record.observedBlockHash : record.blockHash;
    const hash = await canonicalHash(client, blockNumber);
    if (hash === storedHash.toLowerCase()) continue;
    const correction: OrphanCorrectionRecord = {
      schemaVersion: 1, kind: "orphaned", targetKind: record.kind === "leg-finalized" ? "state-observation" : "chain-log",
      targetKey: record.kind === "leg-finalized" ? record.observationKey : physicalChainKey(record),
      detectedAtBlockNumber: to.toString(), canonicalBlockHash: hash, recordedAtMs: now,
    };
    appendEventRecord(storage, correction);
    records.push(correction);
    appended++;
  }
  return appended;
}

/** Reads both ParlayVault event streams for one inclusive, 1,000-block-or-less range. */
export async function scanEventChunk(client: PublicClient, vault: Address, from: bigint, to: bigint): Promise<ChainEvent[]> {
  if (to < from) return [];
  if (to - from + 1n > CHUNK_SIZE) throw new Error("event scan range exceeds 1,000 blocks");
  const [minted, resolved] = await Promise.all([
    client.getLogs({ address: vault, event: MINTED, fromBlock: from, toBlock: to }),
    client.getLogs({ address: vault, event: RESOLVED, fromBlock: from, toBlock: to }),
  ]);
  return [
    ...minted.map((log) => ({
      kind: "minted" as const, blockNumber: log.blockNumber!, blockHash: log.blockHash!, transactionHash: log.transactionHash!, logIndex: Number(log.logIndex),
      id: log.args.id!, quoteId: log.args.quoteId!, taker: log.args.taker!, premium: log.args.premium!, maxPayout: log.args.maxPayout!,
    })),
    ...resolved.map((log) => ({
      kind: "resolved" as const, blockNumber: log.blockNumber!, blockHash: log.blockHash!, transactionHash: log.transactionHash!, logIndex: Number(log.logIndex),
      id: log.args.id!, status: BigInt(log.args.status!),
    })),
  ].sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);
}

function status(value: bigint): ChainLogRecord["status"] {
  if (value === 1n) return "won";
  if (value === 2n) return "dead";
  if (value === 3n) return "void";
  throw new Error(`unexpected ParlayResolved status: ${value}`);
}

function legResult(isYes: boolean, fraction: bigint): "win" | "loss" | "void" {
  if (fraction !== 0n && fraction !== WAD) return "void";
  return isYes === (fraction === WAD) ? "win" : "loss";
}

async function parlayAt(client: PublicClient, vault: Address, id: bigint, blockNumber: bigint): Promise<{ legs: { vault: Address; isYes: boolean }[]; premium: bigint; maxPayout: bigint }> {
  return client.readContract({ address: vault, abi: parlayVaultAbi, functionName: "parlay", args: [id], blockNumber }) as Promise<{ legs: { vault: Address; isYes: boolean }[]; premium: bigint; maxPayout: bigint }>;
}

async function observedLegs(client: PublicClient, legs: { vault: Address; isYes: boolean }[], blockNumber: bigint): Promise<ChainLogRecord["legs"]> {
  return Promise.all(legs.map(async (leg) => {
    const [settled, fraction] = await Promise.all([
      client.readContract({ address: leg.vault, abi: outcomeVaultAbi, functionName: "settled", blockNumber }) as Promise<boolean>,
      client.readContract({ address: leg.vault, abi: outcomeVaultAbi, functionName: "settleFractionWad", blockNumber }) as Promise<bigint>,
    ]);
    return { vault: leg.vault, isYes: leg.isYes, settled, settleFractionWad: settled ? fraction.toString() : null, result: settled ? legResult(leg.isYes, fraction) : "pending" };
  }));
}

function appendIfNew(storage: ResearchPersistence, records: JoinedEventRecord[], record: JoinedEventRecord): boolean {
  const active = activeRecords(records);
  const exists = record.kind === "leg-finalized"
    ? active.observations.some((existing) => existing.observationKey === record.observationKey)
    : record.kind === "orphaned"
      ? records.some((existing) => existing.kind === "orphaned" && existing.targetKind === record.targetKind && existing.targetKey === record.targetKey)
      : active.chain.some((existing) => existing.eventKey === record.eventKey);
  if (exists) return false;
  appendEventRecord(storage, record);
  records.push(record);
  return true;
}

function currentParlays(records: JoinedEventRecord[]): { minted: Map<string, ChainLogRecord>; resolved: Map<string, ChainLogRecord>; observations: Map<string, StateObservationRecord> } {
  const active = activeRecords(records);
  const minted = new Map<string, ChainLogRecord>();
  const resolved = new Map<string, ChainLogRecord>();
  const observations = new Map<string, StateObservationRecord>();
  for (const record of active.chain) (record.kind === "minted" ? minted : resolved).set(record.parlayId, record);
  for (const record of active.observations) observations.set(`${record.parlayId}:${record.vault.toLowerCase()}`, record);
  return { minted, resolved, observations };
}

function pendingAndResolutions(records: JoinedEventRecord[], knownQuoteIds: Set<string>): { pending: PendingLeg[]; resolutions: JoinSummary["resolutions"] } {
  const { minted, resolved, observations } = currentParlays(records);
  const pending: PendingLeg[] = [];
  const resolutions: JoinSummary["resolutions"] = {};
  for (const [parlayId, record] of resolved) {
    const mint = minted.get(parlayId);
    const quoteId = mint?.quoteId ?? record.quoteId;
    const unresolved = record.legs.filter((leg) => !observations.has(`${parlayId}:${leg.vault.toLowerCase()}`));
    pending.push(...unresolved.map((leg) => ({ quoteId, parlayId, vault: leg.vault, isYes: leg.isYes })));
    if (knownQuoteIds.has(quoteId)) resolutions[quoteId] = { status: record.status!, allLegsFinal: unresolved.length === 0 };
  }
  return { pending, resolutions };
}

/** Appends canonical chain facts and resumable state without rewriting prior history. */
async function joinEventsImpl(storage: ResearchPersistence, deps: JoinDeps): Promise<JoinSummary> {
  const now = (deps.now ?? Date.now)();
  const state = readState(storage, deps.deployBlock);
  const head = await deps.client.getBlockNumber();
  const confirmed = head - CONFIRMATIONS;
  if (confirmed < deps.deployBlock) return { scannedFrom: null, scannedTo: null, nextBlock: state.nextBlock, appended: 0, resolutions: {} };
  const nextBlock = BigInt(state.nextBlock);
  const from = nextBlock > deps.deployBlock ? nextBlock - OVERLAP : deps.deployBlock;
  let appended = await verifyOverlap(storage, deps.client, from, confirmed, now);
  let scannedTo: bigint | null = null;
  const records = readJsonl<JoinedEventRecord>(storage, "journal/events");
  const quoteIds = new Set(readJsonl<QuoteDecision>(storage, "journal/quotes").map((quote) => quote.quoteId));
  for (const range of blockRanges(from, confirmed, CHUNK_SIZE)) {
    const events = await scanEventChunk(deps.client, deps.vault, range.from, range.to);
    for (const event of events) {
      if ((await canonicalHash(deps.client, event.blockNumber)) !== event.blockHash.toLowerCase()) continue;
      if (event.kind === "minted") {
        const parlay = await parlayAt(deps.client, deps.vault, event.id, event.blockNumber);
        const record: ChainLogRecord = {
          schemaVersion: 1, kind: "minted", eventKey: eventKey(event.transactionHash, event.logIndex), blockNumber: event.blockNumber.toString(), blockHash: event.blockHash,
          transactionHash: event.transactionHash, logIndex: event.logIndex, quoteId: event.quoteId, parlayId: event.id.toString(), taker: event.taker,
          premium: event.premium.toString(), maxPayout: event.maxPayout.toString(), status: "open",
          legs: parlay.legs.map((leg) => ({ vault: leg.vault, isYes: leg.isYes, settled: false, settleFractionWad: null, result: "pending" })), recordedAtMs: now,
        };
        if (appendIfNew(storage, records, record)) appended++;
      } else {
        const current = currentParlays(records);
        const mint = current.minted.get(event.id.toString());
        const parlay = await parlayAt(deps.client, deps.vault, event.id, event.blockNumber);
        const legs = await observedLegs(deps.client, parlay.legs, event.blockNumber);
        const record: ChainLogRecord = {
          schemaVersion: 1, kind: "resolved", eventKey: eventKey(event.transactionHash, event.logIndex), blockNumber: event.blockNumber.toString(), blockHash: event.blockHash,
          transactionHash: event.transactionHash, logIndex: event.logIndex, quoteId: mint?.quoteId ?? "", parlayId: event.id.toString(), taker: mint?.taker ?? null,
          premium: mint?.premium ?? parlay.premium.toString(), maxPayout: mint?.maxPayout ?? parlay.maxPayout.toString(), status: status(event.status), legs, recordedAtMs: now,
        };
        if (appendIfNew(storage, records, record)) appended++;
        for (const leg of legs) {
          if (!leg.settled) continue;
          const observation: StateObservationRecord = {
            schemaVersion: 1, kind: "leg-finalized", observationKey: `${event.id}:${leg.vault.toLowerCase()}:${event.blockNumber}:${event.blockHash.toLowerCase()}`,
            observedBlockNumber: event.blockNumber.toString(), observedBlockHash: event.blockHash.toLowerCase(), quoteId: record.quoteId, parlayId: record.parlayId,
            vault: leg.vault, settleFractionWad: leg.settleFractionWad!, result: leg.result as "win" | "loss" | "void", recordedAtMs: now,
          };
          if (appendIfNew(storage, records, observation)) appended++;
        }
      }
    }
    scannedTo = range.to;
    writeState(storage, { schemaVersion: 1, nextBlock: (range.to + 1n).toString(), pending: pendingAndResolutions(records, quoteIds).pending });
  }

  let joined = pendingAndResolutions(records, quoteIds);
  for (const leg of joined.pending) {
    const fraction = await deps.client.readContract({ address: leg.vault as Address, abi: outcomeVaultAbi, functionName: "settleFractionWad", blockNumber: confirmed }) as bigint;
    const settled = await deps.client.readContract({ address: leg.vault as Address, abi: outcomeVaultAbi, functionName: "settled", blockNumber: confirmed }) as boolean;
    if (!settled) continue;
    const hash = await canonicalHash(deps.client, confirmed);
    const record: StateObservationRecord = {
      schemaVersion: 1, kind: "leg-finalized", observationKey: `${leg.parlayId}:${leg.vault.toLowerCase()}:${confirmed}:${hash}`,
      observedBlockNumber: confirmed.toString(), observedBlockHash: hash, quoteId: leg.quoteId, parlayId: leg.parlayId, vault: leg.vault,
      settleFractionWad: fraction.toString(), result: legResult(leg.isYes, fraction), recordedAtMs: now,
    };
    if (appendIfNew(storage, records, record)) appended++;
  }
  joined = pendingAndResolutions(records, quoteIds);
  const finalState: EventJoinerState = { schemaVersion: 1, nextBlock: scannedTo === null ? state.nextBlock : (scannedTo + 1n).toString(), pending: joined.pending };
  writeState(storage, finalState);
  return { scannedFrom: from.toString(), scannedTo: scannedTo?.toString() ?? null, nextBlock: finalState.nextBlock, appended, resolutions: joined.resolutions };
}

export async function joinEvents(root: string, deps: JoinDeps): Promise<JoinSummary> {
  const storage = openResearchPersistence(root);
  const now = deps.now ?? Date.now;
  const started = now();
  const persist = (status: "running" | "succeeded" | "failed", error: string | null, details: Record<string, string | number | boolean | null> = {}): void => {
    const at = status === "running" ? started : now();
    writeOperationState(root, "join.json", { schemaVersion: 1, operation: "join", status, startedAt: new Date(started).toISOString(), endedAt: status === "running" ? null : new Date(at).toISOString(), error, details }, storage);
  };
  persist("running", null);
  try {
    const summary = await joinEventsImpl(storage, { ...deps, now: () => started });
    persist("succeeded", null, { appended: summary.appended, nextBlock: summary.nextBlock });
    return summary;
  } catch (error) {
    persist("failed", operationError(error));
    throw error;
  }
}

export function redactQuoteDecision(
  decision: QuoteDecision,
  resolution: PublicQuoteDecision["resolution"],
  salt: string,
): PublicQuoteDecision {
  if (!salt) throw new Error("export salt is required");
  const { taker, quoteDigest, signatureHash, bookInputs, modelVersion, dataAsOf, dataManifestSha256, sourceRegistrySha256, bestEstimateJointProbWad, riskAdjustedJointProbWad, rhoBandPct, edge, ...publicDecision } = decision;
  const redacted: PublicQuoteDecision = {
    ...publicDecision,
    taker: createHash("sha256").update(`${salt}:${taker.toLowerCase()}`).digest("hex"),
    resolution,
  };
  if (!resolution.allLegsFinal) return redacted;
  return {
    ...redacted,
    quoteDigest,
    signatureHash,
    bookInputs,
    modelVersion,
    dataAsOf,
    dataManifestSha256,
    sourceRegistrySha256,
    bestEstimateJointProbWad,
    riskAdjustedJointProbWad,
    rhoBandPct,
    edge,
  };
}
