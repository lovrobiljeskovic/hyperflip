import type { Metadata } from "next";
import { Bricolage_Grotesque, Instrument_Sans, Martian_Mono } from "next/font/google";
import "./globals.css";
import { siteUrl } from "@/lib/site";
import { Providers } from "./providers";

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
    default: "Hyperflip | Stack outcomes on HyperCore",
    template: "%s | Hyperflip",
  },
  description:
    "Hyperflip combines live HyperCore outcome markets into one on-chain slip with a signed price and locked payout.",
  applicationName: "Hyperflip",
  keywords: ["Hyperflip", "HyperCore", "Hyperliquid", "HIP-4", "outcome markets", "parlay", "on-chain slip"],
  alternates: { canonical: "/" },
  verification: { google: "BPoq5CSIGwE3lTC0OKiPgVtX47UZu6ZoT7SgYAxiWd0" },
  openGraph: {
    siteName: "Hyperflip",
    url: "/",
    title: "Hyperflip | Stack outcomes on HyperCore",
    description: "Two to ten live outcomes. One on-chain slip. One locked payout.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Hyperflip | Stack outcomes on HyperCore",
    description: "Two to ten live outcomes. One on-chain slip. One locked payout.",
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "Organization", "@id": `${siteUrl}/#org`, name: "Hyperflip", url: siteUrl, logo: `${siteUrl}/icon.svg` },
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
      url: siteUrl,
      applicationCategory: "FinanceApplication",
      operatingSystem: "Web",
      description: "Combine live HyperCore outcome markets into one on-chain slip with a signed price and locked payout.",
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
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
