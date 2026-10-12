import { parseAbiItem, type Address, type PublicClient } from "viem";
import { parlayVaultAbi } from "./abi.js";
import { ExposureBook } from "./exposure.js";
import type { Metrics } from "./server.js";
import { parlayIsDead, parlayIsVoid, readLegStates, type LegState } from "./settlement.js";
import type { QuoteLeg } from "./quotes.js";
import { readOptionalFile, replaceFile } from "../../services/files.mjs";

interface MintedEvent {
  id: bigint;
  quoteId: string;
  premium: bigint;
  maxPayout: bigint;
  taker: Address;
  block: bigint;
}

/** On-disk taker index: `[id, taker, mintBlock]` triples plus the last block the
 * scan covered, so a restart resumes there instead of rescanning. */
interface ParlayIndexFile {
  scannedTo: string;
  parlays: [string, string, string][];
}

type OpenParlays = { open: { id: bigint; legs: QuoteLeg[]; risk: bigint }[]; headBlock: bigint };

export interface PokerDeps {
  exposure: ExposureBook;
  metrics: Metrics;
  fromBlock: bigint;
  /** Persists the taker index (served by GET /parlays). */
  indexFile: string;
  /** First block the taker index covers when `indexFile` doesn't exist yet.
   * Unset: index from the head seen at startup. */
  indexFromBlock?: bigint;
  /** Sends resolveParlay(id) from the poker key. */
  resolve(id: bigint): Promise<void>;
  log(msg: object): void;
  fetchEvents(fromBlock: bigint): Promise<{ minted: MintedEvent[]; resolvedIds: bigint[]; toBlock: bigint }>;
  fetchLegs(id: bigint): Promise<QuoteLeg[]>;
  fetchLegStates(vaults: Address[]): Promise<Map<string, LegState>>;
  /** Every currently-open parlay from chain state, plus the head block it was read at. */
  fetchOpenParlays(): Promise<OpenParlays>;
}

const MINTED = parseAbiItem(
  "event ParlayMinted(uint256 indexed id, address indexed taker, bytes32 quoteId, uint96 premium, uint96 maxPayout)",
);
const RESOLVED = parseAbiItem("event ParlayResolved(uint256 indexed id, uint8 status)");

/** Converts reservations to open exposure on mint, releases on resolve, and pokes
 * resolveParlay on any open parlay that can no longer pay out (DEAD has no incentivized
 * caller, VOID only a weak one; unresolved ones lock bankroll and exposure caps).
 * Idempotent per tick; failures retry next tick. */
export class Poker {
  private open = new Map<bigint, QuoteLeg[]>();
  private nextBlock: bigint;
  private index = new Map<bigint, { taker: Address; block: bigint }>();
  /** Block the index resumes from; undefined means "the head seen at seed()". */
  private indexFrom: bigint | undefined;

  constructor(private deps: PokerDeps) {
    this.nextBlock = deps.fromBlock;
    this.indexFrom = deps.indexFromBlock;
    const json = readOptionalFile(deps.indexFile);
    if (json === undefined) return;
    try {
      const file = JSON.parse(json) as ParlayIndexFile;
      for (const [id, taker, block] of file.parlays) this.index.set(BigInt(id), { taker: taker as Address, block: BigInt(block) });
      this.indexFrom = BigInt(file.scannedTo) + 1n;
    } catch { throw new Error(`Invalid parlay index ${deps.indexFile}; delete it to rebuild from PARLAY_INDEX_FROM_BLOCK`); }
  }

  openCount(): number {
    return this.open.size;
  }

  /** Mint refs for one taker, newest first. */
  parlaysOf(taker: Address): { id: bigint; block: bigint }[] {
    const t = taker.toLowerCase();
    const out: { id: bigint; block: bigint }[] = [];
    for (const [id, p] of this.index) if (p.taker.toLowerCase() === t) out.push({ id, block: p.block });
    return out.sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0));
  }

  private saveIndex(scannedTo: bigint): void {
    const file: ParlayIndexFile = {
      scannedTo: scannedTo.toString(),
      parlays: [...this.index].map(([id, p]) => [id.toString(), p.taker, p.block.toString()]),
    };
    try { replaceFile(this.deps.indexFile, JSON.stringify(file)); }
    catch (err) { this.deps.log({ event: "parlay-index-write-failed", err: String(err) }); }
  }

  /** Rebuilds `open` from chain state and fast-forwards the log scan; await before the first tick(). */
  async seed(): Promise<void> {
    const { exposure } = this.deps;
    const { open, headBlock } = await this.deps.fetchOpenParlays();
    for (const p of open) {
      this.open.set(p.id, p.legs);
      exposure.onMinted(`seed-${p.id}`, p.id.toString(), p.risk, p.legs.map((l) => l.vault));
    }
    // Taker index has no chain-state fallback: resume from its checkpoint when older than head;
    // re-seen mints/resolves are idempotent Map.set/delete, so the replay is safe.
    const resume = this.indexFrom ?? headBlock + 1n;
    this.nextBlock = resume < headBlock + 1n ? resume : headBlock + 1n;
  }

  async tick(): Promise<void> {
    const { exposure, metrics, log } = this.deps;
    const events = await this.deps.fetchEvents(this.nextBlock);

    for (const m of events.minted) {
      this.index.set(m.id, { taker: m.taker, block: m.block });
      const legs = await this.deps.fetchLegs(m.id);
      this.open.set(m.id, legs);
      exposure.onMinted(m.quoteId, m.id.toString(), m.maxPayout - m.premium, legs.map((l) => l.vault));
      metrics.minted++;
      log({ event: "parlay-minted", id: m.id.toString() });
    }
    for (const id of events.resolvedIds) {
      this.open.delete(id);
      exposure.onResolved(id.toString());
      log({ event: "parlay-resolved", id: id.toString() });
    }
    this.nextBlock = events.toBlock + 1n;
    this.saveIndex(events.toBlock);

    if (this.open.size === 0) return;
    const vaults = [...new Set([...this.open.values()].flat().map((l) => l.vault))];
    const states = await this.deps.fetchLegStates(vaults);
    for (const [id, legs] of this.open) {
      const dead = parlayIsDead(legs, states);
      if (dead || parlayIsVoid(legs, states)) {
        log({ event: dead ? "poking-dead-parlay" : "poking-void-parlay", id: id.toString() });
        try {
          await this.deps.resolve(id);
          // open-set removal happens when the ParlayResolved event lands next tick.
        } catch (err) {
          log({ event: "poke-failed", id: id.toString(), err: String(err) });
        }
      }
    }
  }
}

