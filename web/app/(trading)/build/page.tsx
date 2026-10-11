"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { compareKickoff, fetchMarketBoard, groupMarkets, isPriced, marketMid, onlySports, sideLabel, sportLabel, type Market } from "@/lib/writer";
import { tradeUrl } from "@/lib/chain";
import { useMids } from "@/lib/mids";
import { formatOdds, useOddsFormat } from "@/lib/odds-format";
import { OddsFormatToggle } from "@/app/odds-format-toggle";
import { useIsDesktop } from "@/lib/media";
import { loadSlip, restorableBoard, restoreLegs, saveSlip } from "@/lib/slip-storage";
import { Kickoff } from "@/app/live";
import { Ticket, type BuilderLeg } from "./ticket";
import { useTicket } from "./use-ticket";
import { SlipSheet } from "./slip-sheet";
import { MintedSlipDialog } from "./minted-slip";

/** A price cell is the control - clicking a price takes that side. It stays a
 * <button> so the keyboard and a screen reader still have a target. */
function PriceCell({ mid, side, tone, selected, label, onPick }: { mid: number | null; side: string; tone: "yes" | "no"; selected: boolean; label: string; onPick: () => void }) {
  const format = useOddsFormat();
  return (
    <button type="button" onClick={onPick} disabled={mid === null} aria-pressed={selected} aria-label={label}
      className={`flex min-w-0 flex-col items-center gap-0.5 rounded-[8px] border px-2 py-2 transition-[transform,background-color,border-color] active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none ${
        selected ? "border-accent bg-accent" : "border-line bg-panel hover:border-dim"}`}>
      <span title={side} className={`w-full truncate text-center text-[11px] ${selected ? "text-on-accent/70" : "text-dim"}`}>{side}</span>
      <span className={`mono text-[14px] font-medium ${selected ? "text-on-accent" : tone === "yes" ? "text-yes" : "text-no"}`}>{formatOdds(mid, format)}</span>
    </button>
  );
}

/** American football: Tabler's `ball-american-football` (MIT), inlined - the
 * installed lucide set has no football. No league or team marks - those are
 * licensed. Other sports keep the two-letter badge. */
function SportBadge({ market }: { market: Pick<Market, "sport" | "category"> }) {
  if (sportLabel(market) === "Football") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="text-dim">
        <path d="M15 9l-6 6M10 12l2 2M12 10l2 2M8 21a5 5 0 0 0-5-5M16 3c-7.18 0-13 5.82-13 13a5 5 0 0 0 5 5c7.18 0 13-5.82 13-13a5 5 0 0 0-5-5M16 3a5 5 0 0 0 5 5" />
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
  const cells = (
    <>
      <PriceCell
        mid={yes}
        side={sideLabel(market, true)}
        tone="yes"
        selected={current?.isYes === true}
        label={`Take ${sideLabel(market, true)} on ${market.title} at ${yes === null ? "no price" : formatOdds(yes, "probability")}`}
        onPick={() => onPick(market, true)}
      />
      <PriceCell
        mid={no}
        side={sideLabel(market, false)}
        tone="no"
        selected={current?.isYes === false}
        label={`Take ${sideLabel(market, false)} on ${market.title} at ${no === null ? "no price" : formatOdds(no, "probability")}`}
        onPick={() => onPick(market, false)}
      />
    </>
  );
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
      <div className="mt-auto grid gap-2 pt-3" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>{cells}</div>
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
  return (
    <div className={`flex flex-col rounded-[12px] border border-line p-4 ${current ? "bg-accent/[0.07]" : "bg-panel/30"}`}>
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
      <div className={`mt-auto grid gap-2 pt-3 ${priced.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
        {priced.map(({ m, mid }) => (
          <PriceCell
            key={m.vault}
            mid={mid}
            side={m.title}
            tone="yes"
            selected={current?.vault === m.vault}
            label={`Take ${m.title} in ${title} at ${mid === null ? "no price" : formatOdds(mid, "probability")}`}
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
  const ticket = useTicket(legs);
  const isDesktop = useIsDesktop();
  // Persist legs; restore once the board is known so a stale vault never renders.
  const restored = useRef(false);
  useEffect(() => { if (restored.current) saveSlip(legs); }, [legs]);
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
  }, [isDesktop]);
  const [tab, setTab] = useState("all");
  const [soonestFirst, setSoonestFirst] = useState(true);
  const mids = useMids();

  const load = useCallback(async () => {
    setError(false);
    setMarkets(null);
    try {
      const board = onlySports(await fetchMarketBoard());
      setMarkets(board);
      if (!restored.current) {
        restored.current = true;
        const saved = restoreLegs(loadSlip(), restorableBoard(board), legFor);
        if (saved.length) setLegs((prev) => (prev.length ? prev : saved));
      }
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

      <main className="mx-auto grid max-w-[1280px] gap-8 px-4 py-8 pb-28 sm:px-6 sm:pt-10 lg:grid-cols-[1fr_400px] lg:gap-0 lg:pb-10">
        <section className="lg:border-r lg:border-line lg:pr-8">
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="display text-[32px] [font-variation-settings:'wght'_700] tracking-[-0.03em]">Build a slip</h1>
            <button type="button" onClick={() => setSoonestFirst((v) => !v)} aria-label={`Sort by kickoff, ${soonestFirst ? "soonest" : "latest"} first`}
              className="mono text-[10px] uppercase tracking-[0.16em] text-dim transition-colors hover:text-fg">Kickoff {soonestFirst ? "↑" : "↓"}</button>
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
            <div className="mono flex flex-wrap gap-1 text-[10px] uppercase tracking-[0.16em]">
              {tabs.length > 2 && tabs.map((t) => (
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
            <OddsFormatToggle className="hidden lg:inline-flex" />
          </div>

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
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {groupMarkets(board).map((entry) =>
                  entry.kind === "market"
                    ? <BoardRow key={entry.market.vault} market={entry.market} mids={mids} legs={legs} onPick={addLeg} />
                    : <GroupRow key={entry.group} title={entry.title} members={entry.members} mids={mids} legs={legs} onPick={addLeg} />,
                )}
              </div>
            )}
          </div>
        </section>

        {isDesktop ? (
          <aside ref={slipRef} id="slip" className="scroll-mt-20 lg:sticky lg:top-24 lg:self-start lg:pl-8">
            <Ticket legs={legs} onRemove={removeLeg} ticket={ticket} />
          </aside>
        ) : (
          <SlipSheet legs={legs} ticket={ticket} onClear={() => setLegs([])}>
            <Ticket legs={legs} onRemove={removeLeg} ticket={ticket} compact />
          </SlipSheet>
        )}
      </main>

      <MintedSlipDialog slip={ticket.minted} onClose={() => { ticket.dismissMinted(); setLegs([]); }} />
    </div>
  );
}
