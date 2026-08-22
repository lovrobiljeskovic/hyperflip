"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchMarkets, type Market } from "@/lib/writer";
import { useMids } from "@/lib/mids";
import { oddsLabel, pct1, until } from "@/lib/format";
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
  side,
  selected,
  label,
  onPick,
}: {
  mid: number | null;
  side: "YES" | "NO";
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
      className={`mono w-full px-2 py-1 text-right transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        selected ? "bg-accent" : ""
      }`}
    >
      <span
        className={`text-[13px] ${
          selected ? "text-on-accent" : side === "YES" ? "text-yes" : "text-no"
        }`}
      >
        {oddsLabel(mid)}
      </span>
      <span
        className={`ml-2 text-[10px] ${selected ? "text-on-accent/70" : "text-dim"}`}
      >
        {mid === null ? "—" : pct1(mid)}
      </span>
    </button>
  );
}

/** The venue's own asset icon — crypto perps live at coins/SYM.svg, xyz-dex
 * assets (equities, commodities, indices) at coins/xyz:SYM.svg. Unknown
 * symbols come back 200 with Hyperliquid's generic coin mark, so the letter
 * badge only covers a missing underlying or a network failure. */
function AssetIcon({ underlying, category }: { underlying?: string; category: string }) {
  const [failed, setFailed] = useState(false);
  if (!underlying || failed)
    return (
      <span className="mono flex h-5 w-5 items-center justify-center rounded-full border border-line text-[8px] text-dim">
        {(underlying ?? "?").slice(0, 2)}
      </span>
    );
  const coin = category === "crypto" ? underlying : `xyz:${underlying}`;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://app.hyperliquid.xyz/coins/${encodeURIComponent(coin)}.svg`}
      alt=""
      width={20}
      height={20}
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-5 w-5 rounded-full"
    />
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
  // aria-label overrides the button's text, so the price has to be spoken here
  // or a screen reader never hears it — the price IS the control.
  const yes = midOf(mids, market.coinYes);
  const no = midOf(mids, market.coinNo);
  return (
    <div
      className={`grid grid-cols-[1fr_110px_110px_90px] items-center gap-x-3 border-t border-line px-5 py-3 ${
        current ? "bg-accent/[0.07]" : ""
      }`}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="shrink-0">
          <AssetIcon underlying={market.underlying} category={market.category} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13px]">{market.title}</p>
          <p className="mono mt-0.5 text-[10px] uppercase tracking-[0.14em] text-dim">
            {market.category}
          </p>
        </div>
      </div>
      <PriceCell
        mid={yes}
        side="YES"
        selected={current?.isYes === true}
        label={`Take YES on ${market.title} at ${yes === null ? "no price" : pct1(yes)}`}
        onPick={() => onPick(market, true)}
      />
      <PriceCell
        mid={no}
        side="NO"
        selected={current?.isYes === false}
        label={`Take NO on ${market.title} at ${no === null ? "no price" : pct1(no)}`}
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
        <div key={i} className="h-11 animate-pulse motion-reduce:animate-none border-t border-line bg-panel first:border-t-0" />
      ))}
    </div>
  );
}

export default function BuildPage() {
  const [markets, setMarkets] = useState<Market[] | null>(null);
  const [error, setError] = useState(false);
  const [legs, setLegs] = useState<BuilderLeg[]>([]);
  const [tab, setTab] = useState("all");
  const [expiryAsc, setExpiryAsc] = useState(true);
  const mids = useMids();

  const load = useCallback(async () => {
    setError(false);
    setMarkets(null);
    try {
      setMarkets(await fetchMarkets());
    } catch {
      setError(true);
    }
  }, []);

  const tabs = useMemo(
    () => ["all", ...new Set((markets ?? []).map((m) => m.category))],
    [markets],
  );
  const board = useMemo(() => {
    const filtered = (markets ?? []).filter((m) => tab === "all" || m.category === tab);
    // Markets without an expiry sink to the bottom in either direction.
    return filtered.sort((a, b) => {
      if (a.expiryMs === undefined) return b.expiryMs === undefined ? 0 : 1;
      if (b.expiryMs === undefined) return -1;
      return (a.expiryMs - b.expiryMs) * (expiryAsc ? 1 : -1);
    });
  }, [markets, tab, expiryAsc]);

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

          {markets !== null && markets.length > 0 && (
            <div className="mono mt-6 flex gap-1 text-[10px] uppercase tracking-[0.16em]">
              {tabs.map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={tab === t}
                  onClick={() => setTab(t)}
                  className={`rounded-[4px] border px-3 py-1.5 transition-colors ${
                    tab === t
                      ? "border-accent bg-accent/10 text-fg"
                      : "border-line text-dim hover:border-dim hover:text-fg"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          )}

          <div className="mt-4">
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
                <div className="mono grid grid-cols-[1fr_110px_110px_90px] gap-x-3 bg-panel px-5 py-3 text-[9px] uppercase tracking-[0.16em] text-dim">
                  <span>Market</span>
                  <span className="pr-2 text-right">Yes</span>
                  <span className="pr-2 text-right">No</span>
                  <button
                    type="button"
                    onClick={() => setExpiryAsc((v) => !v)}
                    aria-label={`Sort by expiry, ${expiryAsc ? "soonest" : "latest"} first`}
                    className="text-right uppercase tracking-[0.16em] transition-colors hover:text-fg"
                  >
                    Expires {expiryAsc ? "↑" : "↓"}
                  </button>
                </div>
                {board.map((m) => (
                  <BoardRow key={m.vault} market={m} mids={mids} legs={legs} onPick={addLeg} />
                ))}
              </div>
            )}
          </div>
        </section>

        <aside className="mt-8 lg:mt-0 lg:sticky lg:top-24 lg:self-start lg:pl-8">
          <Ticket legs={legs} onRemove={removeLeg} />
        </aside>
      </main>
    </div>
  );
}
