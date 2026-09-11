"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { compareMarketVolume, fetchMarketBoard, groupMarkets, marketMid, onlySports, sideLabel, type Market } from "@/lib/writer";
import { tradeUrl } from "@/lib/chain";
import { useMids } from "@/lib/mids";
import { formatVolume, oddsLabel, pct1, until } from "@/lib/format";
import { Ticket, type BuilderLeg } from "./ticket";
import { AppHeader } from "../app-header";

/** Matches ParlayVault.MAX_LEGS (src/ParlayVault.sol:58) and the writer's own
 * bound (writer/src/server.ts:49). Display only - the cap is enforced on-chain
 * and by the writer, not here. */
const MAX_LEGS = 10;

/** A price cell is the control - clicking 61.4 takes that side. It stays a
 * <button> so the keyboard and a screen reader still have a target now that
 * the explicit Add button is gone. */
function PriceCell({
  mid,
  side,
  tone,
  selected,
  label,
  onPick,
  chip = false,
}: {
  mid: number | null;
  /** Short text printed before the price: YES / NO, or the registry's side name. */
  side: string;
  tone: "yes" | "no";
  selected: boolean;
  label: string;
  onPick: () => void;
  /** Bordered, label-left / price-right, at every breakpoint. For a grouped
   * question's outcome grid, where a bare table cell has no column to sit in. */
  chip?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={mid === null}
      aria-pressed={selected}
      aria-label={label}
      className={`mono flex w-full items-baseline rounded-[8px] border border-line px-2 py-1.5 transition-[transform,background-color,border-color,color] active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none ${
        chip ? "min-w-0 justify-between gap-3 px-3 py-2" : "justify-center sm:justify-end sm:rounded-none sm:border-0 sm:py-1"
      } ${selected ? "border-accent bg-accent" : ""}`}
    >
      <span
        title={chip ? side : undefined}
        className={`text-[10px] ${chip ? "min-w-0 flex-1 truncate text-left text-[11px]" : "mr-1.5 shrink-0 uppercase"} ${
          selected ? "text-on-accent/70" : "text-dim"
        }`}
      >
        {side}
      </span>
      <span
        className={`shrink-0 text-[13px] ${
          selected ? "text-on-accent" : tone === "yes" ? "text-yes" : "text-no"
        }`}
      >
        {oddsLabel(mid)}
      </span>
      <span
        className={`ml-2 shrink-0 text-[10px] ${selected ? "text-on-accent/70" : "text-dim"}`}
      >
        {mid === null ? "-" : pct1(mid)}
      </span>
    </button>
  );
}

/** The venue's own asset icon - crypto perps live at coins/SYM.svg, xyz-dex
 * assets (equities, commodities, indices) at coins/xyz:SYM.svg. Unknown
 * symbols come back 200 with Hyperliquid's generic coin mark, so the letter
 * badge only covers a missing underlying or a network failure. */
function AssetIcon({ underlying, category, badge }: { underlying?: string; category: string; badge?: string }) {
  const [failed, setFailed] = useState(false);
  // Sports have no venue icon - the badge is the sport ("BA" for baseball).
  if (!underlying || failed || category === "sports")
    return (
      <span className="mono flex h-5 w-5 items-center justify-center rounded-full border border-line text-[8px] uppercase text-dim">
        {(badge ?? underlying ?? "?").slice(0, 2)}
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
  // or a screen reader never hears it - the price IS the control.
  const yes = marketMid(mids, market, market.coinYes);
  const no = marketMid(mids, market, market.coinNo);
  return (
    <div
      className={`border-t border-line px-4 py-3 sm:grid sm:grid-cols-[1fr_124px_124px_84px_76px] sm:items-center sm:gap-x-3 sm:px-5 ${
        current ? "bg-accent/[0.07]" : ""
      }`}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="shrink-0">
          <AssetIcon underlying={market.underlying} category={market.category} badge={market.sport} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13px]">
            <MarketLink coin={market.coinYes}>{market.title}</MarketLink>
          </p>
          <p className="mono mt-0.5 text-[10px] uppercase tracking-[0.14em] text-dim">
            {categoryLine(market)}
            <span className="sm:hidden">
              {" · "}
              {formatVolume(market.volume24h)}
              {" · "}
              {closesIn(market)}
            </span>
          </p>
        </div>
      </div>
      {/* Mobile: two half-width buttons under the title; sm+: `contents`
          dissolves the wrapper so the cells land in the outer 4-col grid. */}
      <div className="mt-2 grid grid-cols-2 gap-2 sm:contents">
        <PriceCell
          mid={yes}
          side={sideLabel(market, true)}
          tone="yes"
          selected={current?.isYes === true}
          label={`Take ${sideLabel(market, true)} on ${market.title} at ${yes === null ? "no price" : pct1(yes)}`}
          onPick={() => onPick(market, true)}
        />
        <PriceCell
          mid={no}
          side={sideLabel(market, false)}
          tone="no"
          selected={current?.isYes === false}
          label={`Take ${sideLabel(market, false)} on ${market.title} at ${no === null ? "no price" : pct1(no)}`}
          onPick={() => onPick(market, false)}
        />
      </div>
      <span className="mono hidden text-right text-[12px] text-dim sm:block">
        {formatVolume(market.volume24h)}
      </span>
      <span className="mono hidden text-right text-[12px] text-dim sm:block">
        {closesIn(market)}
      </span>
    </div>
  );
}

