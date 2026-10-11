import type { Metadata } from "next";

const deploymentHost = process.env.VERCEL_URL;

export const websiteHref = process.env.NEXT_PUBLIC_SITE_ORIGIN || "/";
export function appHref(path = "/"): string {
  const origin = process.env.NEXT_PUBLIC_APP_ORIGIN;
  return origin ? `${origin}${path}` : path === "/" ? "/build" : path;
}

export const siteUrl =
  process.env.VERCEL_ENV === "production"
    ? "https://hyperflip.xyz"
    : deploymentHost
      ? `https://${deploymentHost}`
      : "http://localhost:3000";

export function appCanonical(path = "/"): string {
  return new URL(appHref(path), siteUrl).href;
}

/** Host the app lane answers on: app.hyperflip.xyz or elysium.hyperflip.xyz in production. */
export const appHost = new URL(appCanonical()).host;

/** Full card metadata for one app page; og and twitter must both be set or the page inherits
 * the landing title from the root layout (nested metadata is replaced, not merged). */
export function appPageMetadata(title: string, description: string, path = "/"): Metadata {
  const url = appCanonical(path);
  return {
    // Resolve the card image on this lane's host; the apex serves the 998 lane's card.
    metadataBase: new URL(appCanonical()),
    title,
    description,
    alternates: { canonical: url },
    openGraph: { siteName: "Hyperflip", type: "website", url, title: `${title} | Hyperflip`, description },
    twitter: { card: "summary_large_image", site: "@hyperflip_xyz", title: `${title} | Hyperflip`, description },
  };
}

/** Absolute apex URL in production so app.hyperflip.xyz footers land on hyperflip.xyz pages. */
export function siteHref(path: string): string {
  return `${process.env.NEXT_PUBLIC_SITE_ORIGIN || ""}${path}`;
}

/** The other chain's app, when this deployment has a sibling (998 default, Elysium optional). */
export const altLane = process.env.NEXT_PUBLIC_ALT_LANE_URL
  ? process.env.NEXT_PUBLIC_CHAIN_ID === "998"
    ? { href: process.env.NEXT_PUBLIC_ALT_LANE_URL, label: "Elysium", icon: "/brand/elysium-logomark-colorized.svg" }
    : { href: process.env.NEXT_PUBLIC_ALT_LANE_URL, label: "HyperEVM", icon: "/brand/hyperliquid-logomark.svg" }
  : undefined;
