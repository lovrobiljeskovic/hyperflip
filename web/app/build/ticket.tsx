"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { erc20Abi, parseUnits } from "viem";
import { usePrivy } from "@privy-io/react-auth";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { requestQuote, type QuoteResult, type WriterQuote } from "@/lib/writer";
import { useMids } from "@/lib/mids";
import { formatUsdc, impliedPct, multiplier, secondsLeft, USDC_DECIMALS } from "@/lib/format";
import { PARLAY_VAULT, parlayVaultAbi } from "@/lib/contracts";

export interface BuilderLeg {
  vault: `0x${string}`;
  isYes: boolean;
  title: string;
  coin: string;
}

const MIN_LEGS = 2;
const QUOTE_DEBOUNCE_MS = 400;
const TTL_SECONDS = 30;

// @privy-io/wagmi's WagmiProvider only mounts when NEXT_PUBLIC_PRIVY_APP_ID is
// set (see app/providers.tsx); usePrivy() throws without a PrivyProvider
// ancestor. PRIVY_ENABLED is a build-time constant (inlined by Next.js), so
// it never changes across a running instance's renders — safe to branch a
// hook call on it.
const PRIVY_ENABLED = !!process.env.NEXT_PUBLIC_PRIVY_APP_ID;

function useOptionalLogin(): () => void {
  if (PRIVY_ENABLED) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const { login } = usePrivy();
    return login;
  }
  return () => {};
}

export function SideChip({ side }: { side: "YES" | "NO" }) {
  const yes = side === "YES";
  return (
    <span
      className={`inline-flex w-10 justify-center rounded-[4px] border px-1 py-0.5 font-mono text-[11px] uppercase ${
        yes ? "border-yes/50 text-yes" : "border-no/50 text-no"
      }`}
    >
      {side}
    </span>
  );
}

function midPct(mids: Record<string, string>, coin: string): string {
  const raw = mids[coin];
  if (raw === undefined) return "—";
  const n = Number(raw);
  return Number.isFinite(n) ? impliedPct(n) : "—";
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
  const firstLine = raw.split("\n")[0] ?? raw;
  return firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine;
}

/** Writer error → ticket-facing message. Falls back to the writer's reason
 * verbatim (e.g. stake-too-big) rather than pre-validating client-side. */
function errorMessage(res: Extract<QuoteResult, { ok: false }>): string {
  if (res.status === 0 || res.status === 503) return "Writer unreachable — retrying.";
  if (res.status === 403) return "Invite code rejected — check it on the landing page.";
  if (res.status === 409) {
    return res.error === "leg-settled"
      ? "A leg just settled — remove it and requote."
      : "House is at capacity for this combination.";
  }
  if (res.status === 400 && res.error === "same-underlying") return "Two legs share an underlying — remove one.";
  return res.error;
}

