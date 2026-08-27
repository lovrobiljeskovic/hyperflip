"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { erc20Abi, formatUnits, parseUnits } from "viem";
import { useAccount, useBalance, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { fetchLimits, joinWaitlist, requestQuote, WAITLIST_ERRORS, type QuoteResult, type WriterQuote } from "@/lib/writer";
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
  secondsLeft,
  USDC_DECIMALS,
  type PriceBreakdown,
} from "@/lib/format";
import { HL_DRIP, hyperEvmTestnet } from "@/lib/chain";
import { PARLAY_VAULT, parlayVaultAbi } from "@/lib/contracts";
import { useConnectAction, useUsdc, useWalletState } from "@/lib/wallet";
import { Overround } from "../overround-motif";

export interface BuilderLeg {
  vault: `0x${string}`;
  isYes: boolean;
  title: string;
  coin: string;
}

const MIN_LEGS = 2;
const QUOTE_DEBOUNCE_MS = 400;
/** Fallback quote lifetime until /limits answers with the writer's real one. */
const TTL_SECONDS = 30;
// Percent-of-cap stake chips — resolved against the writer's maxStake, or
// treated as plain USDC amounts when /limits is unreachable.
const STAKE_PRESETS = [25, 50, 100];

function midPct(mids: Record<string, string>, coin: string): string {
  const raw = mids[coin];
  if (raw === undefined) return "—";
  const n = Number(raw);
  // Only a value strictly inside (0, 1) is a probability — the same domain
  // priceBreakdown() enforces. allMids carries every coin on the venue.
  return Number.isFinite(n) && n > 0 && n < 1 ? impliedPct(n) : "—";
}

