import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Build a slip",
  description: "Pick two to ten live HyperCore sports markets and mint one on-chain slip with a signed price.",
  alternates: { canonical: "/build" },
};

export default function BuildLayout({ children }: LayoutProps<"/build">) {
  return children;
}
