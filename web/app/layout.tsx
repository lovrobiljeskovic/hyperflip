import type { Metadata } from "next";
import { Bricolage_Grotesque, Geist, Geist_Mono, Martian_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/* Landing-page faces: Bricolage carries the display and body roles through
   its opsz axis, Martian Mono every printed number and field label. */
const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
  axes: ["opsz"],
});

const martian = Martian_Mono({
  variable: "--font-martian",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Parlay",
  description:
    "Parlays on Hyperliquid outcome markets. Combine YES and NO legs into one slip with one premium and one payout, settled on HyperCore.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${bricolage.variable} ${martian.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-ink text-fg font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
