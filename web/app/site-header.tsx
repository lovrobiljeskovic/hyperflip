"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { HyperflipBrand } from "./brand";
import { ScrollLink } from "./scroll-link";
import { MenuIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

export function SiteHeader({ links, action, mobileAction, menu, home = "/" }: {
  links: { href: string; label: string; activePaths?: string[]; scrollTo?: string; icon?: string }[];
  action: ReactNode;
  /** Phone header slot; falls back to `action`. */
  mobileAction?: ReactNode;
  menu?: ReactNode;
  home?: string;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const linkClass = (active: boolean) =>
    active ? "border-b border-accent pb-[3px] text-fg" : "text-dim transition-colors hover:text-fg";
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-ink/90 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1280px] items-center justify-between gap-4 px-4 sm:gap-6 sm:px-6">
        <HyperflipBrand shared href={home} />
        <nav aria-label="Main navigation" className="mono ml-auto hidden items-center gap-[26px] text-[10px] uppercase tracking-[0.1em] lg:flex">
          {links.map((l) => {
            const active = l.activePaths?.includes(pathname) ?? false;
            if (l.scrollTo) return <ScrollLink key={l.label} to={l.scrollTo} className={linkClass(false)}>{l.label}</ScrollLink>;
            return (
              <Link key={l.label} href={l.href} prefetch={false} aria-current={active ? "page" : undefined} className={`${linkClass(active)} inline-flex items-center gap-1.5`}>
                {l.icon && <img src={l.icon} alt="" className="size-4" />}
                {l.label}
              </Link>
            );
          })}
          <span className="normal-case tracking-normal">
            {action}
          </span>
        </nav>
        <div className="ml-auto flex items-center gap-3 lg:hidden">
          {mobileAction ?? action}
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon-lg" aria-label="Open menu" className="border-line bg-transparent text-fg"><MenuIcon /></Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-[min(100%,340px)] border-line bg-ink text-fg sm:max-w-[340px]">
              <SheetHeader className="pb-0">
                <SheetTitle className="display text-[18px] font-normal">Menu</SheetTitle>
                <SheetDescription className="sr-only">Site navigation and wallet settings.</SheetDescription>
              </SheetHeader>
              <nav aria-label="Mobile navigation" className="mono flex flex-col gap-1 px-4 text-[11px] uppercase tracking-[0.1em]">
                {links.map((l) => {
                  const active = l.activePaths?.includes(pathname) ?? false;
                  if (l.scrollTo) return <ScrollLink key={l.label} to={l.scrollTo} onClick={() => setOpen(false)} className="py-2 text-dim">{l.label}</ScrollLink>;
                  return (
                    <Link
                      key={l.label}
                      href={l.href}
                      prefetch={false}
                      aria-current={active ? "page" : undefined}
                      onClick={() => setOpen(false)}
                      className={`inline-flex items-center gap-1.5 py-2 ${active ? "text-fg" : "text-dim"}`}
                    >
                      {l.icon && <img src={l.icon} alt="" className="size-4" />}
                      {l.label}
                    </Link>
                  );
                })}
                {menu}
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
