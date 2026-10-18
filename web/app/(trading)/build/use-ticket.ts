"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { erc20Abi } from "viem";
import { useAccount, useBalance, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import type { QuoteResult, WriterQuote } from "@/lib/writer";
import { errorText, multiplierNum, shortError } from "@/lib/format";
import { appChain, BRIDGED } from "@/lib/chain";
import { PARLAY_VAULT } from "@/lib/contracts";
import { useConnectAction, useUsdc, useWalletState } from "@/lib/wallet";
import { useQuoteTtl } from "./use-quote-ttl";
import { useWriterLimits } from "./use-writer-limits";
import { computeCta } from "@/lib/ticket-cta";
import { MIN_LEGS, tryParseStake, standingAllowance, TicketSession, approveUsdc, mintTicket, quoteMatches, type BuilderLeg } from "@/lib/ticket";

export type MintedSlip = { legs: BuilderLeg[]; premium: bigint; maxPayout: bigint; hash: `0x${string}`; id: string | null };

const QUOTE_DEBOUNCE_MS = 400;

function shortMintError(err: unknown): string {
  if (errorText(err).includes("exceeds balance")) return "Not enough testnet USDC in your wallet for the stake.";
  return shortError(err);
}

export function useTicket(legs: BuilderLeg[]) {
  const { ready: walletReady, address, isConnected, isLinked, accountId } = useWalletState();
  const connect = useConnectAction();

  const [stake, setStake] = useState("");
  const [storedQuote, setStoredQuote] = useState<{ revision: number; result: QuoteResult } | null>(null);
  const [quoting, setQuoting] = useState(false);
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

  const { maxStake, limits, ttlSeconds } = useWriterLimits();

  const stakeBase = tryParseStake(stake);
  // Allow one immediate-expiry retry; clock skew must not loop requests.
  const clockSkewRetried = useRef(false);
  // A superseded quote only clears `quoting` when no later runQuote has started; that one owns the flag.
  const quoteSeq = useRef(0);

  const runQuote = useCallback(async () => {
    if (session.minting || session.revision !== revision || chainId !== appChain.id) return;
    if (legs.length < MIN_LEGS || !address || !isLinked) return;
    const base = tryParseStake(stake);
    if (base === null) return;

    const seq = ++quoteSeq.current;
    setQuoting(true);
    const response = await session.quote({
      taker: address,
      legs: legs.map((l) => ({ vault: l.vault, isYes: l.isYes })),
      stake: base.toString(),
    });
    if (!response) {
      if (seq === quoteSeq.current) setQuoting(false);
      return;
    }
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

  const ttlLeft = useQuoteTtl({ quoteResult, mintState, runQuote, setQuoteResult, clockSkewRetried });

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

  const cta = computeCta({ legCount: legs.length, walletReady, isConnected, isLinked, chainId, bridged: BRIDGED,
    gas: gas?.value, usdcBalance, stakeBase, usdcAddr, allowance, rpcError: usdcError || allowanceError, mintState,
    minting: session.minting, approving, quoting, quoteResult, now: Date.now() });
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
