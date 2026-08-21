"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchMarkets, type Market } from "@/lib/writer";
import { useMids } from "@/lib/mids";
import { pct1, until } from "@/lib/format";
import { Ticket, type BuilderLeg } from "./ticket";
import { AppHeader } from "../app-header";

/** allMids returns a mid for every coin on the venue, perps included, so a
 * stale, crossed or colliding key can hand back a non-probability. Only
 * (0, 1) is a probability — anything else must degrade to "—" rather than
 * render as e.g. 6400000.0%. Same bound as midNumber in app/live-markets.tsx
 * and priceBreakdown in lib/format.ts. Do not widen it. */
function midOf(mids: Record<string, string>, coin: string): number | null {
  const raw = mids[coin];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
}

/** Matches ParlayVault.MAX_LEGS (src/ParlayVault.sol:58) and the writer's own
 * bound (writer/src/server.ts:49). Display only — the cap is enforced on-chain
 * and by the writer, not here. */
const MAX_LEGS = 10;

/** A price cell is the control — clicking 61.4 takes that side. It stays a
 * <button> so the keyboard and a screen reader still have a target now that
 * the explicit Add button is gone. */
function PriceCell({
  mid,
  selected,
  label,
  onPick,
}: {
  mid: number | null;
  selected: boolean;
  label: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={mid === null}
      aria-pressed={selected}
      aria-label={label}
      className={`mono w-full px-1 py-0.5 text-right text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        selected
          ? "bg-accent text-center text-on-accent"
          : "text-dim hover:text-fg"
      }`}
    >
      {mid === null ? "—" : pct1(mid)}
    </button>
  );
}

function BoardRow({
  market,
  mids,
  legs,
  onPick,
}: {
  market: Market;
  mids: Record<string, string>;
  legs: BuilderLeg[];
  onPick: (market: Market, isYes: boolean) => void;
}) {
  const current = legs.find((l) => l.vault === market.vault);
  return (
    <div
      className={`grid grid-cols-[1fr_96px_96px_90px] items-center gap-x-3 border-t border-line px-5 py-3 ${
        current ? "bg-[rgba(245,160,145,0.07)]" : ""
      }`}
    >
      <span className="truncate text-[13px]">{market.title}</span>
      <PriceCell
        mid={midOf(mids, market.coinYes)}
        selected={current?.isYes === true}
        label={`Take YES on ${market.title}`}
        onPick={() => onPick(market, true)}
      />
      <PriceCell
        mid={midOf(mids, market.coinNo)}
        selected={current?.isYes === false}
        label={`Take NO on ${market.title}`}
        onPick={() => onPick(market, false)}
      />
      <span className="mono text-right text-[12px] text-dim">
        {market.expiryMs ? until(market.expiryMs) : "—"}
      </span>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="border border-line">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-11 animate-pulse border-t border-line bg-panel first:border-t-0" />
      ))}
    </div>
  );
}

export default function BuildPage() {
  const [markets, setMarkets] = useState<Market[] | null>(null);
  const [error, setError] = useState(false);
  const [legs, setLegs] = useState<BuilderLeg[]>([]);
  const mids = useMids();

  const load = useCallback(async () => {
    setError(false);
    setMarkets(null);
    try {
      const m = await fetchMarkets();
      setMarkets(m);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function addLeg(market: Market, isYes: boolean) {
    setLegs((prev) => [
      ...prev.filter((l) => l.vault !== market.vault),
      { vault: market.vault, isYes, title: market.title, coin: isYes ? market.coinYes : market.coinNo },
    ]);
  }

  function removeLeg(vault: `0x${string}`) {
    setLegs((prev) => prev.filter((l) => l.vault !== vault));
  }

  return (
    <div className="min-h-screen text-[13px] text-fg">
      <AppHeader ground="dark" />

      <main className="mx-auto grid max-w-6xl px-6 py-10 lg:grid-cols-[1fr_380px]">
        <section className="lg:border-r lg:border-line lg:pr-8">
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="display text-[26px] [font-variation-settings:'wght'_700] tracking-[-0.03em]">
              Build a slip
            </h1>
            <span className="mono text-[11px] text-dim">
              {legs.length} of {MAX_LEGS} legs
            </span>
          </div>

          <div className="mt-6">
            {error ? (
              <div className="flex flex-col items-start gap-3 rounded-card border border-line bg-panel p-6">
                <p className="text-no">Writer unreachable.</p>
                <button
                  type="button"
                  onClick={() => void load()}
                  className="rounded-card border border-line px-4 py-2 text-sm text-fg transition-colors hover:border-dim"
                >
                  Retry
                </button>
              </div>
            ) : markets === null ? (
              <LoadingSkeleton />
            ) : markets.length === 0 ? (
              <p className="rounded-card border border-line bg-panel p-6 text-dim">No markets listed.</p>
            ) : (
              <div className="border border-line">
                <div className="mono grid grid-cols-[1fr_96px_96px_90px] gap-x-3 bg-panel px-5 py-3 text-[9px] uppercase tracking-[0.16em] text-dim">
                  <span>Market</span>
                  <span className="text-right">Yes</span>
                  <span className="text-right">No</span>
                  <span className="text-right">Expires</span>
                </div>
                {markets.map((m) => (
                  <BoardRow key={m.vault} market={m} mids={mids} legs={legs} onPick={addLeg} />
                ))}
              </div>
            )}
          </div>
        </section>

        <aside className="mt-8 lg:mt-0 lg:sticky lg:top-24 lg:pl-8">
          <Ticket legs={legs} onRemove={removeLeg} />
        </aside>
      </main>
    </div>
  );
}
