"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { usePositions } from "./use-positions";
import { usePositionAction } from "./use-position-action";
import { DotLegend, LegDots, LegTable, ago } from "./leg-table";
import { SummaryStrip } from "./summary-strip";
import { INDEXED_POSITIONS, deriveRow } from "@/lib/positions";
import { formatUsdc, multiplier } from "@/lib/format";
import { fetchMarkets, type Market, withMarketVolumes } from "@/lib/writer";
import { fetchMarketVolumes } from "@/lib/info";
import { useMids } from "@/lib/mids";
import { useConnectAction, useWalletState } from "@/lib/wallet";
import { appHref } from "@/lib/site";

function TicketLabel({ id, mintedAtMs }: { id: bigint; mintedAtMs: number }) {
  return (
    <span>
      #{id.toString().padStart(4, "0")}
      <span className="ml-2 text-[11px] text-dim">{ago(mintedAtMs)}</span>
    </span>
  );
}

function ActionButton({ kind, label, isPending, disabled, onClick, className }: {
  kind: "claim" | "resolve";
  label: string;
  isPending: boolean;
  disabled: boolean;
  onClick: () => void;
  className: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`${className} transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        kind === "claim"
          ? "bg-accent font-medium text-on-accent hover:opacity-90"
          : "border border-line text-fg hover:border-dim"
      }`}
    >
      {isPending
        ? kind === "claim"
          ? "Claiming…"
          : "Resolving…"
        : label}
    </button>
  );
}

function LoadingSkeleton() {
  return (
    <div className="mt-10 flex flex-col gap-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-12 animate-pulse motion-reduce:animate-none rounded-card border border-line bg-panel" />
      ))}
    </div>
  );
}

export default function PositionsPage() {
  const { address } = useWalletState();
  const { chainId } = useAccount();
  return <PositionsContent key={`${address?.toLowerCase()}:${chainId}`} />;
}

