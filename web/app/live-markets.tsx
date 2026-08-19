"use client";

import { useEffect, useRef, useState } from "react";
import { fetchMarkets, type Market } from "@/lib/writer";
import { useMids } from "@/lib/mids";
import { impliedPct } from "@/lib/format";
import { Ticket, SideChip, type BuilderLeg } from "./build/ticket";

/* One registry fetch shared by the hero ticket, the stat strip, and the
   board. ponytail: module-level promise cache, cleared on failure so a
   client-side revisit retries. */
let marketsCache: Promise<Market[]> | null = null;
function loadMarkets(): Promise<Market[]> {
  marketsCache ??= fetchMarkets().catch((e) => {
    marketsCache = null;
    throw e;
  });
  return marketsCache;
}

type MarketsState =
  | { status: "loading" }
  | { status: "offline" }
  | { status: "live"; markets: Market[] };

function useMarkets(): MarketsState {
  const [state, setState] = useState<MarketsState>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    loadMarkets()
      .then((markets) => alive && setState({ status: "live", markets }))
      .catch(() => alive && setState({ status: "offline" }));
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

/* --- mid helpers: never fake a number, dash on missing --- */

function midNumber(mids: Record<string, string>, coin: string): number | null {
  const raw = mids[coin];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function oddsLabel(mid: number | null): string {
  return mid === null ? "—" : `${(1 / mid).toFixed(2)}x`;
}

/* Implied-% pill that flashes on mid change: up = yes-green tint,
   down = no-red tint, 400ms decay (globals.css keyframes). */
function MidPill({ side, mid }: { side: "YES" | "NO"; mid: number | null }) {
  const yes = side === "YES";
  const prev = useRef<number | null>(null);
  const [flash, setFlash] = useState<{ dir: "up" | "down"; seq: number } | null>(null);

  useEffect(() => {
    const p = prev.current;
    prev.current = mid;
    if (p !== null && mid !== null && mid !== p) {
      const dir = mid > p ? "up" : "down";
      setFlash((f) => ({ dir, seq: (f?.seq ?? 0) + 1 }));
    }
  }, [mid]);

  return (
    <span
      key={flash?.seq ?? 0}
      className={`w-14 rounded-[4px] border py-1 text-center font-mono text-xs ${
        yes ? "border-yes/50 text-yes" : "border-no/50 text-no"
      } ${flash ? (flash.dir === "up" ? "flash-up" : "flash-down") : ""}`}
    >
      {mid === null ? "—" : impliedPct(mid)}
    </span>
  );
}

function OutcomeRow({
  side,
  mid,
}: {
  side: "YES" | "NO";
  mid: number | null;
}) {
  return (
    <li className="flex items-center gap-3 text-sm">
      <SideChip side={side} />
      <span className="flex-1">{side === "YES" ? "Yes" : "No"}</span>
      <span className="font-mono text-dim">{oddsLabel(mid)}</span>
      <MidPill side={side} mid={mid} />
    </li>
  );
}

function expiryLabel(expiryMs?: number): string | null {
  if (!expiryMs) return null;
  return `expires ${new Date(expiryMs).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })}`;
}

function LiveMarketCard({ market, mids }: { market: Market; mids: Record<string, string> }) {
  const expiry = expiryLabel(market.expiryMs);
  return (
    <article className="flex flex-col rounded-card border border-line bg-panel p-5">
      <h3 className="text-[15px] font-medium">{market.title}</h3>
      <ul className="mt-4 flex flex-1 flex-col gap-3">
        <OutcomeRow side="YES" mid={midNumber(mids, market.coinYes)} />
        <OutcomeRow side="NO" mid={midNumber(mids, market.coinNo)} />
      </ul>
      <p className="mt-5 border-t border-line pt-3 font-mono text-xs text-dim">
        {market.category}
        {expiry ? ` · ${expiry}` : ""}
      </p>
    </article>
  );
}

/* Live board for the #markets section. Loading → static skeleton matching
   the card shape; writer down → quiet offline panel; live → registry cards
   joined with allMids (missing mids render as dashes, never faked). */
export function LiveMarketBoard() {
  const state = useMarkets();
  const mids = useMids();

  if (state.status === "loading") {
    return (
      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="h-44 rounded-card border border-line bg-panel p-5" aria-hidden>
            <div className="h-4 w-2/3 rounded-[4px] bg-raised" />
            <div className="mt-5 h-3 w-full rounded-[4px] bg-raised" />
            <div className="mt-3 h-3 w-full rounded-[4px] bg-raised" />
          </div>
        ))}
      </div>
    );
  }

  if (state.status === "offline") {
    return (
      <div className="mt-10 rounded-card border border-line bg-panel p-8 text-center">
        <p className="font-mono text-sm text-dim">markets feed offline</p>
        <p className="mt-2 text-sm text-dim">
          The registry is unreachable. Live pricing returns when the writer is back.
        </p>
      </div>
    );
  }

  if (state.markets.length === 0) {
    return (
      <div className="mt-10 rounded-card border border-line bg-panel p-8 text-center">
        <p className="font-mono text-sm text-dim">no markets listed yet</p>
      </div>
    );
  }

  return (
    <div className="mt-10 grid gap-4 sm:grid-cols-2">
      {state.markets.map((m) => (
        <LiveMarketCard key={m.vault} market={m} mids={mids} />
      ))}
    </div>
  );
}

