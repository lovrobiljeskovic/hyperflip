import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Positions",
  description: "Your open and settled Hyperflip slips.",
  alternates: { canonical: "/positions" },
  robots: { index: false },
};

export default function PositionsLayout({ children }: LayoutProps<"/positions">) {
  return children;
}
