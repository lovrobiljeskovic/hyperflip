import { appChain } from "@/lib/chain";
import { appPageMetadata } from "@/lib/site";

export const metadata = appPageMetadata(
  `Build a slip on ${appChain.name}`,
  `Pick two to ten live HyperCore sports markets and mint one on-chain slip on ${appChain.name} with a signed price.`,
);

export default function BuildLayout({ children }: LayoutProps<"/build">) {
  return children;
}
