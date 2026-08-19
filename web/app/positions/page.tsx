"use client";

import { useCallback, useEffect, useState } from "react";
import type { PublicClient } from "viem";
import { usePrivy } from "@privy-io/react-auth";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { scanParlayIds } from "@/lib/scan";
import { PARLAY_VAULT, STATUS, outcomeVaultAbi, parlayVaultAbi } from "@/lib/contracts";
import { formatUsdc } from "@/lib/format";

// @privy-io/wagmi's WagmiProvider only mounts when NEXT_PUBLIC_PRIVY_APP_ID is
// set (see app/providers.tsx); usePrivy() throws without a PrivyProvider
// ancestor. PRIVY_ENABLED is a build-time constant (inlined by Next.js), so
// it never changes across a running instance's renders — safe to branch a
// hook call on it. (Same pattern as app/build/ticket.tsx.)
const PRIVY_ENABLED = !!process.env.NEXT_PUBLIC_PRIVY_APP_ID;

function useOptionalLogin(): () => void {
  if (PRIVY_ENABLED) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const { login } = usePrivy();
    return login;
  }
  return () => {};
}

const WAD = 10n ** 18n;

type Leg = { vault: `0x${string}`; isYes: boolean };
type ParlayData = {
  legs: readonly Leg[];
  writer: `0x${string}`;
  premium: bigint;
  maxPayout: bigint;
  status: number;
};
type LegVerdict = "pending" | "hit" | "lost" | "fractional";

interface Row {
  id: bigint;
  parlay: ParlayData;
  burned: boolean;
  legVerdicts: LegVerdict[] | null; // only computed for Open parlays
}

function legVerdict(isYes: boolean, settled: boolean, fraction: bigint | null): LegVerdict {
  if (!settled) return "pending";
  const winFraction = isYes ? WAD : 0n;
  const loseFraction = isYes ? 0n : WAD;
  if (fraction === winFraction) return "hit";
  if (fraction === loseFraction) return "lost";
  return "fractional";
}

async function loadRow(client: PublicClient, id: bigint): Promise<Row> {
  const parlay = (await client.readContract({
    address: PARLAY_VAULT,
    abi: parlayVaultAbi,
    functionName: "parlay",
    args: [id],
  })) as ParlayData;

  let burned = false;
  try {
    await client.readContract({ address: PARLAY_VAULT, abi: parlayVaultAbi, functionName: "ownerOf", args: [id] });
  } catch {
    burned = true; // ownerOf reverts once the NFT is burned (claimed Won parlay)
  }

  let legVerdicts: LegVerdict[] | null = null;
  if (parlay.status === STATUS.Open) {
    legVerdicts = await Promise.all(
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
  }

  return { id, parlay, burned, legVerdicts };
}

type RowView = {
  statusLabel: string;
  statusClass: string;
  payoutClass: string;
  action: { kind: "claim" | "resolve"; label: string } | null;
};

/** Row derivation table — task-7-brief.md §Row derivation, verbatim. */
function deriveRow(row: Row): RowView {
  const { parlay, burned, legVerdicts } = row;

  if (parlay.status === STATUS.Open) {
    const verdicts = legVerdicts ?? [];
    const settledCount = verdicts.filter((v) => v !== "pending").length;
    // A single lost leg kills the whole parlay immediately — check it before
    // "not all settled" so a ticket doesn't sit as "n of m settled" once one
    // leg has already lost (poker sweeps the escrow regardless of the rest).
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
    // all settled, some fractional, none lost — claim() would revert NOT_WON
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
  return { statusLabel: "Voided — premium refunded", statusClass: "text-dim", payoutClass: "text-dim", action: null };
}

function shortError(err: unknown): string {
  const raw = String((err as Error)?.message ?? err);
  const firstLine = raw.split("\n")[0] ?? raw;
  return firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine;
}

function LoadingSkeleton() {
  return (
    <div className="mt-10 flex flex-col gap-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-12 animate-pulse rounded-card border border-line bg-panel" />
      ))}
    </div>
  );
}

