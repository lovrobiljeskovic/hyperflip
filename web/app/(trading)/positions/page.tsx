"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { usePositions } from "./use-positions";
import { deriveRow, type Row, type LegVerdict } from "@/lib/positions";
import { PARLAY_VAULT, STATUS, parlayVaultAbi } from "@/lib/contracts";
import { formatUsdc, multiplier, pct1, until, shortError } from "@/lib/format";
import { hyperEvmTestnet, tradeUrl } from "@/lib/chain";
import { fetchMarkets, type Market, sideLabel } from "@/lib/writer";
import { useMids } from "@/lib/mids";
import { useConnectAction, useWalletState } from "@/lib/wallet";
import { appHref } from "@/lib/site";

const EXPLORER = hyperEvmTestnet.blockExplorers.default.url;

const VERDICT_STYLE: Record<LegVerdict, { label: string; className: string }> = {
  pending: { label: "Pending", className: "text-dim" },
  hit: { label: "Hit", className: "text-yes" },
  lost: { label: "Lost", className: "text-no" },
  fractional: { label: "Partial", className: "text-fg" },
};

/** The four dot states, shared by the leg dots and the legend beneath the
 * table. `fractional` is a half-filled hit dot - the retired yellow's only
 * remaining job, done without a third colour. */
const DOT_CLASS: Record<LegVerdict, string> = {
  hit: "bg-yes",
  lost: "bg-no",
  pending: "bg-line",
  fractional: "bg-[linear-gradient(90deg,#35D07A_50%,#262C38_50%)]",
};

/** Compact "2h ago" / "3d ago". Absolute date once it stops being useful as an age. */
function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** One dot per leg, coloured by that leg's verdict - the whole ticket's
 * settlement progress readable without expanding the row. */
function LegDots({ verdicts }: { verdicts: LegVerdict[] }) {
  return (
    <span
      role="img"
      aria-label={verdicts.map((v) => VERDICT_STYLE[v].label).join(", ")}
      className="inline-flex items-center gap-[3px]"
    >
      {verdicts.map((v, i) => (
        <span
          key={i}
          title={VERDICT_STYLE[v].label}
          className={`inline-block size-1.5 rounded-full ${DOT_CLASS[v]}`}
        />
      ))}
    </span>
  );
}

/** Names the four dot states; without it the half-filled dot is a puzzle
 * rather than a state. */