/** "Baseball · MLB · by txya" for sports, the bare category otherwise. The
 * deployer tail is the only hint on the board of whose market a leg is. */
function categoryLine(market: Market): string {
  const by = market.deployer ? `by ${market.deployer}` : undefined;
  if (market.category !== "sports") return [market.category, by].filter(Boolean).join(" · ");
  return [market.sport ?? market.category, market.cluster, by].filter(Boolean).join(" · ");
}

/** Title as a deep link to the leg's live Core book, new tab. */
function MarketLink({ coin, children }: { coin: string; children: ReactNode }) {
  return (
    <a
      href={tradeUrl(coin)}
      target="_blank"
      rel="noreferrer"
      className="underline decoration-line underline-offset-4 transition-colors hover:decoration-dim"
    >
      {children}
    </a>
  );
}

/** Quoting locks at the resolution deadline; in-play markets stay on the board. */
function closesIn(market: Market): string {
  return market.expiryMs ? until(market.expiryMs) : "-";
}

/** One HIP-4 question (A / Draw / B, tournament winner): one card, one button
 * per outcome, YES side only - a sportsbook card, not a Yes/No grid. The NO
 * side of a grouped outcome is the sum of the others and stays off the board.
 * The writer refuses two legs from one question (`same-game`), so picking a
 * second outcome swaps the first. */
