import { ViewTransition } from "react";
import Link from "next/link";

export function HyperflipMark({ className = "", animated = false }: { className?: string; animated?: boolean }) {
  return (
    <svg
      viewBox="0 0 96 96"
      className={`${animated ? "hyperflip-mark-animated" : ""} ${className}`}
      aria-hidden
      focusable="false"
    >
      <circle cx="48" cy="48" r="44" fill="var(--color-accent)" />
      <circle cx="48" cy="48" r="40.5" fill="none" stroke="var(--color-ink)" strokeWidth="1.5" />
      <circle cx="48" cy="48" r="37" fill="var(--color-ink)" />
      <g transform="translate(25 23) scale(.62)">
        <path className="hyperflip-plane-a" fill="var(--color-accent)" d="M5 16 24 5v25l32 17v14L24 45v20L5 76Z" />
        <g className="hyperflip-plane-b" fill="var(--color-fg)">
          <path d="M6.5 41.5 24 51v14Z" />
          <path d="m56 16 13-7v60l-13 7Z" />
        </g>
      </g>
    </svg>
  );
}

export function HyperflipBrand({ animated = false, shared = false }: { animated?: boolean; shared?: boolean }) {
  const mark = <HyperflipMark className="size-6" animated={animated} />;
  return (
    <Link href="/" className="flex shrink-0 items-center gap-2.5" aria-label="Hyperflip home">
      {shared ? (
        <ViewTransition name="hyperflip-mark" share="hyperflip-mark" default="none">{mark}</ViewTransition>
      ) : mark}
      <span className="display text-[19px] tracking-[-0.045em]">hyperflip</span>
    </Link>
  );
}
