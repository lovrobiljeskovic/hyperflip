import { BaseError, ContractFunctionRevertedError, type PublicClient } from "viem";
import { scanParlayIds, type ParlayRef } from "./scan";
import { pool } from "./pool";
import { PARLAY_VAULT, STATUS, outcomeVaultAbi, parlayVaultAbi } from "./contracts";

const WAD = 10n ** 18n;

type Leg = { vault: `0x${string}`; isYes: boolean };
type ParlayData = {
  legs: readonly Leg[];
  writer: `0x${string}`;
  premium: bigint;
  maxPayout: bigint;
  status: number;
};
export type LegVerdict = "pending" | "hit" | "lost" | "fractional";

export interface Row {
  id: bigint;
  parlay: ParlayData;
  burned: boolean;
  legVerdicts: LegVerdict[]; // per-leg, in parlay.legs order
  block: bigint; // mint block - kept so a post-claim reload doesn't rescan logs
  mintedAtMs: number;
}

function legVerdict(isYes: boolean, settled: boolean, fraction: bigint | null): LegVerdict {
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
  try {
    await client.readContract({ address: PARLAY_VAULT, abi: parlayVaultAbi, functionName: "ownerOf", args: [id] });
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

  return { id, parlay, burned, legVerdicts, block, mintedAtMs: Number(timestamp) * 1000 };
}

type RowView = {
  statusLabel: string;
  statusClass: string;
  payoutClass: string;
  action: { kind: "claim" | "resolve"; label: string } | null;
};

/** Derive actions from the ticket and its observed leg outcomes. */
export function deriveRow(row: Row): RowView {
  const { parlay, burned, legVerdicts } = row;

  if (parlay.status === STATUS.Open) {
    const verdicts = legVerdicts;
    const settledCount = verdicts.filter((v) => v !== "pending").length;
    // A lost leg kills the ticket even while other legs are pending.
    if (verdicts.some((v) => v === "lost")) {
      return { statusLabel: "Lost", statusClass: "text-no", payoutClass: "text-dim", action: null };
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
  const refs = await scanParlayIds(client, address);
  const results = await pool(refs, 6, async ref => {
    try { return await loadRow(client, ref); } catch { return null; }
  });
  const rows = results.filter((row): row is Row => row !== null);
  rows.sort((a, b) => a.id > b.id ? -1 : a.id < b.id ? 1 : 0);
  return { rows, failed: results.length - rows.length };
}
