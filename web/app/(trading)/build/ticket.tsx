"use client";

import Link from "next/link";
import { useState } from "react";
import { useTicket } from "./use-ticket";
import type { BuilderLeg } from "@/lib/ticket";
import { formatUnits } from "viem";
import {
  joinWaitlist,
  WAITLIST_ERRORS,
  type QuoteResult,
} from "@/lib/writer";
import { useMids } from "@/lib/mids";
import { usePrinting } from "@/lib/print";
import {
  formatUsdc,
  impliedPct,
  multiplier,
  edgeSteps,
  multiplierNum,
  priceBreakdown,
  quotedOverround,
  USDC_DECIMALS,
  type PriceBreakdown,
} from "@/lib/format";
import { hyperEvmTestnet, tradeUrl } from "@/lib/chain";
import { Overround } from "@/app/overround-motif";

export type { BuilderLeg } from "@/lib/ticket";
const legLabel = (leg: BuilderLeg): string => leg.label ?? (leg.isYes ? "YES" : "NO");

// Percent-of-cap stake chips - resolved against the writer's maxStake, or
// treated as plain USDC amounts when /limits is unreachable.
const STAKE_PRESETS = [25, 50, 100];

function midPct(mids: Record<string, string>, coin: string): string {
  const raw = mids[coin];
  if (raw === undefined) return "-";
  const n = Number(raw);
  // Only a value strictly inside (0, 1) is a probability - the same domain
  // priceBreakdown() enforces. allMids carries every coin on the venue.
  return Number.isFinite(n) && n > 0 && n < 1 ? impliedPct(n) : "-";
}

function errorMessage(res: Extract<QuoteResult, { ok: false }>, legs: BuilderLeg[] = []): string {
  if (res.status === 400 && res.error === "dominated") {
    const keep = legs.find((l) => l.vault.toLowerCase() === res.vault?.toLowerCase());
    return keep
      ? `This ticket pays less than "${keep.title}" alone. Remove a leg or choose another game.`
      : "This ticket pays less than one leg alone. Remove a leg or choose another game.";
  }
  if (res.error === "clock-skew") return "Quote expired immediately - check your clock.";
  if (res.error === "stale-book") return "No live price for one of these markets right now - try again shortly.";
  if (res.error === "warming-up") return "Writer just restarted and is warming up - retry in a few seconds.";
  if (res.error === "rpc-down") return "Chain RPC is rate-limiting the writer - retry in a moment.";
  if (res.error === "no-quotes") return "No maker quoted this ticket, try again.";
  if (res.status === 0 || res.status === 503) return "Writer unreachable - retrying.";
  if (res.status === 429) return "Too many quotes too fast - pausing a moment.";
  if (res.status === 403) return "Invite code rejected - enter a valid one below.";
  if (res.status === 409) {
    if (res.error === "leg-settled") return "A leg just settled - remove it and requote.";
    if (res.error === "quota-cap")
      return "This invite code has hit its open-ticket quota - wait ~a minute for reservations to clear or use another code.";
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

/** Inline invite entry - save a code, or get one emailed via the waitlist -
 * so a tester never has to leave the builder. */
function InviteEntry({ onSave }: { onSave: (code: string) => void }) {
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [waitState, setWaitState] = useState<"idle" | "sending" | "sent">("idle");
  const [waitError, setWaitError] = useState("");

  const inputClass =
    "w-full rounded-card border border-line bg-panel px-3 py-2 mono text-sm text-fg placeholder:text-dim focus:border-accent";
  const buttonClass =
    "shrink-0 rounded-card bg-accent px-4 py-2 mono text-[11px] uppercase tracking-[0.1em] text-on-accent transition-transform motion-reduce:transition-none active:scale-[0.98] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <div className="mt-4 flex flex-col gap-3">
      <p className="mono text-[11px] text-dim">Saved your invite on the website? Enter it here once to use it in the app.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = code.trim();
          if (!trimmed) return;
          localStorage.setItem("inviteCode", trimmed);
          onSave(trimmed);
        }}
        className="flex gap-2"
      >
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="Invite code"
          aria-label="Invite code"
          className={inputClass}
        />
        <button type="submit" className={buttonClass}>
          Save
        </button>
      </form>
      {waitState === "sent" ? (
        <p className="mono text-[11px] text-yes">Invite sent - check your email, then paste the code above.</p>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setWaitError("");
            setWaitState("sending");
            const res = await joinWaitlist(email.trim());
            if (res.ok) setWaitState("sent");
            else {
              setWaitState("idle");
              setWaitError(WAITLIST_ERRORS[res.error] ?? res.error);
            }
          }}
          noValidate
          className="flex flex-col gap-1"
        >
          <div className="flex gap-2">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              autoComplete="email"
              spellCheck={false}
              placeholder="No code? your@email.com"
              aria-label="Email for a beta invite"
              className={inputClass}
            />
            <button type="submit" disabled={waitState === "sending"} className={buttonClass}>
              {waitState === "sending" ? "Sending…" : "Get invite"}
            </button>
          </div>
          {waitError && <p className="text-xs text-no">{waitError}</p>}
        </form>
      )}
    </div>
  );
}