type Cta =
  | { kind: "disabled"; label: string }
  | { kind: "connect"; label: string }
  | { kind: "link"; label: string; href: string }
  | { kind: "done"; label: string; href: string }
  | { kind: "mint"; label: string };

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
  const { address, isConnected } = useAccount();
  const login = useOptionalLogin();

  const [stake, setStake] = useState("");
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [quoteResult, setQuoteResult] = useState<QuoteResult | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [ttlLeft, setTtlLeft] = useState(0);
  const [mintState, setMintState] = useState<"idle" | "pending" | "done" | "requoted" | "error">("idle");
  const [mintErrorMsg, setMintErrorMsg] = useState("");

  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { data: usdcAddr } = useReadContract({
    address: PARLAY_VAULT,
    abi: parlayVaultAbi,
    functionName: "usdc",
    query: { enabled: !display },
  });

  useEffect(() => {
    if (display) return;
    setInviteCode(localStorage.getItem("inviteCode"));
  }, [display]);

  const stakeBase = tryParseStake(stake);
  const requestSeq = useRef(0);

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
    const t = setTimeout(() => void runQuote(), QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legs, stake, address, inviteCode, display]);

  // TTL countdown against the live quote's deadline; drop + auto-requote at 0.
  useEffect(() => {
    if (display || !quoteResult?.ok) {
      setTtlLeft(0);
      return;
    }
    const tick = () => {
      const left = secondsLeft(BigInt(quoteResult.quote.deadline), Date.now());
      setTtlLeft(left);
      if (left <= 0) {
        setQuoteResult(null);
        void runQuote();
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [display, quoteResult, runQuote]);

  async function mintQuoted(q: WriterQuote, sig: `0x${string}`) {
    setMintState("pending");
    setMintErrorMsg("");
    try {
      if (!publicClient || !usdcAddr) throw new Error("client not ready");
      const premium = BigInt(q.premium);
      const allowance = await publicClient.readContract({
        address: usdcAddr,
        abi: erc20Abi,
        functionName: "allowance",
        args: [q.taker, PARLAY_VAULT],
      });
      if (allowance < premium) {
        const h = await writeContractAsync({
          address: usdcAddr,
          abi: erc20Abi,
          functionName: "approve",
          args: [PARLAY_VAULT, premium],
        });
        await publicClient.waitForTransactionReceipt({ hash: h });
      }
      const hash = await writeContractAsync({
        address: PARLAY_VAULT,
        abi: parlayVaultAbi,
        functionName: "mint",
        args: [
          {
            taker: q.taker,
            legs: q.legs,
            premium,
            maxPayout: BigInt(q.maxPayout),
            deadline: BigInt(q.deadline),
            quoteId: q.quoteId,
          },
          sig,
        ],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setMintState("done");
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (msg.includes("LEG_SETTLED") || msg.includes("QUOTE_EXPIRED")) {
        void runQuote(); // stale quote — auto-requote (spec §4)
        setMintState("requoted");
      } else {
        setMintErrorMsg(shortMintError(err));
        setMintState("error");
      }
    }
  }

  function computeCta(): Cta {
    if (legs.length < MIN_LEGS) return { kind: "disabled", label: "Add 2 legs to price a ticket" };
    if (!isConnected) return { kind: "connect", label: "Connect wallet" };
    if (!inviteCode) return { kind: "link", label: "Enter invite code", href: "/#access" };
    if (stakeBase === null) return { kind: "disabled", label: "Enter a stake to quote" };
    if (mintState === "pending") return { kind: "disabled", label: "Confirm in wallet…" };
    if (mintState === "done") return { kind: "done", label: "Minted — view positions", href: "/positions" };
    if (quoting) return { kind: "disabled", label: "Quoting…" };
    if (!quoteResult) return { kind: "disabled", label: "Waiting for quote…" };
    if (!quoteResult.ok) return { kind: "disabled", label: "Unable to quote" };
    return { kind: "mint", label: `Mint parlay — ${formatUsdc(BigInt(quoteResult.quote.premium))} USDC` };
  }
  const cta = display ? null : computeCta();

  // display-mode sample math: fair combined odds off live mids, no house edge.
  const combinedImplied = legs.length
    ? legs.reduce((acc, l) => {
        const raw = mids[l.coin];
        const n = raw === undefined ? NaN : Number(raw);
        return acc * (Number.isFinite(n) ? n : 1);
      }, 1)
    : 0;
  const sampleMultiplier = combinedImplied > 0 ? 1 / combinedImplied : 0;
  const samplePayout = 100 * sampleMultiplier;

  return (
    <div className="rounded-card border border-line bg-panel p-5 text-[13px] shadow-[0_24px_60px_rgba(4,10,12,0.5)]">
      <div className="flex items-center justify-between">
        <span className="font-medium">Parlay ticket</span>
        <span className="rounded-[4px] border border-line px-1.5 py-0.5 font-mono text-[11px] text-dim">
          {display ? "preview" : "testnet"}
        </span>
      </div>

      {legs.length === 0 ? (
        <p className="mt-4 text-dim">No legs yet — add YES or NO from the market list.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {legs.map((leg) => (
            <li key={leg.vault} className="flex items-center gap-3">
              <SideChip side={leg.isYes ? "YES" : "NO"} />
              <span className="flex-1 text-fg">{leg.title}</span>
              <span className="font-mono text-dim">{midPct(mids, leg.coin)}</span>
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
        <div className="mt-5 border-t border-line pt-4 flex flex-col gap-2 font-mono">
          <div className="flex justify-between">
            <span className="text-dim">Stake</span>
            <span>100.00 USDC</span>
          </div>
          <div className="flex justify-between">
            <span className="text-dim">Combined implied</span>
            <span>{impliedPct(combinedImplied)}</span>
          </div>
          <div className="flex justify-between text-base">
            <span className="text-dim">Max payout</span>
            <span className="text-accent">{samplePayout.toFixed(2)} USDC</span>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-4">
            <label htmlFor="stake" className="text-xs text-dim">
              Stake (USDC)
            </label>
            <input
              id="stake"
              inputMode="decimal"
              autoComplete="off"
              value={stake}
              onChange={(e) => setStake(e.target.value)}
              placeholder="0.00"
              className="mt-1 w-full rounded-card border border-line bg-panel px-3 py-2 font-mono text-sm text-fg placeholder:text-dim focus:outline-none focus:border-accent"
            />
          </div>

          {quoteResult?.ok && (
            <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4 font-mono">
              <div className="flex justify-between">
                <span className="text-dim">Premium</span>
                <span>{formatUsdc(BigInt(quoteResult.quote.premium))} USDC</span>
              </div>
              <div className="flex justify-between">
                <span className="text-dim">Multiplier</span>
                <span>{multiplier(BigInt(quoteResult.quote.premium), BigInt(quoteResult.quote.maxPayout))}</span>
              </div>
              <div className="flex justify-between text-base">
                <span className="text-dim">Max payout</span>
                <span className="text-accent">{formatUsdc(BigInt(quoteResult.quote.maxPayout))} USDC</span>
              </div>
            </div>
          )}

          {quoteResult?.ok && (
            <div className="mt-5">
              <div className="h-[3px] overflow-hidden rounded-full bg-raised">
                <div
                  className="h-full bg-accent transition-[width] duration-200"
                  style={{ width: `${Math.max(0, Math.min(100, (ttlLeft / TTL_SECONDS) * 100))}%` }}
                />
              </div>
              <p className="mt-2 font-mono text-[11px] text-dim">{ttlLeft}s until requote</p>
            </div>
          )}

          {quoteResult && !quoteResult.ok && (
            <div className="mt-4 rounded-[4px] border border-no/30 bg-no/5 p-3">
              <p className="text-no">{errorMessage(quoteResult)}</p>
              {errorMessage(quoteResult) !== quoteResult.error && (
                <p className="mt-1 font-mono text-[11px] text-no/70">{quoteResult.error}</p>
              )}
              {(quoteResult.status === 0 || quoteResult.status === 503) && (
                <button
                  type="button"
                  onClick={() => {
                    setMintState("idle"); // user action — clear any stale requoted/error note
                    void runQuote();
                  }}
                  className="mt-2 rounded-[4px] border border-line px-2 py-1 font-mono text-[11px] text-dim transition-colors hover:text-fg"
                >
                  Retry
                </button>
              )}
              {quoteResult.status === 403 && (
                <a
                  href="/#access"
                  className="mt-2 inline-block font-mono text-[11px] text-dim underline underline-offset-4 transition-colors hover:text-fg"
                >
                  Update invite code
                </a>
              )}
            </div>
          )}
        </>
      )}

      {display && (
        <div className="mt-5">
          <div className="h-[3px] overflow-hidden rounded-full bg-raised">
            <div className="ttl-bar h-full bg-accent" />
          </div>
          <p className="mt-2 font-mono text-[11px] text-dim">quote refreshes every 30s</p>
        </div>
      )}

      {display ? (
        <div className="mt-4 rounded-card bg-accent py-2.5 text-center font-medium text-on-accent" aria-hidden>
          Mint parlay — 100.00 USDC
        </div>
      ) : cta ? (
        <>
          {cta.kind === "connect" && (
            <button
              type="button"
              onClick={() => login()}
              className="mt-4 w-full rounded-card bg-accent py-2.5 text-center font-medium text-on-accent transition-transform active:scale-[0.98] hover:opacity-90"
            >
              {cta.label}
            </button>
          )}
          {(cta.kind === "link" || cta.kind === "done") && (
            <a
              href={cta.href}
              className={`mt-4 block w-full rounded-card py-2.5 text-center font-medium transition-transform active:scale-[0.98] hover:opacity-90 ${
                cta.kind === "done" ? "bg-yes text-on-accent" : "bg-accent text-on-accent"
              }`}
            >
              {cta.label}
            </a>
          )}
          {cta.kind === "mint" && (
            <button
              type="button"
              onClick={() => quoteResult?.ok && mintQuoted(quoteResult.quote, quoteResult.sig)}
              className="mt-4 w-full rounded-card bg-accent py-2.5 text-center font-medium text-on-accent transition-transform active:scale-[0.98] hover:opacity-90"
            >
              {cta.label}
            </button>
          )}
          {cta.kind === "disabled" && (
            <div className="mt-4 w-full cursor-not-allowed rounded-card bg-raised py-2.5 text-center font-medium text-dim">
              {cta.label}
            </div>
          )}
          {mintState === "requoted" && (
            <p className="mt-3 text-center font-mono text-[11px] text-accent">Quote refreshed — mint again</p>
          )}
          {mintState === "error" && mintErrorMsg && (
            <p className="mt-3 text-center text-xs text-no">{mintErrorMsg}</p>
          )}
        </>
      ) : null}
    </div>
  );
}
