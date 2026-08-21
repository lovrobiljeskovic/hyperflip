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

export const metadata: Metadata = {
  title: "Overround",
  description:
    "Combine YES and NO legs from Hyperliquid outcome markets into one slip — one premium, one payout, settled on HyperCore.",
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