/** Chain-backed reads for PokerDeps. */
export function chainFetchers(publicClient: PublicClient, parlayVault: Address, log: (msg: object) => void) {
  return {
    async fetchOpenParlays(): Promise<OpenParlays> {
      // Snapshot head before reading nextId; resuming the log scan at headBlock+1 then cannot miss a mint.
      const headBlock = await publicClient.getBlockNumber();
      const nextId = (await publicClient.readContract({
        address: parlayVault,
        abi: parlayVaultAbi,
        functionName: "nextId",
      })) as bigint;
      const open: { id: bigint; legs: QuoteLeg[]; risk: bigint }[] = [];
      // ids run 1..nextId and are never reused; unresolved parlays can sit Open forever, so batch the reads.
      // ponytail: bounded-concurrency batching, not real batching (no Multicall3 on
      // testnet) — still one round-trip per 50 ids. Fine at beta scale; if nextId ever
      // reaches the tens of thousands, aggregate via Multicall3 instead.
      for (const r of blockRanges(1n, nextId, 50n)) {
        const ids: bigint[] = [];
        for (let id = r.from; id <= r.to; id++) ids.push(id);
        const parlays = await Promise.all(
          ids.map(
            (id) =>
              publicClient.readContract({
                address: parlayVault,
                abi: parlayVaultAbi,
                functionName: "parlay",
                args: [id],
              }) as Promise<{ legs: QuoteLeg[]; premium: bigint; maxPayout: bigint; status: number }>,
          ),
        );
        parlays.forEach((p, i) => {
          if (p.status === 0) open.push({ id: ids[i], legs: p.legs, risk: p.maxPayout - p.premium });
        });
      }
      return { open, headBlock };
    },

    async fetchEvents(fromBlock: bigint) {
      const toBlock = await publicClient.getBlockNumber();
      if (toBlock < fromBlock) return { minted: [], resolvedIds: [], toBlock: fromBlock - 1n };
      const minted: MintedEvent[] = [];
      const resolvedIds: bigint[] = [];
      // Keep ranges small enough for public dRPC. Retain completed chunks so a
      // failed request resumes there next tick without losing exposure updates.
      let scanned = fromBlock - 1n;
      for (const r of blockRanges(fromBlock, toBlock, 100n)) {
        try {
          const [mintLogs, resolveLogs] = await Promise.all([
            publicClient.getLogs({ address: parlayVault, event: MINTED, fromBlock: r.from, toBlock: r.to }),
            publicClient.getLogs({ address: parlayVault, event: RESOLVED, fromBlock: r.from, toBlock: r.to }),
          ]);
          minted.push(
            ...mintLogs.map((l) => ({
              id: l.args.id!,
              quoteId: l.args.quoteId!,
              premium: l.args.premium!,
              maxPayout: l.args.maxPayout!,
              taker: l.args.taker!,
              block: l.blockNumber,
            })),
          );
          resolvedIds.push(...resolveLogs.map((l) => l.args.id!));
          scanned = r.to;
        } catch (err) {
          log({
            event: "scan-truncated",
            scannedTo: scanned.toString(),
            target: toBlock.toString(),
            err: String(err),
          });
          break;
        }
      }
      return { minted, resolvedIds, toBlock: scanned };
    },

    async fetchLegs(id: bigint): Promise<QuoteLeg[]> {
      const p = (await publicClient.readContract({
        address: parlayVault,
        abi: parlayVaultAbi,
        functionName: "parlay",
        args: [id],
      })) as { legs: QuoteLeg[] };
      return p.legs;
    },

    fetchLegStates: (vaults: Address[]) => readLegStates(publicClient, vaults),
  };
}

/** Split [from, to] into inclusive ranges of at most `size` blocks — testnet RPC
 * rejects getLogs spans over 1000 blocks. Empty when to < from. */
export function blockRanges(from: bigint, to: bigint, size: bigint): { from: bigint; to: bigint }[] {
  const out: { from: bigint; to: bigint }[] = [];
  for (let start = from; start <= to; start += size) {
    out.push({ from: start, to: start + size - 1n > to ? to : start + size - 1n });
  }
  return out;
}

/** Watchdog stall threshold for the poker tick loop (same formula as the keeper): a tick
 * sequentially pokes every open parlay, each resolve() receipt wait capped at receiptTimeoutMs,
 * plus the gap between ticks; marginMs covers the calls with no explicit timeout. */
export function stallThresholdMs(
  openCount: number,
  receiptTimeoutMs: number,
  tickIntervalMs: number,
  marginMs = 120_000,
): number {
  return openCount * receiptTimeoutMs + tickIntervalMs + marginMs;
}
