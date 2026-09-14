"use client";

// A distinct client entry keeps the shared navigation from loading app wallet chunks.
import Link from "next/link";
import { appHref } from "@/lib/site";
import { SiteHeader } from "./site-header";

export function LandingHeader() {
  return <SiteHeader
    links={[
      { href: "/#board", label: "Markets" },
      { href: "/#writing", label: "How it works" },
      { href: "/#book", label: "How pricing works" },
    ]}
    action={<Link href={appHref()} prefetch={false} className="inline-flex rounded-card bg-accent px-4 py-2 text-xs font-semibold text-on-accent">Launch app</Link>}
  />;
}
