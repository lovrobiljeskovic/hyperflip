"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchMarkets, type Market } from "@/lib/writer";
import { useMids } from "@/lib/mids";
import { impliedPct } from "@/lib/format";
import { SideChip, Ticket, type BuilderLeg } from "./ticket";

function midOf(mids: Record<string, string>, coin: string): number | null {
  const raw = mids[coin];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function OutcomeAddRow({
  side,
  mid,
  selected,
  onAdd,
}: {
  side: "YES" | "NO";
  mid: number | null;
  selected: boolean;
  onAdd: () => void;
}) {
  const yes = side === "YES";
  const pct = mid === null ? "—" : impliedPct(mid);
  const odds = mid === null || mid <= 0 ? "—" : `${(1 / mid).toFixed(2)}x`;
  return (
    <div className="flex items-center gap-3 text-sm">
      <SideChip side={side} />
      <span className="flex-1">{yes ? "Yes" : "No"}</span>
      <span className="font-mono text-dim">{pct}</span>
      <span className="font-mono text-dim">{odds}</span>
      <button
        type="button"
        onClick={onAdd}
        className={`rounded-[4px] border px-3 py-1 font-mono text-xs transition-colors ${
          yes
            ? "border-yes/50 text-yes hover:bg-yes/10"
            : "border-no/50 text-no hover:bg-no/10"
        } ${selected ? (yes ? "bg-yes/10" : "bg-no/10") : ""}`}
      >
        {selected ? "Added" : "Add"}
      </button>
    </div>
  );
}

function MarketCard({
  market,
  mids,
  legs,
  onAdd,
}: {
  market: Market;
  mids: Record<string, string>;
  legs: BuilderLeg[];
  onAdd: (market: Market, isYes: boolean) => void;
}) {
  const current = legs.find((l) => l.vault === market.vault);
  return (
    <article className="flex flex-col gap-3 rounded-card border border-line bg-panel p-4">
      <h3 className="text-sm font-medium">{market.title}</h3>
      <div className="flex flex-col gap-2">
        <OutcomeAddRow
          side="YES"
          mid={midOf(mids, market.coinYes)}
          selected={current?.isYes === true}
          onAdd={() => onAdd(market, true)}
        />
        <OutcomeAddRow
          side="NO"
          mid={midOf(mids, market.coinNo)}
          selected={current?.isYes === false}
          onAdd={() => onAdd(market, false)}
        />
      </div>
    </article>
  );
}

function LoadingSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-28 animate-pulse rounded-card border border-line bg-panel" />
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
      <header className="sticky top-0 z-10 border-b border-line bg-ink/95">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <a href="/" className="flex items-center gap-2 font-mono text-sm tracking-tight text-fg">
            <span className="inline-block size-2.5 rounded-[2px] bg-accent" aria-hidden />
            parlay
          </a>
          <nav className="flex items-center gap-6 text-sm">
            <a href="/positions" className="text-dim transition-colors hover:text-fg">
              Positions
            </a>
          </nav>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-8 px-6 py-10 lg:grid-cols-[1.5fr_1fr] lg:items-start">
        <section>
          <h1 className="text-lg font-medium">Markets</h1>
          <p className="mt-1 text-dim">Add a YES or NO leg from any market to build a ticket.</p>

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
              <div className="grid gap-4 sm:grid-cols-2">
                {markets.map((m) => (
                  <MarketCard key={m.vault} market={m} mids={mids} legs={legs} onAdd={addLeg} />
                ))}
              </div>
            )}
          </div>
        </section>

        <aside className="lg:sticky lg:top-24">
          <Ticket legs={legs} onRemove={removeLeg} />
        </aside>
      </main>
    </div>
  );
}
