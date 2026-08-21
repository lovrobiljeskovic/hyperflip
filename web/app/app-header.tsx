"use client";

import { ViewTransition } from "react";
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
  const paper = ground === "paper";
  const nav = paper ? PAPER_NAV : DARK_NAV;
  return (
    <header
      className={`sticky top-0 z-30 ${
        paper ? "bg-[var(--stock)]/95" : "border-b border-line bg-ink/95"
      } backdrop-blur`}
    >
      <div className="mx-auto flex h-[60px] max-w-6xl items-center justify-between gap-6 px-6">
        <Link href="/" className="flex items-center gap-[10px]">
          <ViewTransition name="overround-mark">
            <Mark className="h-[15px] w-[26px]" />
          </ViewTransition>
          <span className="display text-[18px] [font-variation-settings:'wght'_700] tracking-[-0.035em]">
            overround
          </span>
        </Link>
        <nav className="mono ml-auto flex items-center gap-[26px] text-[10px] uppercase tracking-[0.1em]">
          {nav.map((l) => {
            const active = pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={
                  active
                    ? "border-b border-accent pb-[3px] text-fg"
                    : `text-dim transition-colors hover:text-fg ${paper ? "hidden md:block" : ""}`
                }
              >
                {l.label}
              </Link>
            );
          })}
          <span className="normal-case tracking-normal">
            <WalletButton />
          </span>
        </nav>
      </div>
      {paper && <div className="perf" />}
    </header>
  );
}
