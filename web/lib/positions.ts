import { BaseError, ContractFunctionRevertedError, type PublicClient } from "viem";
import { fetchParlays, type ParlayRef } from "./writer";
import { pool } from "./pool";
import { PARLAY_VAULT, STATUS, outcomeVaultAbi, parlayVaultAbi } from "./contracts";

const WAD = 10n ** 18n;

export type Leg = { vault: `0x${string}`; isYes: boolean };
export type ParlayData = {
  legs: readonly Leg[];
  writer: `0x${string}`;
  premium: bigint;
  maxPayout: bigint;
  status: number;
};
export type LegVerdict = "pending" | "hit" | "lost" | "fractional" | "unknown";
export const INDEXED_POSITIONS = process.env.NEXT_PUBLIC_POSITIONS_SOURCE === "subgraph";

export interface Row {
  id: bigint;
  parlay: ParlayData;
  burned: boolean;
  legVerdicts: LegVerdict[]; // per-leg, in parlay.legs order
  block: bigint; // mint block - kept so a post-claim reload doesn't rescan logs
  mintedAtMs: number;
  owner?: `0x${string}` | null;
  taker?: `0x${string}`;
  burnHolder?: `0x${string}` | null;
  dataError?: boolean;
}

export function legVerdict(isYes: boolean, settled: boolean, fraction: bigint | null): LegVerdict {
  if (!settled) return "pending";
  const winFraction = isYes ? WAD : 0n;
  const loseFraction = isYes ? 0n : WAD;
  if (fraction === winFraction) return "hit";
  if (fraction === loseFraction) return "lost";
  return "fractional";
}

export async function loadRow(client: PublicClient, { id, block }: ParlayRef): Promise<Row> {
  const parlay = (await client.readContract({
    address: PARLAY_VAULT,
    abi: parlayVaultAbi,
    functionName: "parlay",
    args: [id],
  })) as ParlayData;

  let burned = false;
  let owner: `0x${string}` | null = null;
  try {
    owner = await client.readContract({ address: PARLAY_VAULT, abi: parlayVaultAbi, functionName: "ownerOf", args: [id] });
  } catch (error) {
    const revert = error instanceof BaseError ? error.walk(cause => cause instanceof ContractFunctionRevertedError) : null;
    if (!(revert instanceof ContractFunctionRevertedError) || revert.data?.errorName !== "ERC721NonexistentToken") throw error;
    burned = true;
  }

  // Computed for every status, not just Open: the expanded row shows per-leg
  // outcomes on closed tickets too ("which leg killed it"), which the parlay
  // status alone can't answer.
  const legVerdicts = await Promise.all(
    parlay.legs.map(async (leg) => {
      const settled = await client.readContract({
        address: leg.vault,
        abi: outcomeVaultAbi,
        functionName: "settled",
      });
      const fraction = settled
        ? await client.readContract({ address: leg.vault, abi: outcomeVaultAbi, functionName: "settleFractionWad" })
        : null;
      return legVerdict(leg.isYes, settled, fraction);
    }),
  );

  const { timestamp } = await client.getBlock({ blockNumber: block });

  return { id, parlay, burned, owner, legVerdicts, block, mintedAtMs: Number(timestamp) * 1000 };
}

type RowView = {
  statusLabel: string;
  statusClass: string;
  payoutClass: string;
  action: { kind: "claim" | "resolve"; label: string } | null;
};

/** Derive actions from the ticket and its observed leg outcomes. */
export function deriveRow(row: Row, wallet?: string): RowView {
  const { parlay, burned, legVerdicts } = row;
  if (wallet && row.owner !== undefined && !burned && row.owner?.toLowerCase() !== wallet.toLowerCase()) {
    return { statusLabel: "Transferred out", statusClass: "text-dim", payoutClass: "text-dim", action: null };
  }
  if (wallet && burned && row.burnHolder && row.burnHolder.toLowerCase() !== wallet.toLowerCase()) {
    return { statusLabel: "Paid to later owner", statusClass: "text-dim", payoutClass: "text-dim", action: null };
  }
  if (row.dataError || legVerdicts.includes("unknown")) {
    return { statusLabel: "Updating outcomes", statusClass: "text-dim", payoutClass: "text-dim", action: null };
  }

  if (parlay.status === STATUS.Open) {
    const verdicts = legVerdicts;
    const settledCount = verdicts.filter((v) => v !== "pending").length;
    // A lost leg kills the ticket even while other legs are pending.
    if (verdicts.some((v) => v === "lost")) {
      return { statusLabel: "Lost", statusClass: "text-no", payoutClass: "text-dim", action: null };
    }
    if (verdicts.includes("fractional")) {
      return { statusLabel: "Voidable", statusClass: "text-dim", payoutClass: "text-dim", action: { kind: "resolve", label: "Reclaim premium" } };
    }
    if (settledCount < verdicts.length) {
      return {
        statusLabel: `${settledCount} of ${verdicts.length} settled`,
        statusClass: "text-dim",
        payoutClass: "text-dim",
        action: null,
      };
    }
    if (verdicts.every((v) => v === "hit")) {
      return {
        statusLabel: "Claimable",
        statusClass: "text-yes",
        payoutClass: "text-accent",
        action: { kind: "claim", label: "Claim" },
      };
    }
    // all settled, some fractional, none lost - claim() would revert NOT_WON
    return {
      statusLabel: "Voidable",
      statusClass: "text-dim",
      payoutClass: "text-dim",
      action: { kind: "resolve", label: "Reclaim premium" },
    };
  }

  if (parlay.status === STATUS.Won) {
    if (!burned) {
      return {
        statusLabel: "Claimable",
        statusClass: "text-yes",
        payoutClass: "text-accent",
        action: { kind: "claim", label: "Claim" },
      };
    }
    return { statusLabel: "Claimed", statusClass: "text-yes", payoutClass: "text-yes", action: null };
  }

  if (parlay.status === STATUS.Dead) {
    return { statusLabel: "Lost", statusClass: "text-no", payoutClass: "text-dim", action: null };
  }

  // STATUS.Void
  return { statusLabel: "Voided - premium refunded", statusClass: "text-dim", payoutClass: "text-dim", action: null };
}

export async function loadPositions(client: PublicClient, address: `0x${string}`) {
  const refs = await fetchParlays(address);
  const results = await pool(refs, 6, async ref => {
    try { return { ...await loadRow(client, ref), taker: address } as Row; } catch { return null; }
  });
  const rows = results.filter((row): row is Row => row !== null);
  rows.sort((a, b) => a.id > b.id ? -1 : a.id < b.id ? 1 : 0);
  return { rows, failed: results.length - rows.length };
}

export function summarizePositions(rows: Row[], wallet: string) {
  let staked = 0n, claimable = 0n, won = 0n;
  let open = 0;
  for (const row of rows) {
    if (row.taker?.toLowerCase() === wallet.toLowerCase()) staked += row.parlay.premium;
    const view = deriveRow(row, wallet);
    if (view.action?.kind === "claim") claimable += row.parlay.maxPayout;
    const owned = row.owner?.toLowerCase() === wallet.toLowerCase();
    if (owned && !row.burned && (view.action?.kind === "claim" || (row.parlay.status === STATUS.Open && view.statusLabel.endsWith("settled")))) open++;
    if (row.parlay.status === STATUS.Won && row.burned && row.burnHolder?.toLowerCase() === wallet.toLowerCase()) won += row.parlay.maxPayout;
  }
  return { staked, claimable, won, open };
}
