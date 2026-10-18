"use client";

import { useEffect, useRef, useState } from "react";
import { until, whenLabel } from "@/lib/format";
import { isMatchQuestion, kickoffKey } from "@/lib/writer";

function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function CountUp({
  value,
  format,
  className,
  durationMs = 600,
}: {
  value: number;
  format: (n: number) => string;
  className?: string;
  durationMs?: number;
}) {
  const [shown, setShown] = useState(0);
  const current = useRef(0);
  useEffect(() => {
    const start = current.current;
    if (start === value || reducedMotion() || !Number.isFinite(value)) {
      current.current = value;
      setShown(value);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / durationMs);
      const v = start + (value - start) * (1 - (1 - k) ** 3);
      current.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs]);
  return <span className={className}>{format(shown)}</span>;
}

/** The server renders UTC-ish text the client replaces at once, hence suppressHydrationWarning. */
export function Kickoff({ market, align = "right" }: { market: { startMs?: number; expiryMs?: number; group?: string }; align?: "left" | "right" }) {
  const now = useNow();
  // A grouped season or tournament: its start is long gone and "live" for months
  // says nothing, so it counts down to settlement instead. A grouped match
  // (3-way soccer) is a game: kickoff, then live.
  const futures = market.group !== undefined && !isMatchQuestion(market);
  const at = kickoffKey(market);
  if (!at) return <span className="text-dim">-</span>;
  const live = !futures && market.startMs !== undefined && now >= market.startMs;
  return (
    <span className={`mono inline-flex flex-col whitespace-nowrap leading-tight ${align === "right" ? "items-end text-right" : "items-start text-left"}`}>
      <time dateTime={new Date(at).toISOString()} suppressHydrationWarning className="text-[12px] text-fg">
        {whenLabel(at)}
      </time>
      <span className="text-[10px] uppercase tracking-[0.12em]" suppressHydrationWarning>
        {futures ? (
          <span className="text-dim">settles in {until(at, now)}</span>
        ) : live ? (
          <span className="text-yes">
            <span aria-hidden className="live-dot mr-1 inline-block h-1.5 w-1.5 rounded-full bg-yes align-middle" />
            Live
          </span>
        ) : (
          <span className="text-dim">in {until(at, now)}</span>
        )}
      </span>
    </span>
  );
}
