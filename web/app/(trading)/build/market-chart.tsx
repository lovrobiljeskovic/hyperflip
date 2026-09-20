"use client";

import { useEffect, useState } from "react";
import { EMPTY_BOOK, fetchBook, fetchCloses, type Book, type Point, type Range } from "@/lib/candles";
import { pct1 } from "@/lib/format";
import { sideLabel, type Market } from "@/lib/writer";

const RANGES: Range[] = ["1D", "ALL"];
/* Drawing space. The svg stretches to the row (preserveAspectRatio none) and
   every stroke is non-scaling, so 2px stays 2px at any width. Text lives in
   HTML around the svg so nothing gets stretched. */
const W = 600;
const H = 120;
const BOOK_POLL_MS = 5000;

function stamp(t: number): string {
  return new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Close price over time plus the live Core book for one side of a market,
 * 0-100% axis. Expanded under a board row; owns its side and range toggles
 * and its fetches. Each HIP-4 side is its own coin with its own book, so the
 * side toggle swaps both chart and book. */
export function MarketChart({ market, title }: { market: Market; title?: string }) {
  const [isYes, setIsYes] = useState(true);
  const coin = isYes ? market.coinYes : market.coinNo;
  const [range, setRange] = useState<Range>("1D");
  const [book, setBook] = useState<Book>(EMPTY_BOOK);
  const [points, setPoints] = useState<Point[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const b = await fetchBook(coin);
      if (!live) return;
      setBook(b);
      timer = setTimeout(poll, BOOK_POLL_MS);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [coin]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    void fetchCloses(coin, range).then((p) => {
      if (!live) return;
      setPoints(p);
      setLoading(false);
      setHover(null);
    });
    return () => {
      live = false;
    };
  }, [coin, range]);

  /* Time-scaled x: candles only exist for periods with trades, so spacing by
     index would squash a month-long gap into one step. Step line: the price
     holds at the last trade until the next one; a slope between them lies. */
  const t0 = points?.[0]?.t ?? 0;
  const span = points?.length ? Math.max(1, points[points.length - 1].t - t0) : 1;
  const xs = points?.map((p) => ((p.t - t0) / span) * W) ?? [];
  const ys = points?.map((p) => H - p.c * H) ?? [];
  const path =
    xs
      .map((x, i) => (i === 0 ? `M${x.toFixed(1)},${ys[0].toFixed(1)}` : `H${x.toFixed(1)} V${ys[i].toFixed(1)}`))
      .join(" ") + (xs.length ? ` H${W}` : "");
  const last = points?.at(-1);
  const focus = hover !== null && points ? points[hover] : null;

  return (
    <div className="mt-3 rounded-[8px] border border-line bg-panel p-3">
      <div className="mono flex flex-wrap items-center justify-between gap-2 text-[10px] uppercase tracking-[0.14em] text-dim">
        <span className="truncate">
          {title ? `${title} · ` : ""}
          {focus ? (
            <>
              <span className="text-fg">{pct1(focus.c)}</span> {stamp(focus.t)}
            </>
          ) : last ? (
            <>
              <span className="text-fg">{pct1(last.c)}</span> last trade
            </>
          ) : (
            "price"
          )}
        </span>
        <span className="flex gap-1" role="group" aria-label="Side">
          {[true, false].map((yes) => (
            <button
              key={String(yes)}
              type="button"
              aria-pressed={isYes === yes}
              onClick={() => setIsYes(yes)}
              className={`max-w-24 truncate rounded-[4px] border px-2 py-0.5 transition-colors ${
                isYes === yes ? `border-accent bg-accent/10 ${yes ? "text-yes" : "text-no"}` : "border-line text-dim hover:border-dim hover:text-fg"
              }`}
            >
              {sideLabel(market, yes)}
            </button>
          ))}
        </span>
        <span className="flex gap-1" role="group" aria-label="Chart range">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              onClick={() => setRange(r)}
              className={`rounded-[4px] border px-2 py-0.5 transition-colors ${
                range === r ? "border-accent bg-accent/10 text-fg" : "border-line text-dim hover:border-dim hover:text-fg"
              }`}
            >
              {r}
            </button>
          ))}
        </span>
      </div>

      {points !== null && points.length === 0 ? (
        <p className="mono py-8 text-center text-[11px] text-dim">{loading ? "Loading…" : range === "1D" ? "No trades in the last 24h." : "No trades yet."}</p>
      ) : (
        <div className={`mt-2 flex gap-2 transition-opacity ${loading ? "opacity-50" : ""}`}>
          <div className="mono flex flex-col justify-between py-[1px] text-right text-[9px] leading-none text-dim">
            <span>100%</span>
            <span>50%</span>
            <span>0%</span>
          </div>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="h-32 w-full touch-none"
            role="img"
            aria-label={last ? `Yes price ${pct1(last.c)} at last trade, ${points?.length ?? 0} points` : "Loading price history"}
            onPointerMove={(e) => {
              if (!points?.length) return;
              const r = e.currentTarget.getBoundingClientRect();
              const x = ((e.clientX - r.left) / r.width) * W;
              let best = 0;
              for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i;
              setHover(best);
            }}
            onPointerLeave={() => setHover(null)}
          >
            {[0, H / 2, H].map((y) => (
              <line key={y} x1={0} x2={W} y1={y} y2={y} stroke="var(--color-line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
            {path && (
              <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            )}
            {hover !== null && (
              <line x1={xs[hover]} x2={xs[hover]} y1={0} y2={H} stroke="var(--color-dim)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            )}
          </svg>
        </div>
      )}
      {points && points.length > 0 && (
        <div className="mono ml-8 mt-1 flex justify-between text-[9px] text-dim">
          <span>{stamp(points[0].t)}</span>
          <span>{stamp(points[points.length - 1].t)}</span>
        </div>
      )}
      <BookView book={book} />
    </div>
  );
}

function sz(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/** Top five levels a side, best at the top, spread between. Sizes are
 * outcome shares (one share pays 1 USDC on the right answer). */
function BookView({ book }: { book: Book }) {
  const bid = book.bids[0]?.px;
  const ask = book.asks[0]?.px;
  const rows = Math.max(book.bids.length, book.asks.length);
  if (rows === 0) return <p className="mono mt-3 border-t border-line pt-3 text-center text-[10px] uppercase tracking-[0.14em] text-dim">Empty book</p>;
  return (
    <div className="mono mt-3 border-t border-line pt-2 text-[10px]">
      <div className="flex justify-between uppercase tracking-[0.14em] text-dim">
        <span>Bids</span>
        <span>
          Spread{" "}
          <span className="text-fg">{bid !== undefined && ask !== undefined ? pct1(ask - bid) : "—"}</span>
        </span>
        <span>Asks</span>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-x-4">
        <ol>
          {book.bids.map((l) => (
            <li key={l.px} className="flex justify-between">
              <span className="text-yes">{pct1(l.px)}</span>
              <span className="text-dim">{sz(l.sz)}</span>
            </li>
          ))}
        </ol>
        <ol>
          {book.asks.map((l) => (
            <li key={l.px} className="flex justify-between">
              <span className="text-dim">{sz(l.sz)}</span>
              <span className="text-no">{pct1(l.px)}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