export default function PositionsPage() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const login = useOptionalLogin();

  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState<{ id: bigint; kind: "claim" | "resolve" } | null>(null);
  const [actionError, setActionError] = useState<{ id: bigint; msg: string } | null>(null);

  const load = useCallback(async () => {
    if (!address || !publicClient) return;
    setError(false);
    setRows(null);
    try {
      const ids = await scanParlayIds(publicClient, address);
      const loaded = await Promise.all(ids.map((id) => loadRow(publicClient, id)));
      loaded.sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0)); // newest first
      setRows(loaded);
    } catch {
      setError(true);
    }
  }, [address, publicClient]);

  useEffect(() => {
    void load();
  }, [load]);

  async function reloadRow(id: bigint) {
    if (!publicClient) return;
    const fresh = await loadRow(publicClient, id);
    setRows((prev) => (prev ? prev.map((r) => (r.id === id ? fresh : r)) : prev));
  }

  async function act(id: bigint, kind: "claim" | "resolve") {
    if (!publicClient) return;
    setPending({ id, kind });
    setActionError(null);
    try {
      const hash = await writeContractAsync({
        address: PARLAY_VAULT,
        abi: parlayVaultAbi,
        functionName: kind === "claim" ? "claim" : "resolveParlay",
        args: [id],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await reloadRow(id);
    } catch (err) {
      setActionError({ id, msg: shortError(err) });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="min-h-screen text-[13px] text-fg">
      <header className="sticky top-0 z-10 border-b border-line bg-ink/95">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <a href="/" className="flex items-center gap-2 font-mono text-sm tracking-tight text-fg">
            <span className="inline-block size-2.5 rounded-[2px] bg-accent" aria-hidden />
            parlay
          </a>
          <nav className="flex items-center gap-6 text-sm">
            <a href="/build" className="text-dim transition-colors hover:text-fg">
              Build
            </a>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <h1 className="text-lg font-medium">Your parlays</h1>
        <p className="mt-1 text-dim">Read straight from chain — parlay mints, leg settlement, and claims.</p>

        {!isConnected ? (
          <div className="mt-10 flex flex-col items-start gap-3 rounded-card border border-line bg-panel p-6">
            <p className="text-dim">Connect your wallet to see your positions.</p>
            <button
              type="button"
              onClick={() => login()}
              className="rounded-card bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-transform active:scale-[0.98] hover:opacity-90"
            >
              Connect wallet
            </button>
          </div>
        ) : error ? (
          <div className="mt-10 flex flex-col items-start gap-3 rounded-card border border-line bg-panel p-6">
            <p className="text-no">Couldn&apos;t load your positions.</p>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-card border border-line px-4 py-2 text-sm text-fg transition-colors hover:border-dim"
            >
              Retry
            </button>
          </div>
        ) : rows === null ? (
          <LoadingSkeleton />
        ) : rows.length === 0 ? (
          <div className="mt-10 rounded-card border border-line bg-panel p-6">
            <p className="text-dim">
              No parlays yet —{" "}
              <a href="/build" className="text-accent underline underline-offset-4">
                build one
              </a>
              .
            </p>
          </div>
        ) : (
          <div className="mt-10 overflow-x-auto rounded-card border border-line bg-panel">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="font-mono text-xs text-dim">
                <tr className="border-b border-line">
                  <th className="px-5 py-3 font-normal">Ticket</th>
                  <th className="px-5 py-3 font-normal">Legs</th>
                  <th className="px-5 py-3 font-normal">Stake</th>
                  <th className="px-5 py-3 font-normal">Status</th>
                  <th className="px-5 py-3 text-right font-normal">Payout</th>
                  <th className="px-5 py-3 text-right font-normal">Action</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {rows.map((row, i) => {
                  const view = deriveRow(row);
                  const isPending = pending?.id === row.id;
                  const rowError = actionError?.id === row.id ? actionError.msg : null;
                  return (
                    <tr key={row.id.toString()} className={i < rows.length - 1 ? "border-b border-line" : ""}>
                      <td className="px-5 py-4">#{row.id.toString().padStart(4, "0")}</td>
                      <td className="px-5 py-4">{row.parlay.legs.length}</td>
                      <td className="px-5 py-4">{formatUsdc(row.parlay.premium)}</td>
                      <td className={`px-5 py-4 ${view.statusClass}`}>{view.statusLabel}</td>
                      <td className={`px-5 py-4 text-right ${view.payoutClass}`}>{formatUsdc(row.parlay.maxPayout)}</td>
                      <td className="px-5 py-4 text-right">
                        {view.action ? (
                          <button
                            type="button"
                            disabled={isPending}
                            onClick={() => void act(row.id, view.action!.kind)}
                            className="rounded-[4px] border border-line px-3 py-1 font-mono text-xs text-fg transition-colors hover:border-dim disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {isPending
                              ? view.action.kind === "claim"
                                ? "Claiming…"
                                : "Resolving…"
                              : view.action.label}
                          </button>
                        ) : (
                          <span className="text-dim">—</span>
                        )}
                        {rowError && <p className="mt-2 text-[11px] text-no">{rowError}</p>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
