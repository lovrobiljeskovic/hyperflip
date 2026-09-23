"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { compareKickoff, fetchMarketBoard, groupMarkets, isPriced, marketMid, onlySports, sideLabel, sportLabel, type Market } from "@/lib/writer";
import { tradeUrl } from "@/lib/chain";
import { useMids } from "@/lib/mids";
import { oddsLabel, pct1 } from "@/lib/format";
import { Kickoff } from "@/app/live";
import { Ticket, type BuilderLeg } from "./ticket";

type View = "list" | "grid";

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

/** American football: a generic ball, drawn inline. No league or team marks -
 * those are licensed. Other sports keep the two-letter badge. */
function SportBadge({ market }: { market: Pick<Market, "sport" | "category"> }) {
  if (sportLabel(market) === "Football") {
    return (
      <svg aria-hidden="true" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.3" className="text-dim">
        <ellipse cx="10" cy="10" rx="8.5" ry="5.2" transform="rotate(-45 10 10)" />
        <path d="M7 13l6-6M7.6 10.5l1.4 1.4M9.3 8.8l1.4 1.4M11 7.1l1.4 1.4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <span aria-hidden="true" className="mono flex h-5 w-5 items-center justify-center rounded-full border border-line text-[8px] uppercase text-dim">
      {(market.sport ?? "?").slice(0, 2)}
    </span>
  );
}

function BoardRow({
  market,
  mids,
  legs,
  onPick,
  card = false,
}: {
  market: Market;
  mids: Record<string, string>;
  legs: BuilderLeg[];
  onPick: (market: Market, isYes: boolean) => void;
  /** Grid view: a bordered card with the kickoff in the header and the two
   * sides as full-width chips, at every breakpoint. */
  card?: boolean;
}) {
  const current = legs.find((l) => l.vault === market.vault);
  // aria-label overrides the button's text, so the price has to be spoken here
  // or a screen reader never hears it - the price IS the control.
  const yes = marketMid(mids, market, market.coinYes);
  const no = marketMid(mids, market, market.coinNo);
  const cells = (
    <>
      <PriceCell
        chip={card}
        mid={yes}
        side={sideLabel(market, true)}
        tone="yes"
        selected={current?.isYes === true}
        label={`Take ${sideLabel(market, true)} on ${market.title} at ${yes === null ? "no price" : pct1(yes)}`}
        onPick={() => onPick(market, true)}
      />
      <PriceCell
        chip={card}
        mid={no}
        side={sideLabel(market, false)}
        tone="no"
        selected={current?.isYes === false}
        label={`Take ${sideLabel(market, false)} on ${market.title} at ${no === null ? "no price" : pct1(no)}`}
        onPick={() => onPick(market, false)}
      />
    </>
  );
  if (card) {
    return (
      <div className={`flex flex-col rounded-[12px] border border-line p-4 ${current ? "bg-accent/[0.07]" : "bg-panel/30"}`}>
        {/* Kickoff on its own line: beside the title it ate half the card. */}
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="shrink-0">
            <SportBadge market={market} />
          </span>
          <p className="min-w-0 truncate text-[13px]">
            <MarketLink coin={market.coinYes}>{market.title}</MarketLink>
          </p>
        </div>
        <div className="mt-1.5 flex items-end justify-between gap-3">
          <p className="mono text-[10px] uppercase tracking-[0.14em] text-dim">{market.cluster}</p>
          <Kickoff market={market} />
        </div>
        <div className="mt-auto grid grid-cols-1 gap-2 pt-3">{cells}</div>
      </div>
    );
  }
  return (
    <div
      className={`border-t border-line px-4 py-3 sm:grid sm:grid-cols-[1fr_124px_124px_132px] sm:items-center sm:gap-x-3 sm:px-5 ${
        current ? "bg-accent/[0.07]" : ""
      }`}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="shrink-0">
          <SportBadge market={market} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13px]">
            <MarketLink coin={market.coinYes}>{market.title}</MarketLink>
          </p>
          {market.cluster && (
            <p className="mono mt-0.5 text-[10px] uppercase tracking-[0.14em] text-dim">{market.cluster}</p>
          )}
        </div>
        <span className="ml-auto shrink-0 sm:hidden">
          <Kickoff market={market} />
        </span>
      </div>
      {/* Mobile: two half-width buttons under the title; sm+: `contents`
          dissolves the wrapper so the cells land in the outer 4-col grid. */}
      <div className="mt-2 grid grid-cols-2 gap-2 sm:contents">{cells}</div>
      <span className="hidden justify-self-end sm:block">
        <Kickoff market={market} />
      </span>
    </div>
  );
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
  card = false,
}: {
  title: string;
  members: Market[];
  mids: Record<string, string>;
  legs: BuilderLeg[];
  onPick: (market: Market, isYes: boolean) => void;
  /** Grid view: own bordered card, outcomes stacked in one column. */
  card?: boolean;
}) {
  const current = legs.find((l) => members.some((m) => m.vault === l.vault));
  const head = members[0];
  // Favourite first, unpriced last: the eye lands on the short-priced outcome.
  const priced = members
    .map((m) => ({ m, mid: marketMid(mids, m, m.coinYes) }))
    .sort((a, b) => (b.mid ?? -1) - (a.mid ?? -1));
  return (
    <div
      className={
        card
          ? `flex flex-col rounded-[12px] border border-line p-4 ${current ? "bg-accent/[0.07]" : "bg-panel/30"}`
          : `border-t border-line px-4 py-3 sm:px-5 ${current ? "bg-accent/[0.07]" : ""}`
      }
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="shrink-0">
            <SportBadge market={head} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px]">
              <MarketLink coin={head.coinYes}>{title}</MarketLink>
            </p>
            <p className="mono mt-0.5 text-[10px] uppercase tracking-[0.14em] text-dim">
              {[head.cluster, `${members.length} outcomes`].filter(Boolean).join(" · ")}
            </p>
          </div>
        </div>
        <span className="shrink-0">
          <Kickoff market={head} />
        </span>
      </div>
      <div className={`grid grid-cols-1 gap-2 ${card ? "mt-auto pt-3" : "mt-3 sm:grid-cols-2"}`}>
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

/** List / grid switch. Icons are inline: no icon package in this app. */
function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const icons: Record<View, ReactNode> = {
    list: (
      <>
        <rect x="2" y="3" width="12" height="2.5" rx="0.75" />
        <rect x="2" y="8" width="12" height="2.5" rx="0.75" />
        <rect x="2" y="13" width="12" height="2.5" rx="0.75" />
      </>
    ),
    grid: (
      <>
        <rect x="2" y="2" width="5" height="5" rx="1" />
        <rect x="9" y="2" width="5" height="5" rx="1" />
        <rect x="2" y="9" width="5" height="5" rx="1" />
        <rect x="9" y="9" width="5" height="5" rx="1" />
      </>
    ),
  };
  return (
    <div role="group" aria-label="Board layout" className="flex overflow-hidden rounded-[6px] border border-line">
      {(["list", "grid"] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          aria-label={`${v} view`}
          title={`${v[0].toUpperCase()}${v.slice(1)} view`}
          onClick={() => onChange(v)}
          className={`flex h-7 w-8 items-center justify-center transition-colors ${
            view === v ? "bg-accent/10 text-fg" : "text-dim hover:text-fg"
          }`}
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            {icons[v]}
          </svg>
        </button>
      ))}
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
  const slipRef = useRef<HTMLElement>(null);
  // Pin the slip's bottom when it's taller than the viewport: sticky top =
  // min(6rem, viewport - height - 1rem). CSS alone can't read its own height.
  useEffect(() => {
    const el = slipRef.current;
    if (!el) return;
    const fit = () => {
      el.style.top = `${Math.min(96, window.innerHeight - el.offsetHeight - 16)}px`;
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);
  const [tab, setTab] = useState("all");
  const [view, setView] = useState<View>("list");
  const [soonestFirst, setSoonestFirst] = useState(true);
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

  // Only rows that will actually render: unpriced or expired markets are dropped
  // below, so a sport whose every market is dead gets no tab either.
  const live = useMemo(
    () => (markets ?? []).filter((m) => (m.expiryMs ?? Infinity) >= Date.now() && isPriced(mids, m)),
    [markets, mids],
  );
  const tabs = useMemo(() => ["all", ...new Set(live.map(sportLabel))], [live]);
  const board = useMemo(() => {
    // Games past kickoff stay: the writer quotes in-play until expiry.
    return live.filter((m) => tab === "all" || sportLabel(m) === tab).sort((a, b) => compareKickoff(a, b, soonestFirst));
  }, [live, tab, soonestFirst]);

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

      <main className="mx-auto grid max-w-[1280px] gap-8 px-4 py-8 pb-24 sm:px-6 sm:py-10 lg:grid-cols-[1fr_400px] lg:gap-0 lg:pb-10">
        <section className="lg:border-r lg:border-line lg:pr-8">
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="display text-[32px] [font-variation-settings:'wght'_700] tracking-[-0.03em]">
              Build a slip
            </h1>
            <ViewToggle view={view} onChange={setView} />
          </div>

          {tabs.length > 2 && (
            <div className="mono mt-6 flex flex-wrap gap-1 text-[10px] uppercase tracking-[0.16em]">
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
            ) : live.length === 0 ? (
              <p className="rounded-card border border-line bg-panel p-6 text-dim">No quotable markets right now.</p>
            ) : view === "grid" ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {groupMarkets(board).map((entry) =>
                  entry.kind === "market" ? (
                    <BoardRow card key={entry.market.vault} market={entry.market} mids={mids} legs={legs} onPick={addLeg} />
                  ) : (
                    <GroupRow card key={entry.group} title={entry.title} members={entry.members} mids={mids} legs={legs} onPick={addLeg} />
                  ),
                )}
              </div>
            ) : (
              <div className="overflow-hidden rounded-[12px] border border-line bg-panel/30">
                <div className="mono flex justify-between gap-x-3 bg-panel px-4 py-3 text-[9px] uppercase tracking-[0.16em] text-dim sm:grid sm:grid-cols-[1fr_124px_124px_132px] sm:px-5">
                  <span>Market</span>
                  <span className="col-span-2 hidden pr-2 text-right sm:block">Sides</span>
                  <button
                    type="button"
                    onClick={() => setSoonestFirst((v) => !v)}
                    aria-label={`Sort by kickoff, ${soonestFirst ? "soonest" : "latest"} first`}
                    className="text-right uppercase tracking-[0.16em] transition-colors hover:text-fg"
                  >
                    Kickoff {soonestFirst ? "↑" : "↓"}
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

        {/* Sticky slip. When the ticket outgrows the viewport its sticky top
            goes negative so the bottom (CTA) pins instead - scrolling back up
            reveals the top. No inner scroll container. */}
        <aside ref={slipRef} id="slip" className="scroll-mt-20 lg:sticky lg:top-24 lg:self-start lg:pl-8">
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
