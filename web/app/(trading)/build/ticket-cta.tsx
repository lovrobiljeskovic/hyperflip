"use client";

import Link from "next/link";
import { formatUnits } from "viem";
import type { useTicket } from "./use-ticket";
import type { BuilderLeg } from "@/lib/ticket";
import type { QuoteResult } from "@/lib/writer";
import { formatUsdc, USDC_DECIMALS } from "@/lib/format";
import { errorMessage } from "@/lib/quote-errors";
import { appChain } from "@/lib/chain";
import { BridgeStep } from "./bridge-step";
import { Button } from "@/components/ui/button";

type T = ReturnType<typeof useTicket>;

export function QuoteError({
  quoteResult,
  legs,
  retry,
  setStake,
}: Pick<T, "retry" | "setStake"> & { quoteResult: Extract<QuoteResult, { ok: false }>; legs: BuilderLeg[] }) {
  return (
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
  );
}

const ctaClass = "mono h-12 w-full text-[14px] font-semibold";

export function TicketCta({ ticket }: { ticket: T }) {
  const { cta, connect, switchChain, address, approve, mintQuoted, quoteResult, mintState, mintErrorMsg, mintErrorDetail } = ticket;
  return (
    <>
      {cta.kind === "connect" && <Button size="lg" onClick={() => connect()} className={`${ctaClass} mt-4`}>{cta.label}</Button>}
      {cta.kind === "switch-chain" && <Button size="lg" onClick={() => switchChain({ chainId: appChain.id })} className={`${ctaClass} mt-4`}>{cta.label}</Button>}
      {cta.kind === "bridge" && address && <BridgeStep address={address} needUsdc={cta.usdc} needGas={cta.gas} />}
      {cta.kind === "done" && <Button size="lg" asChild className={`${ctaClass} mt-4 bg-yes hover:bg-yes/80`}><Link href={cta.href}>{cta.label}</Link></Button>}
      {cta.kind === "external" && (
        <>
          <Button size="lg" asChild className={`${ctaClass} mt-4`}><a href={cta.href} target="_blank" rel="noreferrer">{cta.label}</a></Button>
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
            className={ctaClass}>
            {cta.label}
          </Button>
        </div>
      )}
      {cta.kind === "disabled" && (
        <Button size="lg" variant="secondary" disabled className={`${ctaClass} mt-4 text-dim disabled:opacity-100`}>{cta.label}</Button>
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
  );
}
