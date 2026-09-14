import type { Metadata } from "next";
import { appCanonical } from "@/lib/site";

export const metadata: Metadata = {
  title: "Build a slip",
  description: "Pick two to ten live HyperCore sports markets and mint one on-chain slip with a signed price.",
  alternates: { canonical: appCanonical() },
  openGraph: { url: appCanonical(), title: "Build a slip | Hyperflip" },
};

export default function BuildLayout({ children }: LayoutProps<"/build">) {
  return children;
}