function GroupRow({
  title,
  members,
  mids,
  legs,
  onPick,
}: {
  title: string;
  members: Market[];
  mids: Record<string, string>;
  legs: BuilderLeg[];
  onPick: (market: Market, isYes: boolean) => void;
}) {
  const current = legs.find((l) => members.some((m) => m.vault === l.vault));
  const head = members[0];
  // Favourite first, unpriced last: the eye lands on the short-priced outcome.
  const priced = members
    .map((m) => ({ m, mid: marketMid(mids, m, m.coinYes) }))
    .sort((a, b) => (b.mid ?? -1) - (a.mid ?? -1));
  const volume = members.reduce((acc, m) => acc + (m.volume24h ?? 0), 0);
  return (
    <div className={`border-t border-line px-4 py-3 sm:px-5 ${current ? "bg-accent/[0.07]" : ""}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="shrink-0">
            <AssetIcon underlying={head.underlying} category={head.category} badge={head.sport} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px]">
              <MarketLink coin={head.coinYes}>{title}</MarketLink>
            </p>
            <p className="mono mt-0.5 text-[10px] uppercase tracking-[0.14em] text-dim">
              {categoryLine(head)}
              {" · "}
              {members.length} outcomes
              {" · "}
              {formatVolume(volume)}
              {" · "}
              {closesIn(head)}
            </p>
          </div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {priced.map(({ m, mid }) => (
          <PriceCell
            key={m.vault}
            chip
            mid={mid}
            side={m.title}
            tone="yes"
            selected={current?.vault === m.vault}
            label={`Take ${m.title} in ${title} at ${mid === null ? "no price" : pct1(mid)}`}
            onPick={() => onPick(m, true)}
          />
        ))}
      </div>
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

function legFor(market: Market, isYes: boolean): BuilderLeg {
  return {
    vault: market.vault,
    isYes,
    // Grouped leg: the outcome is the label, the question is the title.
    title: market.group ? (market.groupTitle ?? market.group) : market.title,
    coin: isYes ? market.coinYes : market.coinNo,
    label: market.group ? market.title : sideLabel(market, isYes),
    group: market.group,
  };
}

export default function BuildPage() {
  const [markets, setMarkets] = useState<Market[] | null>(null);
  const [error, setError] = useState(false);
  const [legs, setLegs] = useState<BuilderLeg[]>([]);
  const [tab, setTab] = useState("all");
  const [sort, setSort] = useState<"volume" | "expiry">("volume");
  const [volumeAsc, setVolumeAsc] = useState(false);
  const [expiryAsc, setExpiryAsc] = useState(true);
  const mids = useMids();

  const load = useCallback(async () => {
    setError(false);
    setMarkets(null);
    try {
      const board = onlySports(await fetchMarketBoard());
      setMarkets(board);
      // Landing-page rail hands off a market as ?leg=<vault>; pick its YES side.
      const picked = new URLSearchParams(window.location.search).get("leg")?.toLowerCase();
      const market = picked && board.find((m) => m.vault.toLowerCase() === picked);
      // Not addLeg: that toggles, and StrictMode runs this effect twice in dev.
      if (market) setLegs((prev) => (prev.some((l) => l.vault === market.vault) ? prev : [...prev, legFor(market, true)]));
    } catch {
      setError(true);
    }
  }, []);

  const tabs = useMemo(
    () => ["all", ...new Set((markets ?? []).map((m) => m.category))],
    [markets],
  );
  const board = useMemo(() => {
    const filtered = (markets ?? [])
      .filter((m) => tab === "all" || m.category === tab)
      // Expired-but-not-yet-rotated markets are dead weight on the board -
      // filter them out client-side rather than let a stale price look pickable.
      // Games past kickoff stay: the writer quotes in-play until expiry.
      .filter((m) => (m.expiryMs ?? Infinity) >= Date.now());
    if (sort === "volume") return filtered.sort((a, b) => compareMarketVolume(a, b, volumeAsc));
    // Markets without an expiry sink to the bottom in either direction.
    return filtered.sort((a, b) => {
      if (a.expiryMs === undefined) return b.expiryMs === undefined ? 0 : 1;
      if (b.expiryMs === undefined) return -1;
      return (a.expiryMs - b.expiryMs) * (expiryAsc ? 1 : -1);
    });
  }, [markets, tab, sort, volumeAsc, expiryAsc]);

  useEffect(() => {
    void load();
  }, [load]);

  function addLeg(market: Market, isYes: boolean) {
    setLegs((prev) => {
      // One leg per question: the writer refuses two (`same-game`), so a second
      // outcome from the same group replaces the first instead of stacking.
      const rest = prev.filter((l) => l.vault !== market.vault && !(market.group && l.group === market.group));
      // Clicking the already-selected side toggles the leg off; the other side swaps it.
      if (prev.some((l) => l.vault === market.vault && l.isYes === isYes)) return rest;
      return [...rest, legFor(market, isYes)];
    });
  }

  function removeLeg(vault: `0x${string}`) {
    setLegs((prev) => prev.filter((l) => l.vault !== vault));
  }

  return (
    <div className="min-h-screen text-[13px] text-fg">
      <AppHeader />

      <main className="mx-auto grid max-w-[1280px] gap-8 px-4 py-8 pb-24 sm:px-6 sm:py-10 lg:grid-cols-[1fr_400px] lg:gap-0 lg:pb-10">
        <section className="lg:border-r lg:border-line lg:pr-8">
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="display text-[32px] [font-variation-settings:'wght'_700] tracking-[-0.03em]">
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
              <div className="overflow-hidden rounded-[12px] border border-line bg-panel/30">
                <div className="mono flex justify-between gap-x-3 bg-panel px-4 py-3 text-[9px] uppercase tracking-[0.16em] text-dim sm:grid sm:grid-cols-[1fr_124px_124px_84px_76px] sm:px-5">
                  <span>Market</span>
                  <span className="col-span-2 hidden pr-2 text-right sm:block">Sides</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (sort === "volume") setVolumeAsc((v) => !v);
                      else {
                        setSort("volume");
                        setVolumeAsc(false);
                      }
                    }}
                    aria-label={`Sort by 24 hour volume, ${sort === "volume" && volumeAsc ? "lowest" : "highest"} first`}
                    className="hidden text-right uppercase tracking-[0.16em] transition-colors hover:text-fg sm:block"
                  >
                    24h vol {sort === "volume" ? (volumeAsc ? "↑" : "↓") : ""}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (sort === "expiry") setExpiryAsc((v) => !v);
                      else {
                        setSort("expiry");
                        setExpiryAsc(true);
                      }
                    }}
                    aria-label={`Sort by expiry, ${sort === "expiry" && expiryAsc ? "soonest" : "latest"} first`}
                    className="text-right uppercase tracking-[0.16em] transition-colors hover:text-fg"
                  >
                    Expires {sort === "expiry" ? (expiryAsc ? "↑" : "↓") : ""}
                  </button>
                </div>
                {groupMarkets(board).map((entry) =>
                  entry.kind === "market" ? (
                    <BoardRow key={entry.market.vault} market={entry.market} mids={mids} legs={legs} onPick={addLeg} />
                  ) : (
                    <GroupRow key={entry.group} title={entry.title} members={entry.members} mids={mids} legs={legs} onPick={addLeg} />
                  ),
                )}
              </div>
            )}
          </div>
        </section>

        <aside id="slip" className="scroll-mt-20 lg:sticky lg:top-24 lg:self-start lg:pl-8">
          <Ticket legs={legs} onRemove={removeLeg} />
        </aside>
      </main>

      {/* Mobile: the slip lives below the whole board - this bar keeps the
          picked legs one tap away instead of a long scroll. */}
      {legs.length > 0 && (
        <button
          type="button"
          onClick={() => document.getElementById("slip")?.scrollIntoView({ block: "start" })}
          className="mono fixed inset-x-4 bottom-4 z-20 flex items-center justify-between rounded-card bg-accent px-5 py-3 text-[12px] font-medium text-on-accent shadow-[0_12px_32px_rgba(4,10,12,0.5)] lg:hidden"
        >
          <span>View slip</span>
          <span>
            {legs.length} {legs.length === 1 ? "leg" : "legs"}
          </span>
        </button>
      )}
    </div>
  );
}