export function Ticket({
  legs,
  onRemove,
  display = false,
}: {
  legs: BuilderLeg[];
  onRemove: (vault: `0x${string}`) => void;
  display?: boolean;
}) {
  const mids = useMids();
  const printing = usePrinting();
  const { stake, setStake, quoteResult, ttlLeft, ttlSeconds, mintState, mintErrorMsg, mintErrorDetail,
    setInviteCode, maxStake, usdcBalance, allowance, cta, mintQuoted, retry, connect, switchChain } = useTicket(legs, display);

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
  // The motif's ring splay is the book's margin on the live quote.
  const margin = bd ? quotedOverround(bd) : null;
  // The stake you'd need to win back exactly what you paid - the honest
  // "how likely does this have to be" number behind the multiplier.
  const m = multiplierNum(premium, maxPayout);
  const breakEven = m > 0 ? 1 / m : null;
  const needsApproval = allowance === undefined || allowance < premium;
  // Max is whichever runs out first: your balance or the house per-ticket cap.
  const maxAllowed =
    usdcBalance === undefined
      ? maxStake
      : maxStake === null
        ? usdcBalance
        : usdcBalance < maxStake
          ? usdcBalance
          : maxStake;
  // Presets scale off the cap so no chip is a button that always 400s.
  const presets = STAKE_PRESETS.map((f) =>
    maxStake === null ? BigInt(f) * 10n ** BigInt(USDC_DECIMALS) : (maxStake * BigInt(f)) / 100n,
  );

  // Display-mode sample math: fair combined odds off live mids, no house edge.
  // Every leg must carry a real probability - treating an unpriced leg as
  // certain would overstate the multiplier, so the figure goes unavailable
  // instead.
  const sampleProbs = legs.map((l) => {
    const raw = mids[l.coin];
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
  });
  const combinedImplied =
    legs.length && sampleProbs.every((p) => p !== null) ? (sampleProbs as number[]).reduce((acc, p) => acc * p, 1) : 0;
  const sampleMultiplier = combinedImplied > 0 ? 1 / combinedImplied : null;
  const samplePayout = sampleMultiplier === null ? null : 100 * sampleMultiplier;

  return (
    <div
      className={`rounded-card border border-line bg-panel px-5 py-6 text-[13px] shadow-[0_24px_60px_rgba(4,10,12,0.5)] sm:px-7 sm:py-8 ${printing}`}
    >
      <div className="flex items-start justify-between">
        <span className="mono text-[10px] uppercase tracking-[0.16em] text-dim">Your slip</span>
        <Overround size={44} margin={margin} />
      </div>

      {legs.length === 0 ? (
        <p className="mt-4 text-dim">No legs yet - pick a side from the market list.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-px bg-line">
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
              <span className="mono text-dim">{midPct(mids, leg.coin)}</span>
              {!display && (
                <button
                  type="button"
                  onClick={() => onRemove(leg.vault)}
                  aria-label={`Remove ${leg.title}`}
                  className="text-dim transition-colors hover:text-no"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {display ? (
        <div className="mono mt-5 flex flex-col gap-2 border-t border-line pt-4 text-[12px]">
          <div className="flex justify-between">
            <span className="text-dim">Stake</span>
            <span>100.00 USDC</span>
          </div>
          <div className="flex justify-between">
            <span className="text-dim">Combined implied</span>
            <span>{combinedImplied > 0 ? impliedPct(combinedImplied) : "-"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-dim">Fair</span>
            <span className="text-dim">{sampleMultiplier === null ? "-" : mult(sampleMultiplier)}</span>
          </div>
          <div className="mt-3 flex items-end justify-between border-t border-line pt-4">
            <span className="mono text-[10px] uppercase tracking-[0.16em] text-dim">Max payout</span>
            <span className="mono text-[30px] leading-none text-accent">
              {samplePayout === null ? "-" : samplePayout.toFixed(2)}
            </span>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-4">
            <div className="flex items-baseline justify-between">
              <label htmlFor="stake" className="mono text-[10px] uppercase tracking-[0.16em] text-dim">
                Stake (USDC)
              </label>
              <span className="mono text-[11px] text-dim">
                Balance {usdcBalance === undefined ? "-" : formatUsdc(usdcBalance)}
              </span>
            </div>
            <input
              id="stake"
              inputMode="decimal"
              autoComplete="off"
              value={stake}
              onChange={(e) => setStake(e.target.value)}
              placeholder="0.00"
              className="mt-1 w-full rounded-card border border-line bg-panel px-3 py-2 mono text-sm text-fg placeholder:text-dim focus:border-accent"
            />
            <div className="mt-2 flex gap-2">
              {presets.map((v, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setStake(formatUnits(v, USDC_DECIMALS))}
                  className="flex-1 rounded-[4px] border border-line py-1 mono text-[11px] text-dim transition-colors hover:border-dim hover:text-fg"
                >
                  {formatUsdc(v)}
                </button>
              ))}
              <button
                type="button"
                disabled={maxAllowed === null || maxAllowed === 0n}
                onClick={() => maxAllowed !== null && setStake(formatUnits(maxAllowed, USDC_DECIMALS))}
                className="flex-1 rounded-[4px] border border-line py-1 mono text-[11px] text-dim transition-colors hover:border-dim hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
              >
                Max
              </button>
            </div>
            {maxStake !== null && (
              <p className="mt-1 mono text-[11px] text-dim">House limit {formatUsdc(maxStake)} USDC per ticket</p>
            )}
          </div>

          {quoteResult?.ok && (
            <div className="print-line mono mt-4 flex flex-col gap-2 border-t border-line pt-4 text-[12px]">
              <DetailRow label="Stake">{formatUsdc(premium)} USDC</DetailRow>
              <DetailRow label="Combined implied">{bd ? pct(1 / bd.fairMultiplier) : "-"}</DetailRow>
              <DetailRow label="Fair" className="text-dim">
                {bd ? mult(bd.fairMultiplier) : "-"}
              </DetailRow>
              <DetailRow label="Quoted" className="text-[20px] leading-none text-accent">
                {multiplier(premium, maxPayout)}
              </DetailRow>
              <div className="mt-3 flex items-end justify-between border-t border-line pt-4">
                <span className="mono text-[10px] uppercase tracking-[0.16em] text-dim">Max payout</span>
                <span className="mono text-[30px] leading-none text-accent">{formatUsdc(maxPayout)}</span>
              </div>

              {/* open by default: the multiplier's derivation is the point of the
                  panel, not a footnote - collapsing it hides the one number a
                  taker most needs to trust. */}
              <details open className="mt-2 rounded-[4px] border border-line bg-raised/40 px-3 py-2">
                <summary className="flex items-center justify-between text-[11px] text-dim">Quote details</summary>
                <div className="mt-3 flex flex-col gap-3 text-[11px]">
                  {bd && bd.legProbs.length === legs.length ? (
                    <MathBreakdown legs={legs} bd={bd} />
                  ) : (
                    <p className="text-dim">Breakdown unavailable for this quote.</p>
                  )}

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

          {quoteResult?.ok && (
            <div className="mt-5">
              <div className="h-[3px] overflow-hidden rounded-full bg-raised">
                <div
                  className="h-full origin-left bg-accent transition-transform duration-1000 ease-linear motion-reduce:transition-none"
                  style={{ transform: `scaleX(${Math.max(0, Math.min(1, ttlLeft / ttlSeconds))})` }}
                />
              </div>
              <p className="mono mt-2 text-[11px] text-dim">Quote reprices in {ttlLeft}s</p>
              {/* Count only - maker identities never reach the browser. */}
              {quoteResult.makers && quoteResult.makers.quoted > 1 && (
                <p className="mono mt-1 text-[11px] text-dim">Best of {quoteResult.makers.quoted} makers</p>
              )}
            </div>
          )}

          {quoteResult && !quoteResult.ok && (
            <div className="mt-4 rounded-[4px] border border-no/30 bg-no/5 p-3">
              <p className="text-no">{errorMessage(quoteResult, legs)}</p>
              {errorMessage(quoteResult, legs) !== quoteResult.error && (
                <p className="mt-1 mono text-[11px] text-no/70">{quoteResult.error}</p>
              )}
              {(quoteResult.status === 0 || quoteResult.status === 503 || quoteResult.status === 429) && (
                <button
                  type="button"
                  onClick={retry}
                  className="mt-2 rounded-[4px] border border-line px-2 py-1 mono text-[11px] text-dim transition-colors hover:text-fg"
                >
                  Retry
                </button>
              )}
              {quoteResult.maxStake !== undefined && BigInt(quoteResult.maxStake) > 0n && (
                <button
                  type="button"
                  onClick={() => setStake(formatUnits(BigInt(quoteResult.maxStake!), USDC_DECIMALS))}
                  className="mt-2 rounded-[4px] border border-line px-2 py-1 mono text-[11px] text-dim transition-colors hover:text-fg"
                >
                  Use {formatUsdc(BigInt(quoteResult.maxStake))} USDC
                </button>
              )}
              {quoteResult.status === 403 && <InviteEntry onSave={setInviteCode} />}
            </div>
          )}
        </>
      )}

      {display && (
        <div className="mt-5">
          <div className="h-[3px] overflow-hidden rounded-full bg-raised">
            <div className="ttl-bar h-full bg-accent" />
          </div>
          <p className="mono mt-2 text-[11px] text-dim">Quote reprices in 30s</p>
        </div>
      )}

      {display ? (
        <div
          className="mono mt-4 rounded-card bg-accent py-[15px] text-center text-[12px] uppercase tracking-[0.1em] text-on-accent"
          aria-hidden
        >
          Mint slip - 100.00 USDC
        </div>
      ) : cta ? (
        <>
          {cta.kind === "connect" && (
            <button
              type="button"
              onClick={() => connect()}
              className="mono mt-4 w-full rounded-card bg-accent py-[15px] text-center text-[12px] uppercase tracking-[0.1em] text-on-accent transition-transform motion-reduce:transition-none active:scale-[0.98] hover:opacity-90"
            >
              {cta.label}
            </button>
          )}
          {cta.kind === "switch-chain" && (
            <button
              type="button"
              onClick={() => switchChain({ chainId: hyperEvmTestnet.id })}
              className="mono mt-4 w-full rounded-card bg-accent py-[15px] text-center text-[12px] uppercase tracking-[0.1em] text-on-accent transition-transform motion-reduce:transition-none active:scale-[0.98] hover:opacity-90"
            >
              {cta.label}
            </button>
          )}
          {cta.kind === "invite" && <InviteEntry onSave={setInviteCode} />}
          {cta.kind === "done" && (
            <Link
              href={cta.href}
              className="mono mt-4 block w-full rounded-card bg-yes py-[15px] text-center text-[12px] uppercase tracking-[0.1em] text-on-accent transition-transform motion-reduce:transition-none active:scale-[0.98] hover:opacity-90"
            >
              {cta.label}
            </Link>
          )}
          {cta.kind === "external" && (
            <>
              <a
                href={cta.href}
                target="_blank"
                rel="noreferrer"
                className="mono mt-4 block w-full rounded-card bg-accent py-[15px] text-center text-[12px] uppercase tracking-[0.1em] text-on-accent transition-transform motion-reduce:transition-none active:scale-[0.98] hover:opacity-90"
              >
                {cta.label}
              </a>
              <p className="mt-2 text-center mono text-[11px] text-dim">{cta.hint}</p>
            </>
          )}
          {cta.kind === "mint" && (
            <button
              type="button"
              onClick={() => quoteResult?.ok && mintQuoted(quoteResult.quote, quoteResult.sig)}
              className="mono mt-4 w-full rounded-card bg-accent py-[15px] text-center text-[12px] uppercase tracking-[0.1em] text-on-accent transition-transform motion-reduce:transition-none active:scale-[0.98] hover:opacity-90"
            >
              {cta.label}
            </button>
          )}
          {cta.kind === "disabled" && (
            <div className="mono mt-4 w-full cursor-not-allowed rounded-card bg-raised py-[15px] text-center text-[12px] uppercase tracking-[0.1em] text-dim">
              {cta.label}
            </div>
          )}
          {cta.kind === "mint" && needsApproval && (
            <p className="mt-2 text-center mono text-[11px] text-dim">
              Two wallet confirmations: approve USDC, then mint.
            </p>
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
