"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { erc20Abi } from "viem";
import { useAccount, useBalance, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { fetchLimits, type QuoteResult, type WriterLimits, type WriterQuote } from "@/lib/writer";
import { errorText, formatUsdc, multiplierNum, secondsLeft, shortError } from "@/lib/format";
import { appChain, BRIDGED, coreChain, HL_DRIP } from "@/lib/chain";
import { PARLAY_VAULT } from "@/lib/contracts";
import { useConnectAction, useUsdc, useWalletState } from "@/lib/wallet";
import { MIN_LEGS, tryParseStake, standingAllowance, TicketSession, approveUsdc, mintTicket, quoteMatches, type BuilderLeg } from "@/lib/ticket";

export type MintedSlip = { legs: BuilderLeg[]; premium: bigint; maxPayout: bigint; hash: `0x${string}`; id: string | null };

const QUOTE_DEBOUNCE_MS = 400;
const TTL_SECONDS = 30;
const DRIP_HINT = "Claim testnet USDC at the Hyperliquid drip, then transfer it (and some HYPE for gas) from Core to EVM.";

function shortMintError(err: unknown): string {
  if (errorText(err).includes("exceeds balance")) return "Not enough testnet USDC in your wallet for the stake.";
  return shortError(err);
}

type Cta =
  | { kind: "disabled"; label: string }
  | { kind: "connect"; label: string }
  /** Off-site next step (the faucet) - opens a new tab, with a one-line hint. */
  | { kind: "external"; label: string; href: string; hint: string }
  | { kind: "done"; label: string; href: string }
  | { kind: "switch-chain"; label: string }
  /** Funds live on HyperEVM; the bridge panel moves the USDC shortfall and gas across first. */
  | { kind: "bridge"; usdc: bigint; gas: boolean }
  /** Past every gate: step one approves the stake, step two mints once the allowance covers it. */
  | { kind: "pay"; step: "approve" | "mint"; label: string; enabled: boolean; needsApproval: boolean };

export function useTicket(legs: BuilderLeg[]) {
  const { ready: walletReady, address, isConnected, isLinked, accountId } = useWalletState();
  const connect = useConnectAction();

  const [stake, setStake] = useState("");
  const [storedQuote, setStoredQuote] = useState<{ revision: number; result: QuoteResult } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [ttlLeft, setTtlLeft] = useState(0);
  const [mintState, setMintState] = useState<"idle" | "pending" | "done" | "requoted" | "error">("idle");
  const [mintErrorMsg, setMintErrorMsg] = useState("");
  const [mintErrorDetail, setMintErrorDetail] = useState("");
  const [approving, setApproving] = useState(false);
  const [minted, setMinted] = useState<MintedSlip | null>(null);

  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { chainId } = useAccount();
  const session = useRef(new TicketSession()).current;
  session.select(JSON.stringify([legs.map(l => [l.vault.toLowerCase(), l.isYes]), stake, address?.toLowerCase(), chainId, accountId, isLinked]));
  const revision = session.revision;
  const quoteResult = storedQuote?.revision === revision ? storedQuote.result : null;
  const setQuoteResult = useCallback((result: QuoteResult | null) => {
    if (session.revision === revision) setStoredQuote(result ? { revision, result } : null);
  }, [session, revision]);
  useEffect(() => () => session.invalidate(), [session]);
  const { switchChain } = useSwitchChain();
  const { address: usdcAddr, balance: usdcBalance, error: usdcError } = useUsdc();
  const { data: gas } = useBalance({
    address,
    chainId: appChain.id,
    query: { enabled: !!address, refetchInterval: 15_000 },
  });
  const { data: allowance, isError: allowanceError, refetch: refetchAllowance } = useReadContract({
    address: usdcAddr,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, PARLAY_VAULT] : undefined,
    query: { enabled: !!usdcAddr && !!address },
  });

  const [maxStake, setMaxStake] = useState<bigint | null>(null);
  const [limits, setLimits] = useState<WriterLimits | null>(null);
  const [ttlSeconds, setTtlSeconds] = useState(TTL_SECONDS);
  useEffect(() => {
    void fetchLimits().then((l) => {
      if (!l) return;
      setLimits(l);
      setMaxStake(BigInt(l.maxStake));
      if (l.quoteTtlMs > 0) setTtlSeconds(Math.round(l.quoteTtlMs / 1000));
    });
  }, []);

  const stakeBase = tryParseStake(stake);
  // premium === stake by construction (quoteMatches), so the allowance needed is
  // known before any quote arrives and survives requotes.
  const needsApproval = stakeBase !== null && (allowance === undefined || allowance < stakeBase);
  // Allow one immediate-expiry retry; clock skew must not loop requests.
  const clockSkewRetried = useRef(false);

  const runQuote = useCallback(async () => {
    if (session.minting || session.revision !== revision || chainId !== appChain.id) return;
    if (legs.length < MIN_LEGS || !address || !isLinked) return;
    const base = tryParseStake(stake);
    if (base === null) return;

    setQuoting(true);
    const response = await session.quote({
      taker: address,
      legs: legs.map((l) => ({ vault: l.vault, isYes: l.isYes })),
      stake: base.toString(),
    });
    if (!response) return;
    const res = response.result;
    setQuoting(false);
    setQuoteResult(res);
    // Keep the stale-mint note only when its replacement quote succeeds.
    setMintState((s) => (s === "requoted" && res.ok ? "requoted" : "idle"));
  }, [legs, stake, address, isLinked, chainId, session, revision, setQuoteResult]);

  useEffect(() => {
    setQuoteResult(null);
    setQuoting(false);
    if (!session.minting) setMintState("idle");
    clockSkewRetried.current = false;
    const t = setTimeout(() => void runQuote(), QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [runQuote, session, setQuoteResult]);

  useEffect(() => {
    if (!quoteResult?.ok) {
      setTtlLeft(0);
      return;
    }
    if (mintState === "pending" || mintState === "done") return; // freeze - don't requote under a mint
    let firstTick = true;
    let expired = false;
    const tick = () => {
      if (expired) return;
      const left = secondsLeft(BigInt(quoteResult.quote.deadline), Date.now());
      setTtlLeft(left);
      if (left <= 0) {
        expired = true;
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
  }, [quoteResult, mintState, runQuote, setQuoteResult]);

  const latestQuote = useRef(runQuote);
  latestQuote.current = runQuote;

  async function mintQuoted(q: WriterQuote, sig: `0x${string}`) {
    if (session.minting || session.revision !== revision || !publicClient || !usdcAddr || !address ||
        !isLinked || stakeBase === null || chainId !== appChain.id) return;
    const input = { taker: address, legs: legs.map(l => ({ vault: l.vault, isYes: l.isYes })), stake: stakeBase.toString() };
    if (!quoteMatches(q, input)) return;
    if (!session.beginMint()) return;
    setMintState("pending");
    setMintErrorMsg("");
    setMintErrorDetail("");
    let retryQuote = false;
    // mintTicket may swap in a refreshed quote before sending; the slip shows the terms that landed.
    let signed = q;
    try {
      const done = await mintTicket({ client: publicClient, write: writeContractAsync, usdc: usdcAddr,
        quote: q, sig, input, current: () => session.revision === revision,
        onQuote: (r) => { if (r.ok) signed = r.quote; setQuoteResult(r); } });
      if (session.revision === revision) setMintState(done ? "done" : "idle");
      if (done) void refetchAllowance();
      if (done) setMinted({ legs, premium: BigInt(signed.premium), maxPayout: BigInt(signed.maxPayout), hash: done.hash, id: done.id });
    } catch (err) {
      if (session.revision !== revision) return;
      const msg = errorText(err);
      if (msg.includes("LEG_SETTLED") || msg.includes("QUOTE_EXPIRED")) {
        retryQuote = true;
        setMintState("requoted");
      } else {
        setMintErrorMsg(shortMintError(err));
        setMintErrorDetail(msg);
        setMintState("error");
      }
    } finally {
      session.minting = false;
      if (session.revision !== revision) { setMintState("idle"); retryQuote = true; }
      if (retryQuote) void latestQuote.current();
    }
  }

  async function approve() {
    if (approving || session.minting || session.revision !== revision || !publicClient || !usdcAddr || !address || stakeBase === null) return;
    setApproving(true);
    setMintErrorMsg("");
    setMintErrorDetail("");
    try {
      await approveUsdc({ client: publicClient, write: writeContractAsync, usdc: usdcAddr, taker: address,
        amount: standingAllowance(stakeBase, maxStake), current: () => true });
    } catch (err) {
      if (session.revision !== revision) return;
      setMintErrorMsg(shortMintError(err));
      setMintErrorDetail(errorText(err));
      setMintState("error");
    } finally {
      setApproving(false);
      await refetchAllowance();
    }
  }

  function computeCta(): Cta {
    if (legs.length < MIN_LEGS) return { kind: "disabled", label: legs.length === 1 ? "Add 1 more leg to price a ticket" : "Add 2 legs to price a ticket" };
    if (!walletReady) return { kind: "disabled", label: "Checking wallet…" };
    if (!isConnected) return { kind: "connect", label: "Connect wallet" };
    if (!isLinked) return { kind: "connect", label: "Verify wallet" };
    // The bridge step moves the wallet to the core chain mid-flow; keep it mounted (and its
    // "sent" status visible) instead of swapping in the switch-chain CTA until funds land.
    const onCore = BRIDGED && chainId === coreChain.id;
    if (chainId !== undefined && chainId !== appChain.id && !onCore)
      return { kind: "switch-chain", label: `Switch to ${appChain.name}` };
    if (BRIDGED) {
      const gasOut = gas !== undefined && gas.value === 0n;
      const short = stakeBase !== null && usdcBalance !== undefined ? stakeBase - usdcBalance : 0n;
      if (gasOut || usdcBalance === 0n || short > 0n) return { kind: "bridge", usdc: short > 0n ? short : 0n, gas: gasOut };
    }
    if (onCore) return { kind: "switch-chain", label: `Switch to ${appChain.name}` };
    if (usdcBalance === 0n) return { kind: "external", label: "Get testnet USDC →", href: HL_DRIP, hint: DRIP_HINT };
    if (gas !== undefined && gas.value === 0n)
      return { kind: "external", label: "Get HYPE for gas →", href: HL_DRIP, hint: DRIP_HINT };
    if (stakeBase === null) return { kind: "disabled", label: "Enter a stake to quote" };
    // approve() needs the token address and mint needs a real allowance read; never offer
    // "Approve" while either is unknown, or the click is a silent no-op.
    if (!usdcAddr || allowance === undefined)
      return { kind: "disabled", label: usdcError || allowanceError ? "RPC unavailable - try again later" : "Checking wallet…" };
    if (usdcBalance !== undefined && stakeBase > usdcBalance)
      return { kind: "disabled", label: `Insufficient USDC - ${formatUsdc(usdcBalance)} available` };
    if (mintState === "done") return { kind: "done", label: "Minted · view positions", href: "/positions" };
    const minting = session.minting || mintState === "pending";
    if (needsApproval) {
      return { kind: "pay", step: "approve", needsApproval: true, enabled: !approving && !minting,
        label: approving ? "Confirm in wallet…" : "Approve USDC once" };
    }
    const waiting =
      minting ? "Confirm in wallet…"
      : quoting ? "Quoting…"
      : !quoteResult ? "Waiting for quote…"
      : !quoteResult.ok ? "Unable to quote"
      : secondsLeft(BigInt(quoteResult.quote.deadline), Date.now()) <= 0 ? "Refreshing quote…"
      : null;
    if (waiting || !quoteResult?.ok) return { kind: "pay", step: "mint", needsApproval: false, enabled: false, label: waiting ?? "Waiting for quote…" };
    return { kind: "pay", step: "mint", needsApproval: false, enabled: true, label: `Mint ticket · $${formatUsdc(BigInt(quoteResult.quote.premium))}` };
  }
  const cta = computeCta();
  function retry() {
    setMintState("idle");
    clockSkewRetried.current = false;
    void runQuote();
  }
  const dismissMinted = useCallback(() => setMinted(null), []);
  return { stake, setStake, quoteResult, ttlLeft, ttlSeconds, mintState, mintErrorMsg, mintErrorDetail,
    maxStake, limits, usdcBalance, cta, approve, mintQuoted, retry, connect, switchChain, address, minted, dismissMinted,
    stakeBase,
    toWin: quoteResult?.ok ? BigInt(quoteResult.quote.maxPayout) : null,
    multiplier: quoteResult?.ok ? multiplierNum(BigInt(quoteResult.quote.premium), BigInt(quoteResult.quote.maxPayout)) : null };

}
