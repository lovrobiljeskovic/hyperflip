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
  // ponytail: nextBlock is in-memory, so every restart rescans from deployBlock —
  // it converges now that chunk progress survives a failed chunk, but the cost
  // grows with chain age. Upgrade path when it stops being cheap: seed `open` from
  // nextId + parlay(id) (the same stateless-rebuild trick the keeper uses in
  // seedPendingOps) and start the log scan at head instead.
  private nextBlock: bigint;

  constructor(private deps: PokerDeps) {
    this.nextBlock = deps.fromBlock;
  }

  openCount(): number {
    return this.open.size;
  }

  private async fetchEvents(fromBlock: bigint) {
    if (this.deps.fetchEvents) return this.deps.fetchEvents(fromBlock);
    const { publicClient, parlayVault } = this.deps;
    const toBlock = await publicClient.getBlockNumber();
    if (toBlock < fromBlock) return { minted: [], resolvedIds: [], toBlock: fromBlock - 1n };
    const minted: MintedEvent[] = [];
    const resolvedIds: bigint[] = [];
    // Testnet RPC caps getLogs at 1000 blocks per query; an unchunked scan bricks
    // every tick once the gap since fromBlock exceeds that (found in the 8/18 e2e).
    //
    // Chunk progress must also be durable. This scan used to be all-or-nothing, so
    // one rate-limited chunk discarded every chunk already scanned and left
    // nextBlock untouched — the next tick reran the same doomed scan, forever. A
    // cold start 136k blocks behind never completed a single tick, leaving the
    // poker blind to every open parlay while it hammered the RPC (found 8/20).
    // Keep whatever scanned cleanly and resume from there next tick.
    let scanned = fromBlock - 1n;
    for (const r of blockRanges(fromBlock, toBlock, 1000n)) {
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
