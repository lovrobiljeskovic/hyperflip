import type { Metadata } from "next";
import { Bricolage_Grotesque, Instrument_Sans, Martian_Mono } from "next/font/google";
import "./globals.css";
import { appCanonical, siteUrl } from "@/lib/site";

/* Three faces, both grounds. Bricolage carries display and the wordmark through
   its opsz axis, Instrument Sans the body and UI labels, Martian Mono every
   printed number, ticker, address and field label. */
const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
  axes: ["opsz"],
});

const instrument = Instrument_Sans({
  variable: "--font-instrument",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const martian = Martian_Mono({
  variable: "--font-martian",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Hyperflip | Stack HIP-4 Markets. Multiply the Payout.",
    template: "%s | Hyperflip",
  },
  description:
    "Bundle Hyperliquid outcome markets into one combo. Each one you add multiplies what you can win. Lock in your payout upfront, then hit them all to collect.",
  applicationName: "Hyperflip",
  keywords: ["Hyperflip", "HyperCore", "Hyperliquid", "HIP-4", "outcome markets", "parlay", "combo"],
  alternates: { canonical: "/" },
  verification: { google: "BPoq5CSIGwE3lTC0OKiPgVtX47UZu6ZoT7SgYAxiWd0" },
  openGraph: {
    siteName: "Hyperflip",
    url: "/",
    title: "Hyperflip | Stack HIP-4 Markets. Multiply the Payout.",
    description: "Bundle Hyperliquid outcome markets into one combo. Each one you add multiplies what you can win. Lock in your payout upfront, then hit them all to collect.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    site: "@hyperflip_xyz",
    creator: "@hyperflip_xyz",
    title: "Hyperflip | Stack HIP-4 Markets. Multiply the Payout.",
    description: "Bundle Hyperliquid outcome markets into one combo. Each one you add multiplies what you can win. Lock in your payout upfront, then hit them all to collect.",
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${siteUrl}/#org`,
      name: "Hyperflip",
      url: siteUrl,
      logo: `${siteUrl}/icon.svg`,
      email: "contact@hyperflip.xyz",
      sameAs: ["https://x.com/hyperflip_xyz"],
    },
    {
      "@type": "WebSite",
      "@id": `${siteUrl}/#site`,
      name: "Hyperflip",
      url: siteUrl,
      publisher: { "@id": `${siteUrl}/#org` },
    },
    {
      "@type": "WebApplication",
      name: "Hyperflip",
      url: appCanonical(),
      applicationCategory: "FinanceApplication",
      operatingSystem: "Web",
      description: "Bundle Hyperliquid outcome markets into one combo. Each one you add multiplies what you can win. Lock in your payout upfront, then hit them all to collect.",
    },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${bricolage.variable} ${instrument.variable} ${martian.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-ink text-fg font-sans">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        {children}
      </body>
    </html>
  );
}
