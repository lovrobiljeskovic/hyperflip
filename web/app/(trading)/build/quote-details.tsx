"use client";

import type { WriterLimits } from "@/lib/writer";
import type { BuilderLeg } from "@/lib/ticket";
import { legLabel } from "@/lib/ticket";
import { edgeSteps, formatUsdc, mult, multiplierNum, pct, type PriceBreakdown } from "@/lib/format";

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

const signedMult = (x: number) => `${x < 0 ? "\u2212" : "+"}${Math.abs(x).toFixed(2)}x`;

function MathBreakdown({ legs, bd }: { legs: BuilderLeg[]; bd: PriceBreakdown }) {
  const { afterEdge, afterLegs } = edgeSteps(bd);
  const capped = Math.abs(bd.actualMultiplier - afterLegs) / afterLegs > 0.005;
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
          {signedMult(bd.actualMultiplier - afterLegs)}
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

export function QuoteDetails({
  legs,
  bd,
  limits,
  maxStake,
  premium,
  maxPayout,
}: {
  legs: BuilderLeg[];
  bd: PriceBreakdown | null;
  limits: WriterLimits | null;
  maxStake: bigint | null;
  premium: bigint;
  maxPayout: bigint;
}) {
  // The stake you'd need to win back exactly what you paid - the honest
  // "how likely does this have to be" number behind the multiplier.
  const m = multiplierNum(premium, maxPayout);
  const breakEven = m > 0 ? 1 / m : null;
  return (
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
  );
}
