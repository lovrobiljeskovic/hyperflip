"use client";

import { useRef } from "react";
import type { useTicket } from "./use-ticket";
import { legLabel, type BuilderLeg } from "@/lib/ticket";
import { marketMid } from "@/lib/writer";
import { useMids } from "@/lib/mids";
import { usePrinting } from "@/lib/print";
import { multiplierNum, priceBreakdown, quotedOverround } from "@/lib/format";
import { tradeUrl } from "@/lib/chain";
import { formatOdds, useOddsFormat } from "@/lib/odds-format";
import { Overround } from "@/app/overround-motif";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QuoteDetails } from "./quote-details";
import { StakeInput } from "./stake-input";
import { QuoteError, TicketCta } from "./ticket-cta";

export type { BuilderLeg } from "@/lib/ticket";

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
  return (
    <div
      className={`text-[13px] ${compact ? "" : "rounded-card border border-line bg-panel px-5 py-6 shadow-[0_24px_60px_rgba(4,10,12,0.5)] sm:px-7 sm:py-8"} ${printing}`}
    >
      {!compact && (
        <div className="flex items-start justify-between">
          <span className="mono text-[10px] uppercase tracking-[0.16em] text-dim">Your slip</span>
          <Overround margin={margin} />
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

      <StakeInput
        stake={stake}
        setStake={setStake}
        toWin={toWin}
        lastWin={lastWin.current}
        maxStake={maxStake}
        usdcBalance={usdcBalance}
        ticketMult={quoteResult?.ok ? multiplierNum(premium, maxPayout) : null}
        legCount={legs.length}
        ttlLeft={ttlLeft}
      />

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
        <QuoteDetails legs={legs} bd={bd} limits={limits} maxStake={maxStake} premium={premium} maxPayout={maxPayout} />
      )}

      {quoteResult && !quoteResult.ok && (
        <QuoteError quoteResult={quoteResult} legs={legs} retry={retry} setStake={setStake} />
      )}

      {cta ? (
        <TicketCta
          cta={cta}
          connect={connect}
          switchChain={switchChain}
          address={address}
          approve={approve}
          mintQuoted={mintQuoted}
          quoteResult={quoteResult}
          mintState={mintState}
          mintErrorMsg={mintErrorMsg}
          mintErrorDetail={mintErrorDetail}
        />
      ) : null}
    </div>
  );
}