/* Hero stat strip: real numbers only. Markets count appears once the
   registry answers; the network label is always true. */
export function HeroStats() {
  const state = useMarkets();
  return (
    <p className="font-mono text-xs text-dim">
      {state.status === "live"
        ? `${state.markets.length} market${state.markets.length === 1 ? "" : "s"} listed · HyperEVM testnet`
        : "HyperEVM testnet"}
    </p>
  );
}

/* Static sample ticket, shown while the registry loads (no layout jump) and
   kept when the writer is offline — labeled example pricing, consistent with
   the worked example in the math section. */
function TicketPreview() {
  const legs = [
    { side: "YES" as const, market: "BTC above 64,000 on Aug 21?", odds: "1.18x" },
    { side: "NO" as const, market: "HYPE above 60 by Friday?", odds: "1.75x" },
    { side: "YES" as const, market: "ETH below 1,850 on Aug 21?", odds: "1.61x" },
  ];
  return (
    <div className="rounded-card border border-line bg-panel p-5 text-[13px] shadow-[0_24px_60px_rgba(4,10,12,0.5)]">
      <div className="flex items-center justify-between">
        <span className="font-medium">Parlay ticket</span>
        <span className="rounded-[4px] border border-line px-1.5 py-0.5 font-mono text-[11px] text-dim">
          testnet
        </span>
      </div>

      <ul className="mt-4 flex flex-col gap-3">
        {legs.map((leg) => (
          <li key={leg.market} className="flex items-center gap-3">
            <SideChip side={leg.side} />
            <span className="flex-1 text-fg">{leg.market}</span>
            <span className="font-mono text-dim">{leg.odds}</span>
          </li>
        ))}
      </ul>

      <div className="mt-5 border-t border-line pt-4 flex flex-col gap-2 font-mono">
        <div className="flex justify-between">
          <span className="text-dim">Stake</span>
          <span>100.00 USDC</span>
        </div>
        <div className="flex justify-between">
          <span className="text-dim">Combined implied</span>
          <span>30.0%</span>
        </div>
        <div className="flex justify-between text-base">
          <span className="text-dim">Max payout</span>
          <span className="text-accent">316.20 USDC</span>
        </div>
      </div>

      <div className="mt-5">
        <div className="h-[3px] overflow-hidden rounded-full bg-raised">
          <div className="ttl-bar h-full bg-accent" />
        </div>
        <p className="mt-2 font-mono text-[11px] text-dim">
          quote refreshes every 30s
        </p>
      </div>

      <div
        className="mt-4 rounded-card bg-accent py-2.5 text-center font-medium text-on-accent"
        aria-hidden
      >
        Mint parlay
      </div>
      <p className="mt-3 text-center font-mono text-[11px] text-dim">
        example pricing
      </p>
    </div>
  );
}

/* Hero asset: the real builder Ticket in display mode, legs from the first
   two registry markets (YES side), live odds via useMids inside Ticket.
   Only swaps in once every leg coin has a live mid: with rotated-off coins
   the display Ticket would compute a fake-looking "100% implied" summary,
   so the honest fallback is the labeled example-pricing preview. */
export function HeroTicket() {
  const state = useMarkets();
  const mids = useMids();
  if (state.status !== "live" || state.markets.length < 2) return <TicketPreview />;
  const legs: BuilderLeg[] = state.markets.slice(0, 2).map((m) => ({
    vault: m.vault,
    isYes: true,
    title: m.title,
    coin: m.coinYes,
  }));
  if (!legs.every((l) => midNumber(mids, l.coin) !== null)) return <TicketPreview />;
  return <Ticket legs={legs} onRemove={() => {}} display />;
}
