import type { Metadata } from "next";
import { AppHeader } from "../app-header";
import { Providers } from "../providers";

export const metadata: Metadata = { robots: { index: false, follow: true } };

export default function TradingLayout({ children }: { children: React.ReactNode }) {
  return <Providers><AppHeader />{children}</Providers>;
}
