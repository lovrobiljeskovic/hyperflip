"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { erc20Abi } from "viem";
import { useAccount, useBalance, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { fetchLimits, type QuoteResult, type WriterQuote } from "@/lib/writer";
import { formatUsdc, secondsLeft, shortError } from "@/lib/format";
import { HL_DRIP, hyperEvmTestnet } from "@/lib/chain";
import { PARLAY_VAULT } from "@/lib/contracts";
import { useConnectAction, useUsdc, useWalletState } from "@/lib/wallet";
import { tryParseStake, TicketSession, mintTicket, quoteMatches, type BuilderLeg } from "@/lib/ticket";

const MIN_LEGS = 2;
const QUOTE_DEBOUNCE_MS = 400;
const TTL_SECONDS = 30;
const DRIP_HINT = "Claim testnet USDC at the Hyperliquid drip, then transfer it (and some HYPE for gas) from Core to EVM.";

/** Short, user-facing line for a thrown mint error (wallet rejection, RPC, revert). */
function shortMintError(err: unknown): string {
  const raw = String((err as Error)?.message ?? err);
  if (raw.includes("exceeds balance")) return "Not enough testnet USDC in your wallet for the stake.";
  return shortError(err);
}

type Cta =
  | { kind: "disabled"; label: string }
  | { kind: "connect"; label: string }
  /** No saved invite code - the CTA slot renders the inline entry form. */
  | { kind: "invite" }
  /** Off-site next step (the faucet) - opens a new tab, with a one-line hint. */
  | { kind: "external"; label: string; href: string; hint: string }
  | { kind: "done"; label: string; href: string }
  | { kind: "switch-chain"; label: string }
  | { kind: "mint"; label: string };

export function useTicket(legs: BuilderLeg[], display: boolean) {
  const { ready: walletReady, address, isConnected } = useWalletState();
  const connect = useConnectAction();

  const [stake, setStake] = useState("");
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [storedQuote, setStoredQuote] = useState<{ revision: number; result: QuoteResult } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [ttlLeft, setTtlLeft] = useState(0);
  const [mintState, setMintState] = useState<"idle" | "pending" | "done" | "requoted" | "error">("idle");
  const [mintErrorMsg, setMintErrorMsg] = useState("");
  const [mintErrorDetail, setMintErrorDetail] = useState("");

  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { chainId } = useAccount();
  const session = useRef(new TicketSession()).current;
  session.select(JSON.stringify([legs.map(l => [l.vault.toLowerCase(), l.isYes]), stake, address?.toLowerCase(), chainId, inviteCode, display]));
  const revision = session.revision;
  const quoteResult = storedQuote?.revision === revision ? storedQuote.result : null;
  const setQuoteResult = useCallback((result: QuoteResult | null) => {
    if (session.revision === revision) setStoredQuote(result ? { revision, result } : null);
  }, [session, revision]);
  useEffect(() => () => session.invalidate(), [session]);
  const { switchChain } = useSwitchChain();
  const { address: usdcAddr, balance: usdcBalance } = useUsdc();
  // Check gas before opening the wallet.
  const { data: gas } = useBalance({
    address,
    query: { enabled: !display && !!address },
  });
  // Display only; mint re-reads allowance.
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
  // Use the writer’s lifetime for the countdown bar.
  const [ttlSeconds, setTtlSeconds] = useState(TTL_SECONDS);
  // Relay maker count drives the "best of N" CTA copy; a v1 writer omits it.
  const [makerCount, setMakerCount] = useState(1);
  useEffect(() => {
    if (display) return;
    void fetchLimits().then((l) => {
      if (!l) return;
      setMaxStake(BigInt(l.maxStake));
      if (l.quoteTtlMs > 0) setTtlSeconds(Math.round(l.quoteTtlMs / 1000));
      if (l.makers) setMakerCount(l.makers);
    });
  }, [display]);

  const stakeBase = tryParseStake(stake);
  // Allow one immediate-expiry retry; clock skew must not loop requests.
  const clockSkewRetried = useRef(false);

  const runQuote = useCallback(async () => {
    if (display || session.minting || session.revision !== revision || chainId !== hyperEvmTestnet.id) return;
    if (legs.length < MIN_LEGS || !address || !inviteCode) return;
    const base = tryParseStake(stake);
    if (base === null) return;

    setQuoting(true);
    const response = await session.quote({
      taker: address,
      legs: legs.map((l) => ({ vault: l.vault, isYes: l.isYes })),
      stake: base.toString(),
      inviteCode,
    });
    if (!response) return;
    const res = response.result;
    setQuoting(false);
    setQuoteResult(res);
    // Keep the stale-mint note only when its replacement quote succeeds.
    setMintState((s) => (s === "requoted" && res.ok ? "requoted" : "idle"));
  }, [display, legs, stake, address, inviteCode, chainId, session, revision, setQuoteResult]);

  // Debounced (re)quote whenever the ticket's inputs change.
  useEffect(() => {
    if (display) return;
    setQuoteResult(null);
    setQuoting(false);
    if (!session.minting) setMintState("idle");
    clockSkewRetried.current = false;
    const t = setTimeout(() => void runQuote(), QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [runQuote, display, session, setQuoteResult]);

  // Pause expiry refresh during mint and after success.
  useEffect(() => {
    if (display || !quoteResult?.ok) {
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
  }, [display, quoteResult, mintState, runQuote, setQuoteResult]);

  const latestQuote = useRef(runQuote);
  latestQuote.current = runQuote;

  async function mintQuoted(q: WriterQuote, sig: `0x${string}`) {
    if (session.minting || session.revision !== revision || !publicClient || !usdcAddr || !address ||
        !inviteCode || stakeBase === null || chainId !== hyperEvmTestnet.id) return;
    const input = { taker: address, legs: legs.map(l => ({ vault: l.vault, isYes: l.isYes })), stake: stakeBase.toString(), inviteCode };
    if (!quoteMatches(q, input)) return;
    if (!session.beginMint()) return;
    setMintState("pending");
    setMintErrorMsg("");
    setMintErrorDetail("");
    let retryQuote = false;
    try {
      const done = await mintTicket({ client: publicClient, write: writeContractAsync, usdc: usdcAddr,
        quote: q, sig, input, current: () => session.revision === revision, onQuote: setQuoteResult });
      if (session.revision === revision) setMintState(done ? "done" : "idle");
    } catch (err) {
      if (session.revision !== revision) return;
      const msg = String((err as Error)?.message ?? err);
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

  function computeCta(): Cta {
    if (legs.length < MIN_LEGS) return { kind: "disabled", label: "Add 2 legs to price a ticket" };
    if (!walletReady) return { kind: "disabled", label: "Checking wallet…" };
    if (!isConnected) return { kind: "connect", label: "Connect wallet" };
    if (chainId !== undefined && chainId !== hyperEvmTestnet.id)
      return { kind: "switch-chain", label: `Switch to ${hyperEvmTestnet.name}` };
    if (!inviteCode) return { kind: "invite" };
    if (usdcBalance === 0n) return { kind: "external", label: "Get testnet USDC →", href: HL_DRIP, hint: DRIP_HINT };
    if (gas !== undefined && gas.value === 0n)
      return { kind: "external", label: "Get HYPE for gas →", href: HL_DRIP, hint: DRIP_HINT };
    if (stakeBase === null) return { kind: "disabled", label: "Enter a stake to quote" };
    if (usdcBalance !== undefined && stakeBase > usdcBalance)
      return { kind: "disabled", label: `Insufficient USDC - ${formatUsdc(usdcBalance)} available` };
    if (session.minting || mintState === "pending") return { kind: "disabled", label: "Confirm in wallet…" };
    if (mintState === "done") return { kind: "done", label: "Minted - view positions", href: "/positions" };
    if (quoting) return { kind: "disabled", label: makerCount > 1 ? `Collecting quotes… best of ${makerCount}` : "Quoting…" };
    if (!quoteResult) return { kind: "disabled", label: "Waiting for quote…" };
    if (!quoteResult.ok) return { kind: "disabled", label: "Unable to quote" };
    if (secondsLeft(BigInt(quoteResult.quote.deadline), Date.now()) <= 0) return { kind: "disabled", label: "Refreshing quote…" };
    return { kind: "mint", label: `Mint slip - ${formatUsdc(BigInt(quoteResult.quote.premium))} USDC` };
  }
  const cta = display ? null : computeCta();
  function retry() {
    setMintState("idle");
    clockSkewRetried.current = false;
    void runQuote();
  }
  return { stake, setStake, quoteResult, ttlLeft, ttlSeconds, mintState, mintErrorMsg, mintErrorDetail,
    setInviteCode, maxStake, makerCount, usdcBalance, allowance, cta, mintQuoted, retry, connect, switchChain };

}