function tryParseStake(v: string): bigint | null {
  if (!v.trim()) return null;
  try {
    const n = parseUnits(v, USDC_DECIMALS);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

/** Short, user-facing line for a thrown mint error (wallet rejection, RPC, revert). */
function shortMintError(err: unknown): string {
  const raw = String((err as Error)?.message ?? err);
  if (raw.includes("exceeds balance")) return "Not enough testnet USDC in your wallet for the stake.";
  const firstLine = raw.split("\n")[0] ?? raw;
  return firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine;
}

/** Writer error → ticket-facing message. Falls back to the writer's reason
 * verbatim (e.g. stake-too-big) rather than pre-validating client-side. */
function errorMessage(res: Extract<QuoteResult, { ok: false }>, legs: BuilderLeg[] = []): string {
  if (res.status === 400 && res.error === "dominated") {
    // res.vault names the leg whose lone Core trade already out-pays the whole
    // ticket — the other legs move together with it so tightly they add risk
    // without adding payout.
    const keep = legs.find((l) => l.vault.toLowerCase() === res.vault?.toLowerCase());
    return keep
      ? `These legs move together so tightly the combo pays less than "${keep.title}" alone — drop the other legs or mix in something less correlated.`
      : "These legs move together so tightly the combo pays less than one leg alone — drop a leg or mix in something less correlated.";
  }
  if (res.error === "clock-skew") return "Quote expired immediately — check your clock.";
  // stale-book is a writer refusal (no trustworthy price for a leg right now),
  // not an outage — "unreachable" sends people to check their connection.
  if (res.error === "stale-book") return "No live price for one of these markets right now — try again shortly.";
  if (res.status === 0 || res.status === 503) return "Writer unreachable — retrying.";
  if (res.status === 429) return "Too many quotes too fast — pausing a moment.";
  if (res.status === 403) return "Invite code rejected — enter a valid one below.";
  if (res.status === 409) {
    if (res.error === "leg-settled") return "A leg just settled — remove it and requote.";
    // quota-cap is the invite code's own reservation quota, not a stake problem —
    // shrinking the stake does not help, unlike the market-cap/cluster-cap case below.
    if (res.error === "quota-cap")
      return "This invite code has hit its open-ticket quota — wait ~a minute for reservations to clear or use another code.";
    // market-cap/cluster-cap are stake-driven, not congestion: a long-shot ticket
    // asks for a payout bigger than the house caps for those markets. Saying
    // "at capacity" sends the taker away from a ticket that fits at a lower stake.
    const fit = res.maxStake === undefined ? 0n : BigInt(res.maxStake);
    if (fit > 0n) return `Payout too large for the house limit — stake up to ${formatUsdc(fit)} USDC on this ticket.`;
    if (res.error === "at-capacity") return "House bankroll is fully committed — try again shortly.";
    return "Payout too large for the house limit on one of these markets.";
  }
  if (res.status === 400 && res.error === "cannot-win")
    return "These legs contradict each other — this ticket can never win.";
  if (res.status === 400 && res.error === "ticket-too-complex")
    return "Too many correlated legs to price — drop one.";
  return res.error;
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

/** How the multiplier was built: per-leg book price, then each deduction the
 * writer applies (writer/src/pricing.ts). The last row is the signed quote's
 * own ratio, so any gap against the arithmetic above is visible rather than
 * hidden — that gap is the contract's minimum-premium cap biting. */
function MathBreakdown({ legs, bd }: { legs: BuilderLeg[]; bd: PriceBreakdown }) {
  const { afterCorrelation, afterEdge, afterLegs, modelled } = edgeSteps(bd);
  const capped = Math.abs(bd.actualMultiplier - modelled) / modelled > 0.005;
  return (
    <div className="flex flex-col gap-1.5">
      {legs.map((leg, i) => (
        <div key={leg.vault} className="flex items-baseline gap-3">
          <span className={leg.isYes ? "text-yes" : "text-no"}>{leg.isYes ? "Y" : "N"}</span>
          <span className="flex-1 truncate text-dim">{leg.title}</span>
          <span className="w-14 text-right">{pct(bd.legProbs[i])}</span>
          <span className="w-14 text-right">{mult(bd.legOdds[i])}</span>
        </div>
      ))}
      <div className="mt-1 border-t border-line pt-1.5" />
      <DetailRow label="Fair combined odds">{mult(bd.fairMultiplier)}</DetailRow>
      {Math.abs(afterCorrelation - bd.fairMultiplier) > 0.005 && (
        <DetailRow
          label="Correlation"
          className={afterCorrelation > bd.fairMultiplier ? "text-yes" : "text-no"}
        >
          {signedMult(afterCorrelation - bd.fairMultiplier)}
        </DetailRow>
      )}
      <DetailRow label={`House edge ${pct(bd.edgePct)}`} className="text-no">
        {signedMult(afterEdge - afterCorrelation)}
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

type Cta =
  | { kind: "disabled"; label: string }
  | { kind: "connect"; label: string }
  /** No saved invite code — the CTA slot renders the inline entry form. */
  | { kind: "invite" }
  /** Off-site next step (the faucet) — opens a new tab, with a one-line hint. */
  | { kind: "external"; label: string; href: string; hint: string }
  | { kind: "done"; label: string; href: string }
  | { kind: "switch-chain"; label: string }
  | { kind: "mint"; label: string };

/** Inline invite entry — save a code, or get one emailed via the waitlist —
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
          placeholder="Invite code — OVR-XXXXXX"
          aria-label="Invite code"
          className={inputClass}
        />
        <button type="submit" className={buttonClass}>
          Save
        </button>
      </form>
      <p className="mono text-[11px] text-dim">Saved — checked on your first quote.</p>
      {waitState === "sent" ? (
        <p className="mono text-[11px] text-yes">Invite sent — check your email, then paste the code above.</p>
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

const DRIP_HINT = "Claim testnet USDC at the Hyperliquid drip, then transfer it (and some HYPE for gas) from Core to EVM.";

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
  const { ready: walletReady, address, isConnected } = useWalletState();
  const connect = useConnectAction();

  const [stake, setStake] = useState("");
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [quoteResult, setQuoteResult] = useState<QuoteResult | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [ttlLeft, setTtlLeft] = useState(0);
  const [mintState, setMintState] = useState<"idle" | "pending" | "done" | "requoted" | "error">("idle");
  const [mintErrorMsg, setMintErrorMsg] = useState("");
  const [mintErrorDetail, setMintErrorDetail] = useState("");

  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const { address: usdcAddr, balance: usdcBalance } = useUsdc();
  // Native HYPE — a wallet without gas fails the mint with a raw RPC error,
  // so catch it in the CTA before the wallet ever opens.
  const { data: gas } = useBalance({
    address,
    query: { enabled: !display && !!address },
  });
  // Drives the "1 tx / 2 tx" route line — the mint flow re-reads allowance
  // itself, so a stale value here only ever mislabels the row, never the tx.
  const { data: allowance } = useReadContract({
    address: usdcAddr,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, PARLAY_VAULT] : undefined,
    query: { enabled: !display && !!usdcAddr && !!address },
  });

  useEffect(() => {
    if (display) return;
    setInviteCode(localStorage.getItem("inviteCode"));
  }, [display]);

  const [maxStake, setMaxStake] = useState<bigint | null>(null);
  // Quote lifetime is the writer's to decide (QUOTE_TTL_MS); hardcoding it here
  // pinned the drain bar at 100% for the first minute of a 90s quote.
  const [ttlSeconds, setTtlSeconds] = useState(TTL_SECONDS);
  useEffect(() => {
    if (display) return;
    void fetchLimits().then((l) => {
      if (!l) return;
      setMaxStake(BigInt(l.maxStake));
      if (l.quoteTtlMs > 0) setTtlSeconds(Math.round(l.quoteTtlMs / 1000));
    });
  }, [display]);

  const stakeBase = tryParseStake(stake);
  const requestSeq = useRef(0);
  // True once we've already auto-requoted a quote that was expired on its very first
  // tick (client clock ahead of the writer) — caps that auto-requote at one shot so a
  // sustained skew can't loop POSTs. Reset on a fresh ticket config and on manual Retry.
  const clockSkewRetried = useRef(false);

  const runQuote = useCallback(async () => {
    if (display) return;
    if (legs.length < MIN_LEGS || !address || !inviteCode) return;
    const base = tryParseStake(stake);
    if (base === null) return;

    const seq = ++requestSeq.current;
    setQuoting(true);
    const res = await requestQuote({
      taker: address,
      legs: legs.map((l) => ({ vault: l.vault, isYes: l.isYes })),
      stake: base.toString(),
      inviteCode,
    });
    if (seq !== requestSeq.current) return; // superseded by a newer request
    setQuoting(false);
    setQuoteResult(res);
    // Preserve "requoted" (set by the LEG_SETTLED/QUOTE_EXPIRED mint retry)
    // so its note stays visible alongside the refreshed CTA — but only when
    // the retry actually succeeded; any other trigger (or a failed retry)
    // clears it.
    setMintState((s) => (s === "requoted" && res.ok ? "requoted" : "idle"));
  }, [display, legs, stake, address, inviteCode]);

  // Debounced (re)quote whenever the ticket's inputs change.
  useEffect(() => {
    if (display) return;
    setQuoteResult(null);
    setMintState("idle"); // user action (leg/stake change) clears any stale note
    clockSkewRetried.current = false;
    const t = setTimeout(() => void runQuote(), QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legs, stake, address, inviteCode, display]);

  // TTL countdown against the live quote's deadline; drop + auto-requote at 0.
  // Suspended while a mint is in flight or just landed: requoting mid-wallet-confirmation
  // is pointless, and requoting right after "done" would wipe the confirmation CTA within
  // TTL_SECONDS. If a freshly-landed quote is already expired on its first tick (client
  // clock ahead of the writer), auto-requote once; if the retry lands pre-expired too,
  // stop looping and surface a manual-retry error instead of hammering the writer.
  useEffect(() => {
    if (display || !quoteResult?.ok) {
      setTtlLeft(0);
      return;
    }
    if (mintState === "pending" || mintState === "done") return; // freeze — don't requote under a mint
    let firstTick = true;
    const tick = () => {
      const left = secondsLeft(BigInt(quoteResult.quote.deadline), Date.now());
      setTtlLeft(left);
      if (left <= 0) {
        if (firstTick && clockSkewRetried.current) {
          setQuoteResult({ ok: false, status: 0, error: "clock-skew" });
          return;
        }
        if (firstTick) clockSkewRetried.current = true;
        setQuoteResult(null);
        void runQuote();
      }
      firstTick = false;
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [display, quoteResult, mintState, runQuote]);

  async function mintQuoted(q: WriterQuote, sig: `0x${string}`) {
    setMintState("pending");
    setMintErrorMsg("");
    setMintErrorDetail("");
    try {
      if (!publicClient || !usdcAddr) throw new Error("client not ready");
      let premium = BigInt(q.premium);
      const [allowance, balance] = await Promise.all([
        publicClient.readContract({
          address: usdcAddr,
          abi: erc20Abi,
          functionName: "allowance",
          args: [q.taker, PARLAY_VAULT],
        }),
        publicClient.readContract({
          address: usdcAddr,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [q.taker],
        }),
      ]);
      // Fail before the approve tx, not after it: a wallet without the premium
      // would otherwise pay approve gas and then revert the mint on-chain.
      if (balance < premium) throw new Error("transfer amount exceeds balance");
      if (allowance < premium) {
        // Exact approval is safe against the post-approve requote below:
        // premium == stake by writer construction (pricing.ts), so the fresh
        // quote's premium is identical and stays covered.
        const h = await writeContractAsync({
          address: usdcAddr,
          abi: erc20Abi,
          functionName: "approve",
          args: [PARLAY_VAULT, premium],
        });
        const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: h });
        if (approveReceipt.status !== "success") throw new Error("approve reverted");
      }
      // The approve (and the wallet confirm before it) may have outlived the
      // quote's TTL. Instead of sending a doomed mint, fetch a fresh quote and
      // mint that in the same flow — same stake means same premium, so the
      // approval still covers it. Buffer of 10s absorbs mining + clock lag.
      if (allowance < premium || secondsLeft(BigInt(q.deadline), Date.now()) < 10) {
        const base = tryParseStake(stake);
        if (!inviteCode || base === null) throw new Error("stake or invite code missing");
        const res = await requestQuote({
          taker: q.taker,
          legs: legs.map((l) => ({ vault: l.vault, isYes: l.isYes })),
          stake: base.toString(),
          inviteCode,
        });
        if (!res.ok) {
          setQuoteResult(res);
          setMintState("idle");
          return;
        }
        setQuoteResult(res);
        q = res.quote;
        sig = res.sig;
        premium = BigInt(q.premium);
      }
      const mintArgs = [
        {
          taker: q.taker,
          legs: q.legs,
          premium,
          maxPayout: BigInt(q.maxPayout),
          deadline: BigInt(q.deadline),
          quoteId: q.quoteId,
        },
        sig,
      ] as const;
      // Simulate first: surfaces the actual revert reason (QUOTE_EXPIRED,
      // exceeds balance, …) before gas is spent — a mined-but-reverted tx
      // resolves without one.
      await publicClient.simulateContract({
        address: PARLAY_VAULT,
        abi: parlayVaultAbi,
        functionName: "mint",
        args: mintArgs,
        account: q.taker,
      });
      const hash = await writeContractAsync({
        address: PARLAY_VAULT,
        abi: parlayVaultAbi,
        functionName: "mint",
        args: mintArgs,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      // Simulation passed but the mined tx reverted — deadline raced the
      // wallet confirmation; treat as stale quote.
      if (receipt.status !== "success") throw new Error("QUOTE_EXPIRED (mint reverted on-chain)");
      setMintState("done");
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (msg.includes("LEG_SETTLED") || msg.includes("QUOTE_EXPIRED")) {
        void runQuote(); // stale quote — auto-requote (spec §4)
        setMintState("requoted");
      } else {
        setMintErrorMsg(shortMintError(err));
        setMintErrorDetail(msg);
        setMintState("error");
      }
    }
  }

  function computeCta(): Cta {
    if (legs.length < MIN_LEGS) return { kind: "disabled", label: "Add 2 legs to price a ticket" };
    if (!walletReady) return { kind: "disabled", label: "Checking wallet…" };
    if (!isConnected) return { kind: "connect", label: "Connect wallet" };
    if (chainId !== undefined && chainId !== hyperEvmTestnet.id)
      return { kind: "switch-chain", label: `Switch to ${hyperEvmTestnet.name}` };
    if (!inviteCode) return { kind: "invite" };
    // Empty wallet is a dead end without a next step — send the tester to the
    // faucet instead of a disabled button.
    if (usdcBalance === 0n)
      return { kind: "external", label: "Get testnet USDC →", href: HL_DRIP, hint: DRIP_HINT };
    if (gas !== undefined && gas.value === 0n)
      return { kind: "external", label: "Get HYPE for gas →", href: HL_DRIP, hint: DRIP_HINT };
    if (stakeBase === null) return { kind: "disabled", label: "Enter a stake to quote" };
    // Checked before the quote is even shown: a stake the wallet can't cover
    // would otherwise reach the approve tx and burn gas on a doomed mint.
    if (usdcBalance !== undefined && stakeBase > usdcBalance)
      return { kind: "disabled", label: `Insufficient USDC — ${formatUsdc(usdcBalance)} available` };
    if (mintState === "pending") return { kind: "disabled", label: "Confirm in wallet…" };
    if (mintState === "done") return { kind: "done", label: "Minted — view positions", href: "/positions" };
    if (quoting) return { kind: "disabled", label: "Quoting…" };
    if (!quoteResult) return { kind: "disabled", label: "Waiting for quote…" };
    if (!quoteResult.ok) return { kind: "disabled", label: "Unable to quote" };
    return { kind: "mint", label: `Mint slip — ${formatUsdc(BigInt(quoteResult.quote.premium))} USDC` };
  }
  const cta = display ? null : computeCta();

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
          quoteResult.breakdown.jointProbWad,
          premium,
          maxPayout,
        )
      : null;
  // The motif's ring splay is the book's margin on the live quote.
  const margin = bd ? quotedOverround(bd) : null;
  // The stake you'd need to win back exactly what you paid — the honest
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
  // Every leg must carry a real probability — treating an unpriced leg as
  // certain would overstate the multiplier, so the figure goes unavailable
  // instead.
  const sampleProbs = legs.map((l) => {
    const raw = mids[l.coin];
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
  });
  const combinedImplied =
    legs.length && sampleProbs.every((p) => p !== null)
      ? (sampleProbs as number[]).reduce((acc, p) => acc * p, 1)
      : 0;
  const sampleMultiplier = combinedImplied > 0 ? 1 / combinedImplied : null;
  const samplePayout = sampleMultiplier === null ? null : 100 * sampleMultiplier;

  return (
    <div
      className={`rounded-card border border-line bg-panel px-7 py-8 text-[13px] shadow-[0_24px_60px_rgba(4,10,12,0.5)] ${printing}`}
    >
      <div className="flex items-start justify-between">
        <span className="mono text-[10px] uppercase tracking-[0.16em] text-dim">Your slip</span>
        <Overround size={44} margin={margin} />
      </div>

      {legs.length === 0 ? (
        <p className="mt-4 text-dim">No legs yet — add YES or NO from the market list.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-px bg-line">
          {legs.map((leg) => (
            <li key={leg.vault} className="print-line flex items-center gap-3 bg-ink px-4 py-[13px]">
              <span className={`mono text-[11px] ${leg.isYes ? "text-yes" : "text-no"}`}>
                {leg.isYes ? "YES" : "NO"}
              </span>
              <span className="flex-1 truncate text-fg">{leg.title}</span>
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
            <span>{combinedImplied > 0 ? impliedPct(combinedImplied) : "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-dim">Fair</span>
            <span className="text-dim">{sampleMultiplier === null ? "—" : mult(sampleMultiplier)}</span>
          </div>
          <div className="mt-3 flex items-end justify-between border-t border-line pt-4">
            <span className="mono text-[10px] uppercase tracking-[0.16em] text-dim">Max payout</span>
            <span className="mono text-[30px] leading-none text-accent">
              {samplePayout === null ? "—" : samplePayout.toFixed(2)}
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
                Balance {usdcBalance === undefined ? "—" : formatUsdc(usdcBalance)}
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
              <p className="mt-1 mono text-[11px] text-dim">
                House limit {formatUsdc(maxStake)} USDC per ticket
              </p>
            )}
          </div>

          {quoteResult?.ok && (
            <div className="print-line mono mt-4 flex flex-col gap-2 border-t border-line pt-4 text-[12px]">
              <DetailRow label="Stake">{formatUsdc(premium)} USDC</DetailRow>
              <DetailRow label="Combined implied">{bd ? pct(1 / bd.fairMultiplier) : "—"}</DetailRow>
              <DetailRow label="Fair" className="text-dim">
                {bd ? mult(bd.fairMultiplier) : "—"}
              </DetailRow>
              <DetailRow label="Quoted" className="text-[20px] leading-none text-accent">
                {multiplier(premium, maxPayout)}
              </DetailRow>
              <div className="mt-3 flex items-end justify-between border-t border-line pt-4">
                <span className="mono text-[10px] uppercase tracking-[0.16em] text-dim">Max payout</span>
                <span className="mono text-[30px] leading-none text-accent">{formatUsdc(maxPayout)}</span>
              </div>

              {/* open by default: the multiplier's derivation is the point of the
                  panel, not a footnote — collapsing it hides the one number a
                  taker most needs to trust. */}
              <details open className="mt-2 rounded-[4px] border border-line bg-raised/40 px-3 py-2">
                <summary className="flex items-center justify-between text-[11px] text-dim">
                  Quote details
                </summary>
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
                    <DetailRow label="Break-even probability">
                      {breakEven === null ? "—" : pct(breakEven)}
                    </DetailRow>
                    <DetailRow label="Max loss" className="text-no">
                      {formatUsdc(premium)} USDC
                    </DetailRow>
                  </div>

                  <div className="flex flex-col gap-1.5 border-t border-line pt-3">
                    <DetailRow label="Price protection">Fixed — signed quote</DetailRow>
                    <DetailRow label="Slippage">None (0%)</DetailRow>
                    <DetailRow label="Route">
                      {needsApproval ? "2 txs · Approve + Mint" : "1 tx · Mint"}
                    </DetailRow>
                    <DetailRow label="Platform fee">0.00 USDC</DetailRow>
                    <DetailRow label="Network">{hyperEvmTestnet.name}</DetailRow>
                    <DetailRow label="Gas token">{hyperEvmTestnet.nativeCurrency.symbol}</DetailRow>
                    <DetailRow label="Quote valid for">{ttlLeft}s</DetailRow>
                  </div>
                </div>
              </details>
            </div>
          )}

          {quoteResult?.ok && (
            <div className="mt-5">
              <div className="h-[3px] overflow-hidden rounded-full bg-raised">
                <div
                  className="h-full bg-accent transition-[width] duration-1000 ease-linear motion-reduce:transition-none"
                  style={{ width: `${Math.max(0, Math.min(100, (ttlLeft / ttlSeconds) * 100))}%` }}
                />
              </div>
              <p className="mono mt-2 text-[11px] text-dim">Quote reprices in {ttlLeft}s</p>
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
                  onClick={() => {
                    setMintState("idle"); // user action — clear any stale requoted/error note
                    clockSkewRetried.current = false;
                    void runQuote();
                  }}
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
        <div className="mono mt-4 rounded-card bg-accent py-[15px] text-center text-[12px] uppercase tracking-[0.1em] text-on-accent" aria-hidden>
          Mint slip — 100.00 USDC
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
            <p className="mt-3 text-center mono text-[11px] text-accent">Quote refreshed — mint again</p>
          )}
          {mintState === "error" && mintErrorMsg && (
            <div className="mt-3">
              <p className="text-center text-xs text-no">{mintErrorMsg}</p>
              {mintErrorDetail && mintErrorDetail !== mintErrorMsg && (
                <details className="mt-2 rounded-[4px] border border-no/30 bg-no/5 p-2">
                  <summary className="cursor-pointer mono text-[11px] text-no/70">
                    Full error
                  </summary>
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
