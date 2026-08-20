"use client";

import { usePathname } from "next/navigation";
import { WalletButton } from "./wallet-button";

const LINKS = [
  { href: "/build", label: "Build" },
  { href: "/positions", label: "Positions" },
];

/** Shared app chrome for the signed-in surfaces (/build, /positions). The
 * landing page keeps its own marketing nav and just drops in WalletButton. */
export function AppHeader() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-ink/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-6">
        <a href="/" className="flex items-center gap-2 font-mono text-sm tracking-tight text-fg">
          <span className="inline-block size-2.5 rounded-[2px] bg-accent" aria-hidden />
          parlay
        </a>
        <nav className="ml-auto flex items-center gap-6 text-sm">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              aria-current={pathname === l.href ? "page" : undefined}
              className={
                pathname === l.href
                  ? "text-fg"
                  : "text-dim transition-colors hover:text-fg"
              }
            >
              {l.label}
            </a>
          ))}
        </nav>
        <WalletButton />
      </div>
    </header>
  );
}
