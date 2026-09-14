import { parseAbiItem, type Address, type PublicClient } from "viem";
import { parlayVaultAbi } from "./abi.js";
import { ExposureBook } from "./exposure.js";
import type { Metrics } from "./server.js";
import { parlayIsDead, readLegStates, type LegState } from "./settlement.js";
import { blockRanges } from "./pure.js";
import type { QuoteLeg } from "./quotes.js";

interface MintedEvent {
  id: bigint;
  quoteId: string;
  premium: bigint;
  maxPayout: bigint;
}

export interface PokerDeps {
  publicClient: PublicClient;
  parlayVault: Address;
  exposure: ExposureBook;
  metrics: Metrics;
  fromBlock: bigint;
  /** Sends resolveParlay(id) from the poker key. */
  resolve(id: bigint): Promise<void>;
  log(msg: object): void;
  /** Overridable for tests; defaults defined below read the chain. */
  fetchEvents?(fromBlock: bigint): Promise<{ minted: MintedEvent[]; resolvedIds: bigint[]; toBlock: bigint }>;
  fetchLegs?(id: bigint): Promise<QuoteLeg[]>;
  fetchLegStates?(vaults: Address[]): Promise<Map<string, LegState>>;
  /** Cold-start rebuild (mainnet-hardening P1-6): every currently-open parlay read
   * straight from chain state, plus the block `nextId` was read at (so the log scan
   * can resume at head instead of deployBlock). Overridable for tests; the default
   * reads `nextId` + `parlay(id)` per id, batched. */
  fetchOpenParlays?(): Promise<{ open: { id: bigint; legs: QuoteLeg[]; risk: bigint }[]; headBlock: bigint }>;
}

const MINTED = parseAbiItem(
  "event ParlayMinted(uint256 indexed id, address indexed taker, bytes32 quoteId, uint96 premium, uint96 maxPayout)",
);
const RESOLVED = parseAbiItem("event ParlayResolved(uint256 indexed id, uint8 status)");

/** Dead-parlay poker (spec §5). Owns ParlayMinted/ParlayResolved sync: converts
 * reservations to open exposure on mint, releases on resolve, and pokes
 * resolveParlay on any open parlay with a lost settled leg — DEAD tickets have no
 * incentivized caller, and unresolved ones lock house bankroll and exposure caps.
 * Idempotent per tick; failures retry next tick. */
export class Poker {
  private open = new Map<bigint, QuoteLeg[]>();
  // Cold-start rescans used to always start at deployBlock (in-memory nextBlock is
  // lost on restart), so every nightly rotate.service bounce blinded per-market caps
  // until the chunked scan caught up — a window that grows with chain age
  // (mainnet-hardening P1-6). seed() rebuilds `open` from on-chain state instead
  // (same stateless-rebuild trick as the keeper's seedPendingOps) and moves
  // nextBlock to head, so the log scan only has to cover what seed() couldn't have
  // seen yet. Callers must await seed() before the first tick(); tests that skip it
  // just get the old from-fromBlock behavior.
  private nextBlock: bigint;

  constructor(private deps: PokerDeps) {
    this.nextBlock = deps.fromBlock;
  }

  openCount(): number {
    return this.open.size;
  }

  private async fetchOpenParlays(): Promise<{ open: { id: bigint; legs: QuoteLeg[]; risk: bigint }[]; headBlock: bigint }> {
    if (this.deps.fetchOpenParlays) return this.deps.fetchOpenParlays();
    const { publicClient, parlayVault } = this.deps;
    // Snapshot head BEFORE reading nextId: nextId read after is guaranteed to reflect
    // every parlay minted at or before headBlock, so resuming the log scan at
    // headBlock+1 can never miss one. A parlay minted between the two reads just gets
    // seeded here AND picked up again by the log scan — both paths are idempotent
    // Map.set calls (see tick()), so no double-counting either way.
    const headBlock = await publicClient.getBlockNumber();
    const nextId = (await publicClient.readContract({
      address: parlayVault,
      abi: parlayVaultAbi,
      functionName: "nextId",
    })) as bigint;
    const open: { id: bigint; legs: QuoteLeg[]; risk: bigint }[] = [];
    // ids are 1..nextId inclusive (mint does `id = ++nextId`) and never reused — a
    // won-but-unclaimed or void-but-unresolved parlay can sit at Status.Open forever
    // (claim()/resolveParlay are both permissionless-but-nobody's-job), so nextId
    // only grows with total historical volume, not with true open count. Batch the
    // reads instead of firing one RPC per id so a cold start months into testnet beta
    // doesn't take forever or trip the -32005 rate limiter.
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
  }

  /** Rebuilds `open` (and thus the exposure book's per-market/cluster totals) from
   * on-chain state and fast-forwards the log scan to head. Must be awaited before the
   * first tick() in production wiring — every nightly rotate.service restart depends
   * on this running before the writer starts quoting again (mainnet-hardening P1-6). */
  async seed(): Promise<void> {
    const { exposure } = this.deps;
    const { open, headBlock } = await this.fetchOpenParlays();
    for (const p of open) {
      this.open.set(p.id, p.legs);
      // Reuses onMinted's reservation-delete-then-open-set path; the synthetic
      // quoteId never collides with a real one (those are 32-byte random hex) and a
      // delete on a missing key is a no-op, so this is exactly "record as open".
      exposure.onMinted(`seed-${p.id}`, p.id.toString(), p.risk, p.legs.map((l) => l.vault));
    }
    this.nextBlock = headBlock + 1n;
  }

  private async fetchEvents(fromBlock: bigint) {
    if (this.deps.fetchEvents) return this.deps.fetchEvents(fromBlock);
    const { publicClient, parlayVault } = this.deps;
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
          })),
        );
        resolvedIds.push(...resolveLogs.map((l) => l.args.id!));
        scanned = r.to;
      } catch (err) {
        this.deps.log({
          event: "scan-truncated",
          scannedTo: scanned.toString(),
          target: toBlock.toString(),
          err: String(err),
        });
        break;
      }
    }
    return { minted, resolvedIds, toBlock: scanned };
  }

  private async fetchLegs(id: bigint): Promise<QuoteLeg[]> {
    if (this.deps.fetchLegs) return this.deps.fetchLegs(id);
    const p = (await this.deps.publicClient.readContract({
      address: this.deps.parlayVault,
      abi: parlayVaultAbi,
      functionName: "parlay",
      args: [id],
    })) as { legs: QuoteLeg[] };
    return p.legs;
  }

  async tick(): Promise<void> {
    const { exposure, metrics, log } = this.deps;
    const events = await this.fetchEvents(this.nextBlock);

    for (const m of events.minted) {
      const legs = await this.fetchLegs(m.id);
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

    if (this.open.size === 0) return;
    const vaults = [...new Set([...this.open.values()].flat().map((l) => l.vault))];
    const states = this.deps.fetchLegStates
      ? await this.deps.fetchLegStates(vaults)
      : await readLegStates(this.deps.publicClient, vaults);
    for (const [id, legs] of this.open) {
      if (parlayIsDead(legs, states)) {
        log({ event: "poking-dead-parlay", id: id.toString() });
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
