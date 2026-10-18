"use client";

import Link from "next/link";
import { useRef } from "react";
import type { useTicket } from "./use-ticket";
import type { BuilderLeg } from "@/lib/ticket";
import { formatUnits } from "viem";
import {
  marketMid,
  type QuoteResult,
  type WriterLimits,
} from "@/lib/writer";
import { useMids } from "@/lib/mids";
import { usePrinting } from "@/lib/print";
import {
  formatUsdc,
  edgeSteps,
  multiplierNum,
  priceBreakdown,
  quotedOverround,
  USDC_DECIMALS,
  type PriceBreakdown,
} from "@/lib/format";
import { appChain, tradeUrl } from "@/lib/chain";
import { BridgeStep } from "./bridge-step";
import { STAKE_CHIPS, chipState } from "@/lib/slip-summary";
import { formatOdds, useOddsFormat } from "@/lib/odds-format";
import { Overround } from "@/app/overround-motif";
import { CountUp } from "@/app/live";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export type { BuilderLeg } from "@/lib/ticket";
const legLabel = (leg: BuilderLeg): string => leg.label ?? (leg.isYes ? "YES" : "NO");

function errorMessage(res: Extract<QuoteResult, { ok: false }>, legs: BuilderLeg[] = []): string {
  if (res.status === 400 && res.error === "dominated") {
    const keep = legs.find((l) => l.vault.toLowerCase() === res.vault?.toLowerCase());
    return keep
      ? `This ticket pays less than "${keep.title}" alone. Remove a leg or choose another game.`
      : "This ticket pays less than one leg alone. Remove a leg or choose another game.";
  }
  if (res.error === "clock-skew") return "Quote expired immediately - check your clock.";
  if (res.error === "stale-book") return "No live price for one of these markets right now - try again shortly.";
  if (res.error === "unpriced-leg") return "One leg has no live price right now. Soccer markets close at kickoff - remove it and requote.";
  if (res.error === "warming-up") return "Writer just restarted and is warming up - retry in a few seconds.";
  if (res.error === "rpc-down") return "Chain RPC is rate-limiting the writer - retry in a moment.";
  if (res.status === 0 || res.status === 503) return "Writer unreachable - retrying.";
  if (res.status === 429) return "Too many quotes too fast - pausing a moment.";
  if (res.status === 401 || res.status === 403) return "Sign in with this wallet again to continue.";
  if (res.status === 409) {
    if (res.error === "leg-settled") return "A leg just settled - remove it and requote.";
    if (res.error === "quota-cap")
      return "This account has hit its open-ticket quota - wait for reservations to clear.";
    const fit = res.maxStake === undefined ? 0n : BigInt(res.maxStake);
    if (fit > 0n) return `Payout too large for the house limit - stake up to ${formatUsdc(fit)} USDC on this ticket.`;
    if (res.error === "at-capacity") return "House bankroll is fully committed - try again shortly.";
    return "Payout too large for the house limit on one of these markets.";
  }
  if (res.status === 400 && res.error === "cannot-win")
    return "These legs contradict each other - this ticket can never win.";
  if (res.status === 400 && res.error === "same-game")
    return "Two legs from the same game - parlays need different games. Drop one.";
  return "Could not quote this ticket. Check your selections and try again.";
}

