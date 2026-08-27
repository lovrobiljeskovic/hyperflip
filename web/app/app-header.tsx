"use client";

import { ViewTransition, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletButton } from "./wallet-button";

/** Candidate A, "sum past one": two overlapping discs with the lens knocked
 * out to the ground. Every fill is a token, so one component serves the paper
 * and dark grounds — which is what lets it be the shared element the Cross
 * transition holds still. */
export function Mark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 132 72" className={className} aria-hidden focusable="false">
      <circle cx="46" cy="36" r="30" fill="var(--mark-1)" />
      <circle cx="86" cy="36" r="30" fill="var(--color-fg)" />
      <path
        d="M66 6.7A30 30 0 0 1 66 65.3A30 30 0 0 1 66 6.7Z"
        fill="var(--ground)"
        opacity="0.88"
      />
    </svg>
  );
}

const PAPER_NAV = [
  { href: "/#board", label: "Board" },
  { href: "/#writing", label: "Writing a slip" },
  { href: "/#book", label: "The book" },
  { href: "/build", label: "Build" },
  { href: "/positions", label: "Positions" },
];

const DARK_NAV = [
  { href: "/build", label: "Build" },
  { href: "/positions", label: "Positions" },
];

/** The one header. `ground` picks the nav set and the chrome; every colour
 * comes from the cascade, so the mark, wordmark and wallet control need no
 * per-ground special-casing. The mark sits at the identical offset on both
 * grounds so the Cross transition has nothing to move. */
export function AppHeader({ ground }: { ground: "paper" | "dark" }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const paper = ground === "paper";
  const nav = paper ? PAPER_NAV : DARK_NAV;
  const linkClass = (active: boolean) =>
    active
      ? "border-b border-accent pb-[3px] text-fg"
      : "text-dim transition-colors hover:text-fg";
  return (
    <header
      className={`sticky top-0 z-30 ${
        paper ? "bg-[var(--stock)]/95" : "border-b border-line bg-ink/95"
      } backdrop-blur`}
    >
      <div className="mx-auto flex h-[60px] max-w-6xl items-center justify-between gap-4 px-4 sm:gap-6 sm:px-6">
        <Link href="/" className="flex items-center gap-[10px]">
          <ViewTransition name="overround-mark">
            <Mark className="h-[15px] w-[26px]" />
          </ViewTransition>
          <span className="display text-[18px] [font-variation-settings:'wght'_700] tracking-[-0.035em]">
            overround
          </span>
        </Link>
        <nav className="mono ml-auto hidden items-center gap-[26px] text-[10px] uppercase tracking-[0.1em] md:flex">
          {nav.map((l) => {
            const active = pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={linkClass(active)}
              >
                {l.label}
              </Link>
            );
          })}
          <span className="normal-case tracking-normal">
            <WalletButton />
          </span>
        </nav>
        <div className="ml-auto flex items-center gap-3 md:hidden">
          <WalletButton />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? "Close menu" : "Open menu"}
            className="flex h-9 w-9 items-center justify-center rounded-card border border-line text-fg"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
              {open ? (
                <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              ) : (
                <path d="M2 4.5h12M2 8h12M2 11.5h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              )}
            </svg>
          </button>
        </div>
      </div>
      {open && (
        <nav
          className={`mono flex flex-col gap-1 border-t border-line px-4 pb-4 pt-2 text-[11px] uppercase tracking-[0.1em] md:hidden ${
            paper ? "bg-[var(--stock)]" : "bg-ink"
          }`}
        >
          {nav.map((l) => {
            const active = pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                onClick={() => setOpen(false)}
                className={`py-2 ${active ? "text-fg" : "text-dim"}`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
      )}
      {paper && <div className="perf" />}
    </header>
  );
}
