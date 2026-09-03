import type { Metadata } from "next";
import { Bricolage_Grotesque, Instrument_Sans, Martian_Mono } from "next/font/google";
import "./globals.css";
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

const deploymentHost = process.env.VERCEL_URL;
const siteUrl =
  process.env.VERCEL_ENV === "production"
    ? "https://hyperflip.xyz"
    : deploymentHost
      ? `https://${deploymentHost}`
      : "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Hyperflip | Stack outcomes on HyperCore",
  description:
    "Combine live HyperCore outcome markets into one on-chain slip with a signed price and locked payout.",
  applicationName: "Hyperflip",
  openGraph: {
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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${bricolage.variable} ${instrument.variable} ${martian.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-ink text-fg font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
