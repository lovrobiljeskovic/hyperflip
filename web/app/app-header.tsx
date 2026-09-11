"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletButton } from "./wallet-button";
import { HyperflipBrand } from "./brand";

const NAV = [
  { href: "/#board", label: "Markets" },
  { href: "/#writing", label: "How it works" },
  { href: "/#book", label: "Pricing" },
  { href: "/build", label: "Build" },
  { href: "/positions", label: "Positions" },
];

export function AppHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const linkClass = (active: boolean) =>
    active ? "border-b border-accent pb-[3px] text-fg" : "text-dim transition-colors hover:text-fg";
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-ink/90 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1280px] items-center justify-between gap-4 px-4 sm:gap-6 sm:px-6">
        <HyperflipBrand shared />
        <nav className="mono ml-auto hidden items-center gap-[26px] text-[10px] uppercase tracking-[0.1em] md:flex">
          {NAV.map((l) => {
            const active = pathname === l.href || (l.href === "/#board" && pathname === "/");
            return (
              <Link key={l.href} href={l.href} aria-current={active ? "page" : undefined} className={linkClass(active)}>
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
        <nav className="mono flex flex-col gap-1 border-t border-line bg-ink px-4 pb-4 pt-2 text-[11px] uppercase tracking-[0.1em] md:hidden">
          {NAV.map((l) => {
            const active = pathname === l.href || (l.href === "/#board" && pathname === "/");
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
    </header>
  );
}