function DotLegend() {
  const order: LegVerdict[] = ["hit", "fractional", "lost", "pending"];
  return (
    <div className="mono mt-4 flex flex-wrap items-center gap-5 text-[10px] uppercase tracking-[0.16em] text-dim">
      {order.map((v) => (
        <span key={v} className="flex items-center gap-2">
          <span className={`inline-block size-1.5 rounded-full ${DOT_CLASS[v]}`} aria-hidden />
          {v === "fractional" ? "partial" : v}
        </span>
      ))}
    </div>
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
    <div className="flex flex-col gap-2 border-l-2 border-line bg-raised/30 px-4 py-4 sm:px-5">
      <div className="hidden gap-4 mono text-[9px] uppercase tracking-[0.16em] text-dim sm:flex">
        <span className="w-10 sm:w-16">Side</span>
        <span className="flex-1">Market</span>
        <span className="w-16 text-right">Live</span>
        <span className="w-16 text-right">Expires</span>
        <span className="w-20 text-right">Outcome</span>
      </div>
      {row.parlay.legs.map((leg, i) => {
        const m = markets.get(leg.vault.toLowerCase());
        const coin = m ? (leg.isYes ? m.coinYes : m.coinNo) : undefined;
        const raw = coin === undefined ? undefined : mids[coin];
        const n = raw === undefined ? NaN : Number(raw);
        // Only a value strictly inside (0, 1) is a probability - the same
        // domain priceBreakdown() enforces. allMids carries every coin on
        // the venue, so anything else is not this leg's price.
        const live = Number.isFinite(n) && n > 0 && n < 1 ? n : null;
        const verdict = VERDICT_STYLE[row.legVerdicts[i]];
        return (
          // flex-wrap: on mobile the meta line's basis-full pushes it to a
          // second row; live/expires columns only exist at sm+.
          <div key={leg.vault} className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 mono text-xs">
            <span className={`w-10 shrink-0 truncate sm:w-16 ${m?.group ? "" : "uppercase"} ${leg.isYes ? "text-yes" : "text-no"}`}>{sideLabel(m, leg.isYes)}</span>
            {/* The leg is a HyperCore market - link its live order book, not the
                EVM explorer. Explorer stays the fallback for archived legs whose
                market (and coin) the registry no longer carries. */}
            <a
              href={
                coin === undefined
                  ? `${EXPLORER}/address/${leg.vault}`
                  : tradeUrl(coin)
              }
              target="_blank"
              rel="noreferrer"
              className="min-w-0 flex-1 truncate text-fg underline decoration-line underline-offset-4 transition-colors hover:decoration-dim"
            >
              {m?.title ?? leg.vault}
            </a>
            <span className="hidden w-16 text-right text-dim sm:block">
              {live === null ? "-" : pct1(live)}
            </span>
            <span className="hidden w-16 text-right text-dim sm:block">{m?.expiryMs ? until(m.expiryMs) : "-"}</span>
            <span className={`text-right sm:w-20 ${verdict.className}`}>{verdict.label}</span>
            <span className="basis-full pl-14 text-[10px] text-dim sm:hidden">
              {live === null ? "-" : pct1(live)} live · expires {m?.expiryMs ? until(m.expiryMs) : "-"}
            </span>
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
    <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line sm:grid-cols-3 lg:grid-cols-5">
      {cells.map((c) => (
        <div key={c.label} className="bg-panel px-[18px] py-[14px]">
          <p className="mono text-[10px] uppercase tracking-[0.16em] text-dim">{c.label}</p>
          <p className={`mono mt-1 text-[16px] ${c.className}`}>{c.value}</p>
        </div>
      ))}
    </div>
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

  const { rows, error, load, reloadRow } = usePositions(publicClient, address);
  const actionInFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [pending, setPending] = useState<{ id: bigint; kind: "claim" | "resolve" } | null>(null);
  const [actionError, setActionError] = useState<{ id: bigint; msg: string } | null>(null);
  const [expanded, setExpanded] = useState<bigint | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const mids = useMids();

  // Registry metadata supplies sports labels; addresses remain the fallback.
  useEffect(() => {
    fetchMarkets(true)
      .then(setMarkets)
      .catch(() => {});
  }, []);
  const marketsByVault = useMemo(
    () => new Map(markets.map((m) => [m.vault.toLowerCase(), m])),
    [markets],
  );

  async function act(row: Row, kind: "claim" | "resolve") {
    const id = row.id;
    if (!publicClient || !address || actionInFlight.current) return;
    actionInFlight.current = true;
    setPending({ id, kind });
    setActionError(null);
    try {
      const hash = await writeContractAsync({
        address: PARLAY_VAULT,
        abi: parlayVaultAbi,
        functionName: kind === "claim" ? "claim" : "resolveParlay",
        args: [id],
        account: address,
        chainId: hyperEvmTestnet.id,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (!mounted.current) return;
      if (receipt.status !== "success") throw new Error("Transaction reverted; retry after refreshing the position.");
      await reloadRow(row);
    } catch (err) {
      if (mounted.current) setActionError({ id, msg: shortError(err) });
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setPending(null);
    }
  }

  return (
    <div className="min-h-screen text-[13px] text-fg">

      <main className="mx-auto max-w-[1280px] px-4 py-8 sm:px-6 sm:py-10">
        <h1 className="display text-[32px] [font-variation-settings:'wght'_700] tracking-[-0.03em]">
          Your slips
        </h1>
        <p className="mt-1 text-[15px] text-dim">
          Read straight from chain - slip mints, leg settlement, and claims.
        </p>

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
            <SummaryStrip rows={rows} />

            {/* Mobile: one card per slip; the table needs 860px and horizontal
                scrolling a slip list shouldn't. */}
            <div className="mt-4 flex flex-col gap-3 md:hidden">
              {rows.map((row) => {
                const view = deriveRow(row);
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
                        <span>
                          #{row.id.toString().padStart(4, "0")}
                          <span className="ml-2 text-[11px] text-dim">{ago(row.mintedAtMs)}</span>
                        </span>
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
                        <button
                          type="button"
                          disabled={pending !== null}
                          onClick={() => void act(row, view.action!.kind)}
                          className={`mono w-full rounded-[4px] px-3 py-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
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
                    const view = deriveRow(row);
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
                          <td className={`px-5 py-4 ${view.statusClass}`}>{view.statusLabel}</td>
                          <td className="px-5 py-4 text-right" onClick={(e) => e.stopPropagation()}>
                            {view.action ? (
                              <button
                                type="button"
                                disabled={pending !== null}
                                onClick={() => void act(row, view.action!.kind)}
                                className={`rounded-[4px] px-3 py-1 mono text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
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
          </>
        )}
      </main>
    </div>
  );
}