function PositionsContent() {
  const { ready, address, isConnected } = useWalletState();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const connect = useConnectAction();

  const { rows, error, notice, loading, hasMore, load, loadMore, reloadRow } = usePositions(publicClient, address);
  const { pending, actionError, act } = usePositionAction(publicClient, address, writeContractAsync, reloadRow);
  const [expanded, setExpanded] = useState<bigint | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const mids = useMids();

  // Registry metadata supplies sports labels. The lane's writer serves the authoritative (box-rotated) registry;
  // the static snapshot lags the repo registry, so it only backs the indexed path when the writer is down.
  useEffect(() => {
    // Volumes too, so a book trading at exactly 0.5 prices the same as on /build.
    const staticLabels = () => fetch("/position-markets.json").then(r => { if (!r.ok) throw new Error("Market labels unavailable"); return r.json() as Promise<Market[]>; });
    Promise.all([
      INDEXED_POSITIONS ? fetchMarkets(true).catch(staticLabels) : fetchMarkets(true),
      fetchMarketVolumes(),
    ])
      .then(([ms, volumes]) => setMarkets(withMarketVolumes(ms, volumes)))
      .catch((err) => console.warn("positions: market labels unavailable", err));
  }, []);
  const marketsByVault = useMemo(
    () => new Map(markets.map((m) => [m.vault.toLowerCase(), m])),
    [markets],
  );

  return (
    <div className="min-h-screen text-[13px] text-fg">

      <main className="mx-auto max-w-[1280px] px-4 py-8 sm:px-6 sm:py-10">
        <h1 className="display text-[32px] [font-variation-settings:'wght'_700] tracking-[-0.03em]">
          Your slips
        </h1>
        <p className="mt-1 text-[15px] text-dim">
          Your ticket history, outcomes, and claims.
        </p>

        {isConnected && <div className="mt-4 flex items-center gap-3 text-sm">
          <button type="button" disabled={loading} onClick={() => void load()} className="underline disabled:opacity-50">{loading ? "Updating…" : "Refresh"}</button>
          {notice && <p role="status" className="text-dim">{notice}</p>}
        </div>}

        {!ready ? (
          <LoadingSkeleton />
        ) : !isConnected ? (
          <div className="mt-10 flex flex-col items-start gap-3 rounded-card border border-line bg-panel p-6">
            <p className="text-dim">Connect your wallet to see your positions.</p>
            <button
              type="button"
              onClick={() => connect()}
              className="rounded-card bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-transform motion-reduce:transition-none active:scale-[0.98] hover:opacity-90"
            >
              Connect wallet
            </button>
          </div>
        ) : error && rows === null ? (
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
              No slips yet -{" "}
              <Link href={appHref()} className="text-accent underline underline-offset-4">
                build one
              </Link>
              .
            </p>
          </div>
        ) : (
          <>
            {error && <p role="alert" className="mt-4 text-no">Some positions could not be loaded. <button className="underline" onClick={() => void load()}>Retry</button></p>}
            <p className="mt-5 text-xs text-dim">Summary of loaded tickets</p>
            <SummaryStrip rows={rows} wallet={address!} />

            {/* Mobile: one card per slip; the table needs 860px and horizontal
                scrolling a slip list shouldn't. */}
            <div className="mt-4 flex flex-col gap-3 md:hidden">
              {rows.map((row) => {
                const view = deriveRow(row, address);
                const isPending = pending?.id === row.id;
                const rowError = actionError?.id === row.id ? actionError.msg : null;
                const isOpen = expanded === row.id;
                return (
                  <div
                    key={row.id.toString()}
                    className={`overflow-hidden rounded-card border ${
                      view.action?.kind === "claim"
                        ? "border-accent/40 bg-accent/[0.06]"
                        : "border-line bg-panel"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setExpanded((cur) => (cur === row.id ? null : row.id))}
                      aria-expanded={isOpen}
                      className="mono w-full px-4 py-3 text-left text-[12px]"
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <TicketLabel id={row.id} mintedAtMs={row.mintedAtMs} />
                        <span className={view.statusClass}>{view.statusLabel}</span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-2 text-dim">
                        {row.parlay.legs.length} {row.parlay.legs.length === 1 ? "leg" : "legs"}
                        <LegDots verdicts={row.legVerdicts} />
                        <span
                          className={`ml-auto transition-transform motion-reduce:transition-none ${isOpen ? "rotate-90" : ""}`}
                          aria-hidden
                        >
                          ›
                        </span>
                      </div>
                      <div className="mt-3 grid grid-cols-3 gap-2">
                        {(
                          [
                            ["Stake", formatUsdc(row.parlay.premium), ""],
                            ["Mult", multiplier(row.parlay.premium, row.parlay.maxPayout), ""],
                            ["Max payout", formatUsdc(row.parlay.maxPayout), view.payoutClass],
                          ] as const
                        ).map(([label, value, cls]) => (
                          <div key={label}>
                            <p className="text-[9px] uppercase tracking-[0.16em] text-dim">{label}</p>
                            <p className={`mt-0.5 ${cls}`}>{value}</p>
                          </div>
                        ))}
                      </div>
                    </button>
                    {view.action && (
                      <div className="px-4 pb-3">
                        <ActionButton
                          kind={view.action.kind}
                          label={view.action.label}
                          isPending={isPending}
                          disabled={pending !== null}
                          onClick={() => void act(row, view.action!.kind)}
                          className="mono w-full rounded-[4px] px-3 py-2 text-xs"
                        />
                        {rowError && <p className="mt-2 text-[11px] text-no">{rowError}</p>}
                      </div>
                    )}
                    {!view.action && rowError && (
                      <p className="px-4 pb-3 text-[11px] text-no">{rowError}</p>
                    )}
                    {isOpen && (
                      <div className="border-t border-line">
                        <LegTable row={row} markets={marketsByVault} mids={mids} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mt-4 hidden overflow-x-auto rounded-card border border-line bg-panel md:block">
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="mono text-[9px] uppercase tracking-[0.16em] text-dim">
                  <tr className="border-b border-line">
                    <th className="px-5 py-3 font-normal">Ticket</th>
                    <th className="px-5 py-3 font-normal">Legs</th>
                    <th className="px-5 py-3 text-right font-normal">Stake</th>
                    <th className="px-5 py-3 text-right font-normal">Multiplier</th>
                    <th className="px-5 py-3 text-right font-normal">Max payout</th>
                    <th className="px-5 py-3 font-normal">Status</th>
                    <th className="px-5 py-3 text-right font-normal">Action</th>
                  </tr>
                </thead>
                <tbody className="mono text-[12px]">
                  {rows.map((row, i) => {
                    const view = deriveRow(row, address);
                    const isPending = pending?.id === row.id;
                    const rowError = actionError?.id === row.id ? actionError.msg : null;
                    const isOpen = expanded === row.id;
                    const divider = i < rows.length - 1 || isOpen ? "border-b border-line" : "";
                    return (
                      <Fragment key={row.id.toString()}>
                        <tr
                          onClick={() => setExpanded((cur) => (cur === row.id ? null : row.id))}
                          className={`cursor-pointer transition-colors ${divider} ${
                            view.action?.kind === "claim"
                              ? "bg-accent/[0.06] hover:bg-accent/10"
                              : "hover:bg-raised/40"
                          }`}
                        >
                          <td className="px-5 py-4">
                            <span className="flex items-center gap-2">
                              <span className={`text-dim transition-transform motion-reduce:transition-none ${isOpen ? "rotate-90" : ""}`} aria-hidden>
                                ›
                              </span>
                              <TicketLabel id={row.id} mintedAtMs={row.mintedAtMs} />
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
                          <td className={`px-5 py-4 ${view.statusClass}`}>{view.statusLabel}</td>
                          <td className="px-5 py-4 text-right" onClick={(e) => e.stopPropagation()}>
                            {view.action ? (
                              <ActionButton
                                kind={view.action.kind}
                                label={view.action.label}
                                isPending={isPending}
                                disabled={pending !== null}
                                onClick={() => void act(row, view.action!.kind)}
                                className="rounded-[4px] px-3 py-1 mono text-xs"
                              />
                            ) : (
                              <span className="text-dim">-</span>
                            )}
                            {rowError && <p className="mt-2 text-[11px] text-no">{rowError}</p>}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className={i < rows.length - 1 ? "border-b border-line" : ""}>
                            <td colSpan={7} className="p-0">
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
            <DotLegend />
            {hasMore && <button type="button" disabled={loading} onClick={() => void loadMore()} className="mt-6 rounded-card border border-line px-4 py-2 disabled:opacity-50">{loading ? "Loading…" : "Load more"}</button>}
          </>
        )}
      </main>
    </div>
  );
}