function DetailRow({
  label,
  children,
  className = "",
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-dim">{label}</span>
      <span className={`text-right ${className}`}>{children}</span>
    </div>
  );
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const mult = (x: number) => `${x.toFixed(2)}x`;
const usdc2 = (x: number) => x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signedMult = (x: number) => `${x < 0 ? "\u2212" : "+"}${Math.abs(x).toFixed(2)}x`;

function MathBreakdown({ legs, bd }: { legs: BuilderLeg[]; bd: PriceBreakdown }) {
  const { afterEdge, afterLegs, modelled } = edgeSteps(bd);
  const capped = Math.abs(bd.actualMultiplier - modelled) / modelled > 0.005;
  return (
    <div className="flex flex-col gap-1.5">
      {legs.map((leg, i) => (
        <div key={leg.vault} className="flex items-baseline gap-3">
          <span className={`max-w-24 truncate ${leg.group ? "" : "uppercase"} ${leg.isYes ? "text-yes" : "text-no"}`}>
            {legLabel(leg)}
          </span>
          <span className="flex-1 truncate text-dim">{leg.title}</span>
          <span className="w-14 text-right">{pct(bd.legProbs[i])}</span>
          <span className="w-14 text-right">{mult(bd.legOdds[i])}</span>
        </div>
      ))}
      <div className="mt-1 border-t border-line pt-1.5" />
      <DetailRow label="Fair combined odds">{mult(bd.fairMultiplier)}</DetailRow>
      <DetailRow label={`House edge ${pct(bd.edgePct)}`} className="text-no">
        {signedMult(afterEdge - bd.fairMultiplier)}
      </DetailRow>
      {bd.legPct > 0 && (
        <DetailRow label={`${legs.length} legs ${pct(bd.legPct)}`} className="text-no">
          {signedMult(afterLegs - afterEdge)}
        </DetailRow>
      )}
      {capped && (
        <DetailRow label="Payout cap" className="text-no">
          {signedMult(bd.actualMultiplier - modelled)}
        </DetailRow>
      )}
      <DetailRow label="Your multiplier" className="text-accent">
        {mult(bd.actualMultiplier)}
      </DetailRow>
    </div>
  );
}

function HouseLimits({ limits, maxStake }: { limits: WriterLimits | null; maxStake: bigint }) {
  const usdc = (v: string | null | undefined) => (v ? `${formatUsdc(BigInt(v))} USDC` : "-");
  const available =
    limits?.bankroll ? formatUsdc(BigInt(limits.bankroll) - BigInt(limits.reserved ?? "0")) + " USDC" : null;
  return (
    <details className="mt-1 mono text-[11px] text-dim">
      <summary className="cursor-pointer">
        House limit {formatUsdc(maxStake)} USDC per ticket{available && ` · ${available} bankroll`}
      </summary>
      <div className="mt-2 flex flex-col gap-1 rounded-[4px] border border-line bg-raised/40 px-3 py-2">
        <DetailRow label="Max stake per ticket">{formatUsdc(maxStake)} USDC</DetailRow>
        <DetailRow label="House bankroll available">{available ?? "-"}</DetailRow>
        <DetailRow label="Max house risk per market">{usdc(limits?.perMarketCap)}</DetailRow>
        <DetailRow label="Max house risk per competition">{usdc(limits?.perClusterCap)}</DetailRow>
        <DetailRow label="Open-quote budget per account">{usdc(limits?.perCodeReservedCap)}</DetailRow>
        <p className="mt-1 text-[10px] leading-relaxed">
          Risk is your max payout minus your stake. A quote that would push any of these over its cap comes back with the largest stake that fits.
        </p>
      </div>
    </details>
  );
}


export function Ticket({
  legs,
  onRemove,
  ticket,
  compact = false,
}: {
  legs: BuilderLeg[];
  onRemove: (vault: `0x${string}`) => void;
  ticket: ReturnType<typeof useTicket>;
  compact?: boolean;
}) {
  const mids = useMids();
  const ctaClass = "mono mt-4 h-12 w-full text-[14px] font-semibold";
  const printing = usePrinting();
  const format = useOddsFormat();
  const { stake, setStake, quoteResult, ttlLeft, ttlSeconds, mintState, mintErrorMsg, mintErrorDetail,
    maxStake, limits, usdcBalance, cta, approve, mintQuoted, retry, connect, switchChain, address, stakeBase, toWin } = ticket;
  const lastWin = useRef<bigint | null>(null);
  if (toWin !== null) lastWin.current = toWin;
  if (legs.length < 2 || stakeBase === null || (quoteResult && !quoteResult.ok)) lastWin.current = null;

  // Quote-derived display values. premium/maxPayout are the signed truth;
  // `bd` re-derives the writer's pricing steps for the breakdown accordion.
  const premium = quoteResult?.ok ? BigInt(quoteResult.quote.premium) : 0n;
  const maxPayout = quoteResult?.ok ? BigInt(quoteResult.quote.maxPayout) : 0n;
  const bd =
    quoteResult?.ok && quoteResult.breakdown
      ? priceBreakdown(
          quoteResult.breakdown.legPricesWad,
          quoteResult.breakdown.edgeBps,
          quoteResult.breakdown.legBps,
          premium,
          maxPayout,
        )
      : null;
  const margin = bd ? quotedOverround(bd) : null;
  // The stake you'd need to win back exactly what you paid - the honest
  // "how likely does this have to be" number behind the multiplier.
  const m = multiplierNum(premium, maxPayout);
  const breakEven = m > 0 ? 1 / m : null;
  const maxAllowed =
    usdcBalance === undefined
      ? maxStake
      : maxStake === null
        ? usdcBalance
        : usdcBalance < maxStake
          ? usdcBalance
          : maxStake;
  return (
    <div
      className={`text-[13px] ${compact ? "" : "rounded-card border border-line bg-panel px-5 py-6 shadow-[0_24px_60px_rgba(4,10,12,0.5)] sm:px-7 sm:py-8"} ${printing}`}
    >
      {!compact && (
        <div className="flex items-start justify-between">
          <span className="mono text-[10px] uppercase tracking-[0.16em] text-dim">Your slip</span>
          <Overround size={44} margin={margin} />
        </div>
      )}

      {legs.length === 0 ? (
        <p className={`${compact ? "" : "mt-4"} text-dim`}>Tap any price to start a slip.</p>
      ) : (
        <ul className={`${compact ? "" : "mt-4"} flex flex-col gap-px overflow-hidden rounded-[8px] border border-line bg-line`}>
          {legs.map((leg) => (
            <li key={leg.vault} className="print-line flex items-center gap-3 bg-ink px-4 py-[13px]">
              <span
                title={legLabel(leg)}
                className={`mono max-w-36 truncate text-[11px] ${leg.group ? "" : "uppercase"} ${leg.isYes ? "text-yes" : "text-no"}`}
              >
                {legLabel(leg)}
              </span>
              <a
                href={tradeUrl(leg.coin)}
                target="_blank"
                rel="noreferrer"
                title={leg.title}
                className="flex-1 truncate text-fg underline decoration-line underline-offset-4 transition-colors hover:decoration-dim"
              >
                {leg.title}
              </a>
              <span className="mono text-dim">{formatOdds(marketMid(mids, {}, leg.coin), format)}</span>
              <Button variant="ghost" size="icon-sm" onClick={() => onRemove(leg.vault)} aria-label={`Remove ${leg.title}`} className="shrink-0 text-dim hover:text-no"><XIcon /></Button>
            </li>
          ))}
        </ul>
      )}

      <>
          <div className="mt-4">
            <div className="grid grid-cols-2 items-end gap-3">
              <div>
                <label htmlFor="stake" className="mono text-[10px] uppercase tracking-[0.16em] text-dim">Stake</label>
                <div className="mt-1 flex items-center gap-1 rounded-card border border-line bg-ink px-3 py-2 focus-within:border-accent">
                  <span className="mono text-[16px] leading-none text-dim">$</span>
                  <input id="stake" inputMode="decimal" autoComplete="off" value={stake} onChange={(e) => setStake(e.target.value)} placeholder="0.00"
                    className="mono w-full bg-transparent text-[20px] leading-none text-fg outline-none placeholder:text-dim" />
                </div>
              </div>
              <div className="text-right">
                <span className="mono text-[10px] uppercase tracking-[0.16em] text-dim">To win</span>
                <div className={`mono mt-1 text-[22px] leading-none ${toWin === null ? "text-dim" : "text-accent"}`}>
                  {toWin === null ? (lastWin.current === null ? "—" : `$${formatUsdc(lastWin.current)}`) : <CountUp value={Number(formatUnits(toWin, USDC_DECIMALS))} format={(x) => `$${usdc2(x)}`} />}
                </div>
              </div>
            </div>
            <div className="mt-2 flex gap-1.5">
              <ToggleGroup type="single" size="sm" variant="outline" value={STAKE_CHIPS.some((v) => String(v) === stake) ? stake : ""} onValueChange={(v) => { if (v) setStake(v); }} aria-label="Stake presets" className="flex-1 gap-1.5 [&>*]:flex-1">
                {STAKE_CHIPS.map((v) => {
                  const c = chipState(v, maxStake, usdcBalance);
                  return (
                    <ToggleGroupItem key={v} value={String(v)} disabled={!c.enabled} title={c.title} className="mono h-8 border-line px-0 text-[11px] text-dim data-[state=on]:border-accent data-[state=on]:bg-transparent data-[state=on]:text-accent">
                      ${v}
                    </ToggleGroupItem>
                  );
                })}
              </ToggleGroup>
              <Button variant="outline" size="sm" disabled={maxAllowed === null || maxAllowed === 0n} title={maxAllowed === null ? "House limit unknown" : maxAllowed === 0n ? "No USDC in this wallet" : undefined}
                onClick={() => maxAllowed !== null && setStake(formatUnits(maxAllowed, USDC_DECIMALS))} className="mono h-8 flex-1 border-line text-[11px] text-dim">
                Max
              </Button>
            </div>
            <div className="mono mt-2 flex items-center justify-between text-[11px] text-dim">
              <span>{quoteResult?.ok ? `Ticket ${mult(multiplierNum(premium, maxPayout))} · ${legs.length} legs` : `Balance $${usdcBalance === undefined ? "–" : formatUsdc(usdcBalance)}`}</span>
              {quoteResult?.ok && <span>Quote locked {ttlLeft}s</span>}
            </div>
          </div>

          {quoteResult?.ok && (
            <div className="mt-4">
              <div className="h-[3px] overflow-hidden rounded-full bg-raised">
                <div
                  className="h-full origin-left bg-accent transition-transform duration-1000 ease-linear motion-reduce:transition-none"
                  style={{ transform: `scaleX(${Math.max(0, Math.min(1, ttlLeft / ttlSeconds))})` }}
                />
              </div>
            </div>
          )}

          {quoteResult?.ok && (
            <div className="print-line mono mt-4 flex flex-col gap-2 text-[12px]">
              <details className="rounded-[4px] border border-line bg-raised/40 px-3 py-2">
                <summary className="flex cursor-pointer items-center justify-between text-[11px] text-dim">Quote details</summary>
                <div className="mt-3 flex flex-col gap-3 text-[11px]">
                  {bd && bd.legProbs.length === legs.length ? (
                    <MathBreakdown legs={legs} bd={bd} />
                  ) : (
                    <p className="text-dim">Breakdown unavailable for this quote.</p>
                  )}
                  {maxStake !== null && <HouseLimits limits={limits} maxStake={maxStake} />}

                  <div className="flex flex-col gap-1.5 border-t border-line pt-3">
                    <DetailRow label="Profit if won" className="text-yes">
                      +{formatUsdc(maxPayout - premium)} USDC
                    </DetailRow>
                    <DetailRow label="Break-even probability">{breakEven === null ? "-" : pct(breakEven)}</DetailRow>
                    <DetailRow label="Max loss" className="text-no">
                      {formatUsdc(premium)} USDC
                    </DetailRow>
                  </div>
                </div>
              </details>
            </div>
          )}

          {quoteResult && !quoteResult.ok && (
            <div className="mt-4 rounded-[4px] border border-no/30 bg-no/5 p-3">
              <p className="text-no">{errorMessage(quoteResult, legs)}</p>
              {errorMessage(quoteResult, legs) !== quoteResult.error && (
                <p className="mt-1 mono text-[11px] text-no/70">{quoteResult.error}</p>
              )}
              {(quoteResult.status === 0 || quoteResult.status === 503 || quoteResult.status === 429) && (
                <Button variant="outline" size="xs" onClick={retry} className="mono mt-2 border-line text-[11px] text-dim">Retry</Button>
              )}
              {quoteResult.maxStake !== undefined && BigInt(quoteResult.maxStake) > 0n && (
                <Button variant="outline" size="xs" onClick={() => setStake(formatUnits(BigInt(quoteResult.maxStake!), USDC_DECIMALS))} className="mono mt-2 ml-2 border-line text-[11px] text-dim">
                  Use {formatUsdc(BigInt(quoteResult.maxStake))} USDC
                </Button>
              )}
            </div>
          )}
      </>

      {cta ? (
        <>
          {cta.kind === "connect" && <Button size="lg" onClick={() => connect()} className={ctaClass}>{cta.label}</Button>}
          {cta.kind === "switch-chain" && <Button size="lg" onClick={() => switchChain({ chainId: appChain.id })} className={ctaClass}>{cta.label}</Button>}
          {cta.kind === "bridge" && address && <BridgeStep address={address} needUsdc={cta.usdc} needGas={cta.gas} />}
          {cta.kind === "done" && <Button size="lg" asChild className={`${ctaClass} bg-yes hover:bg-yes/80`}><Link href={cta.href}>{cta.label}</Link></Button>}
          {cta.kind === "external" && (
            <>
              <Button size="lg" asChild className={ctaClass}><a href={cta.href} target="_blank" rel="noreferrer">{cta.label}</a></Button>
              <p className="mt-2 text-center mono text-[11px] text-dim">{cta.hint}</p>
            </>
          )}
          {cta.kind === "pay" && (
            <div className="mt-4 flex flex-col gap-2">
              {cta.needsApproval && (
                <p className="rounded-[6px] border border-accent/30 bg-accent/10 px-3 py-2 text-[12px] text-fg">
                  Approve USDC once so later tickets are a single wallet prompt.
                </p>
              )}
              <Button size="lg" disabled={!cta.enabled}
                onClick={() => cta.step === "approve" ? void approve() : quoteResult?.ok && mintQuoted(quoteResult.quote, quoteResult.sig)}
                className={`${ctaClass} mt-0`}>
                {cta.label}
              </Button>
            </div>
          )}
          {cta.kind === "disabled" && (
            <Button size="lg" variant="secondary" disabled className={`${ctaClass} text-dim disabled:opacity-100`}>{cta.label}</Button>
          )}
          {mintState === "requoted" && (
            <p className="mt-3 text-center mono text-[11px] text-accent">Quote refreshed - mint again</p>
          )}
          {mintState === "error" && mintErrorMsg && (
            <div className="mt-3">
              <p className="text-center text-xs text-no">{mintErrorMsg}</p>
              {mintErrorDetail && mintErrorDetail !== mintErrorMsg && (
                <details className="mt-2 rounded-[4px] border border-no/30 bg-no/5 p-2">
                  <summary className="cursor-pointer mono text-[11px] text-no/70">Full error</summary>
                  <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-all mono text-[11px] leading-relaxed text-no/80">
                    {mintErrorDetail}
                  </pre>
                </details>
              )}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
