"use client";

import { appHref, websiteHref } from "@/lib/site";
import { SiteHeader } from "./site-header";
import { WalletButton } from "./wallet-button";

export function AppHeader() {
  return <SiteHeader
    home={appHref()}
    links={[
      { href: appHref(), label: "Trade", activePaths: ["/", "/build"] },
      { href: appHref("/positions"), label: "Positions", activePaths: ["/positions"] },
      { href: appHref("/pricing"), label: "Pricing", activePaths: ["/pricing"] },
      { href: websiteHref, label: "Website" },
    ]}
    action={<WalletButton />}
  />;
}
