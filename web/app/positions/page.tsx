"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { PublicClient } from "viem";
import { usePublicClient, useWriteContract } from "wagmi";
import { scanParlayIds, type ParlayRef } from "@/lib/scan";
import { pool } from "@/lib/pool";
import { PARLAY_VAULT, STATUS, outcomeVaultAbi, parlayVaultAbi } from "@/lib/contracts";
import { formatUsdc, multiplier } from "@/lib/format";
import { hyperEvmTestnet } from "@/lib/chain";
import { fetchMarkets, type Market } from "@/lib/writer";
import { useMids } from "@/lib/mids";
import { useConnectAction, useWalletState } from "@/lib/wallet";
import { AppHeader } from "../app-header";

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
  legVerdicts: LegVerdict[]; // per-leg, in parlay.legs order
  block: bigint; // mint block — kept so a post-claim reload doesn't rescan logs
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

async function loadRow(client: PublicClient, { id, block }: ParlayRef): Promise<Row> {
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

/** Row derivation table — task-7-brief.md §Row derivation, verbatim. */
function deriveRow(row: Row): RowView {
  const { parlay, burned, legVerdicts } = row;

  if (parlay.status === STATUS.Open) {
    const verdicts = legVerdicts;
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

const EXPLORER = hyperEvmTestnet.blockExplorers.default.url;

const VERDICT_STYLE: Record<LegVerdict, { label: string; className: string }> = {
  pending: { label: "Pending", className: "text-dim" },
  hit: { label: "Hit", className: "text-yes" },
  lost: { label: "Lost", className: "text-no" },
  fractional: { label: "Partial", className: "text-accent" },
};

/** Compact "2h ago" / "3d ago". Absolute date once it stops being useful as an age. */
function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Time until a leg's market expires, or "expired". */
function until(ms: number): string {
  const s = (ms - Date.now()) / 1000;
  if (s <= 0) return "expired";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** One dot per leg, coloured by that leg's verdict — the whole ticket's
 * settlement progress readable without expanding the row. */
function LegDots({ verdicts }: { verdicts: LegVerdict[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {verdicts.map((v, i) => (
        <span
          key={i}
          title={VERDICT_STYLE[v].label}
          className={`inline-block size-1.5 rounded-full ${
            v === "hit" ? "bg-yes" : v === "lost" ? "bg-no" : v === "fractional" ? "bg-accent" : "bg-line"
          }`}
        />
      ))}
    </span>
  );
}

function LegTable({
  row,
  markets,
  mids,
}: {
  row: Row;
  markets: Map<string, Market>;
  mids: Record<string, string>;
}) {
  return (
    <div className="flex flex-col gap-2 border-l-2 border-accent/40 bg-raised/30 px-5 py-4">
      <div className="flex gap-4 font-mono text-[11px] text-dim">
        <span className="w-10">Side</span>
        <span className="flex-1">Market</span>
        <span className="w-16 text-right">Live</span>
        <span className="w-16 text-right">Expires</span>
        <span className="w-20 text-right">Outcome</span>
      </div>
      {row.parlay.legs.map((leg, i) => {
        const m = markets.get(leg.vault.toLowerCase());
        const coin = m ? (leg.isYes ? m.coinYes : m.coinNo) : undefined;
        const raw = coin === undefined ? undefined : mids[coin];
        const live = raw === undefined ? null : Number(raw);
        const verdict = VERDICT_STYLE[row.legVerdicts[i]];
        return (
          <div key={leg.vault} className="flex items-baseline gap-4 font-mono text-xs">
            <span className={`w-10 ${leg.isYes ? "text-yes" : "text-no"}`}>{leg.isYes ? "YES" : "NO"}</span>
            <a
              href={`${EXPLORER}/address/${leg.vault}`}
              target="_blank"
              rel="noreferrer"
              className="flex-1 truncate text-fg underline decoration-line underline-offset-4 transition-colors hover:decoration-dim"
            >
              {m?.title ?? leg.vault}
            </a>
            <span className="w-16 text-right text-dim">
              {live !== null && Number.isFinite(live) ? `${(live * 100).toFixed(1)}%` : "—"}
            </span>
            <span className="w-16 text-right text-dim">{m?.expiryMs ? until(m.expiryMs) : "—"}</span>
            <span className={`w-20 text-right ${verdict.className}`}>{verdict.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function SummaryStrip({ rows }: { rows: Row[] }) {
  let staked = 0n;
  let open = 0;
  let claimable = 0n;
  let won = 0n;
  for (const r of rows) {
    staked += r.parlay.premium;
    const v = deriveRow(r);
    if (v.statusLabel === "Claimable") {
      claimable += r.parlay.maxPayout;
      open++;
    } else if (v.action === null && r.parlay.status === STATUS.Open) {
      if (v.statusLabel.endsWith("settled")) open++;
    }
    if (r.parlay.status === STATUS.Won && r.burned) won += r.parlay.maxPayout;
  }
  const cells = [
    { label: "Tickets", value: String(rows.length), className: "" },
    { label: "Total staked", value: `${formatUsdc(staked)} USDC`, className: "" },
    { label: "Open", value: String(open), className: "" },
    { label: "Claimable", value: `${formatUsdc(claimable)} USDC`, className: claimable > 0n ? "text-accent" : "" },
    { label: "Claimed", value: `${formatUsdc(won)} USDC`, className: won > 0n ? "text-yes" : "" },
  ];
  return (
    <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line sm:grid-cols-5">
      {cells.map((c) => (
        <div key={c.label} className="bg-panel px-4 py-3">
          <p className="font-mono text-[11px] text-dim">{c.label}</p>
          <p className={`mt-1 font-mono text-sm ${c.className}`}>{c.value}</p>
        </div>
      ))}
    </div>
  );
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
  const { ready, address, isConnected } = useWalletState();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const connect = useConnectAction();

  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState<{ id: bigint; kind: "claim" | "resolve" } | null>(null);
  const [actionError, setActionError] = useState<{ id: bigint; msg: string } | null>(null);
  const [expanded, setExpanded] = useState<bigint | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const mids = useMids();

  // Titles/coins/expiries live in the writer's registry, not on-chain — the
  // leg detail rows fall back to the raw vault address if it's unreachable.
  useEffect(() => {
    fetchMarkets()
      .then(setMarkets)
      .catch(() => setMarkets([]));
  }, []);
  const marketsByVault = useMemo(
    () => new Map(markets.map((m) => [m.vault.toLowerCase(), m])),
    [markets],
  );

  const load = useCallback(async () => {
    if (!address || !publicClient) return;
    setError(false);
    setRows(null);
    try {
      const refs = await scanParlayIds(publicClient, address);
      // Each row costs ~1.5s of round trips, so nine positions loaded one at a
      // time read as a hung page. Six at a time; leg reads inside a row still
      // fan out, so the real ceiling is ~6×(2+2L) in flight, which this testnet
      // endpoint serves without rate-limiting.
      // ponytail: fixed pool. Batch via multicall if position counts grow.
      const loaded = await pool(refs, 6, (ref) => loadRow(publicClient, ref));
      loaded.sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0)); // newest first
      setRows(loaded);
    } catch {
      setError(true);
    }
  }, [address, publicClient]);

  useEffect(() => {
    void load();
  }, [load]);

  async function reloadRow(ref: ParlayRef) {
    if (!publicClient) return;
    const fresh = await loadRow(publicClient, ref);
    setRows((prev) => (prev ? prev.map((r) => (r.id === ref.id ? fresh : r)) : prev));
  }

  async function act(row: Row, kind: "claim" | "resolve") {
    const id = row.id;
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
      await reloadRow(row);
    } catch (err) {
      setActionError({ id, msg: shortError(err) });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="min-h-screen text-[13px] text-fg">
      <AppHeader />

      <main className="mx-auto max-w-6xl px-6 py-10">
        <h1 className="text-lg font-medium">Your parlays</h1>
        <p className="mt-1 text-dim">Read straight from chain — parlay mints, leg settlement, and claims.</p>

        {!ready ? (
          <LoadingSkeleton />
        ) : !isConnected ? (
          <div className="mt-10 flex flex-col items-start gap-3 rounded-card border border-line bg-panel p-6">
            <p className="text-dim">Connect your wallet to see your positions.</p>
            <button
              type="button"
              onClick={() => connect()}
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
          <>
            <SummaryStrip rows={rows} />
            <div className="mt-4 overflow-x-auto rounded-card border border-line bg-panel">
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="font-mono text-xs text-dim">
                  <tr className="border-b border-line">
                    <th className="px-5 py-3 font-normal">Ticket</th>
                    <th className="px-5 py-3 font-normal">Legs</th>
                    <th className="px-5 py-3 text-right font-normal">Stake</th>
                    <th className="px-5 py-3 text-right font-normal">Multiplier</th>
                    <th className="px-5 py-3 text-right font-normal">Max payout</th>
                    <th className="px-5 py-3 text-right font-normal">Profit</th>
                    <th className="px-5 py-3 font-normal">Status</th>
                    <th className="px-5 py-3 text-right font-normal">Action</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {rows.map((row, i) => {
                    const view = deriveRow(row);
                    const isPending = pending?.id === row.id;
                    const rowError = actionError?.id === row.id ? actionError.msg : null;
                    const isOpen = expanded === row.id;
                    const divider = i < rows.length - 1 || isOpen ? "border-b border-line" : "";
                    return (
                      <Fragment key={row.id.toString()}>
                        <tr
                          onClick={() => setExpanded((cur) => (cur === row.id ? null : row.id))}
                          className={`cursor-pointer transition-colors hover:bg-raised/40 ${divider}`}
                        >
                          <td className="px-5 py-4">
                            <span className="flex items-center gap-2">
                              <span className={`text-dim transition-transform ${isOpen ? "rotate-90" : ""}`} aria-hidden>
                                ›
                              </span>
                              <span>
                                #{row.id.toString().padStart(4, "0")}
                                <span className="ml-2 text-[11px] text-dim">{ago(row.mintedAtMs)}</span>
                              </span>
                            </span>
                          </td>
                          <td className="px-5 py-4">
                            <span className="flex items-center gap-2">
                              {row.parlay.legs.length}
                              <LegDots verdicts={row.legVerdicts} />
                            </span>
                          </td>
                          <td className="px-5 py-4 text-right">{formatUsdc(row.parlay.premium)}</td>
                          <td className="px-5 py-4 text-right">
                            {multiplier(row.parlay.premium, row.parlay.maxPayout)}
                          </td>
                          <td className={`px-5 py-4 text-right ${view.payoutClass}`}>
                            {formatUsdc(row.parlay.maxPayout)}
                          </td>
                          <td className={`px-5 py-4 text-right ${view.payoutClass}`}>
                            +{formatUsdc(row.parlay.maxPayout - row.parlay.premium)}
                          </td>
                          <td className={`px-5 py-4 ${view.statusClass}`}>{view.statusLabel}</td>
                          <td className="px-5 py-4 text-right" onClick={(e) => e.stopPropagation()}>
                            {view.action ? (
                              <button
                                type="button"
                                disabled={isPending}
                                onClick={() => void act(row, view.action!.kind)}
                                className={`rounded-[4px] px-3 py-1 font-mono text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                                  view.action.kind === "claim"
                                    ? "bg-accent font-medium text-on-accent hover:opacity-90"
                                    : "border border-line text-fg hover:border-dim"
                                }`}
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
                        {isOpen && (
                          <tr className={i < rows.length - 1 ? "border-b border-line" : ""}>
                            <td colSpan={8} className="p-0">
                              <LegTable row={row} markets={marketsByVault} mids={mids} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
