import type { Metadata } from "next";
import { appCanonical } from "@/lib/site";

export const metadata: Metadata = {
  title: "Positions",
  description: "Your open and settled Hyperflip slips.",
  alternates: { canonical: appCanonical("/positions") },
  openGraph: { url: appCanonical("/positions"), title: "Positions | Hyperflip" },
  robots: { index: false },
};

export default function PositionsLayout({ children }: LayoutProps<"/positions">) {
  return children;
}
