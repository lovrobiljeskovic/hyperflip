import { ViewTransition } from "react";
import Link from "next/link";

/* The coin: lime rim with two edge notches, face split green/white, and the
   H as two counter-slanted slabs — one white, one ink — bridged by a chevroned
   crossbar. icon.svg and opengraph-image.tsx carry hex copies of the same paths. */
export function HyperflipMark({ className = "", animated = false }: { className?: string; animated?: boolean }) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={`${animated ? "hyperflip-mark-animated" : ""} ${className}`}
      aria-hidden
      focusable="false"
    >
      <defs>
        <mask id="hyperflip-notch">
          <rect width="100" height="100" fill="#fff" />
          <circle cx="1" cy="50" r="6.5" fill="#000" />
          <circle cx="99" cy="50" r="6.5" fill="#000" />
        </mask>
      </defs>
      <g mask="url(#hyperflip-notch)">
        <circle cx="50" cy="50" r="48" fill="var(--color-accent)" stroke="var(--color-ink)" strokeWidth="1.5" />
        <circle cx="50" cy="50" r="44.5" fill="none" stroke="var(--color-ink)" strokeWidth="1.2" />
      </g>
      <path d="M50 9A41 41 0 0 0 50 91Z" fill="var(--color-accent)" stroke="var(--color-ink)" strokeWidth="1.2" />
      <path d="M50 9A41 41 0 0 1 50 91Z" fill="var(--color-fg)" stroke="var(--color-ink)" strokeWidth="1.2" />
      <path className="hyperflip-plane-a" d="M26 30 38 21v58L26 70Z" fill="var(--color-fg)" stroke="var(--color-ink)" strokeWidth="1.4" strokeLinejoin="round" />
      <g className="hyperflip-plane-b" fill="var(--color-ink)">
        <path d="M38 43h24v14H38l5-7Z" />
        <path d="M62 21 74 30v40l-12 9Z" />
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
