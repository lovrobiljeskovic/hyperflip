import { appChain } from "@/lib/chain";
import { ogCard } from "@/lib/og";
import { appHost } from "@/lib/site";

export { size, contentType } from "@/lib/og";
export const alt = `Hyperflip. Build a slip on ${appChain.name}.`;

export default function OpenGraphImage() {
  return ogCard(`Build a slip on ${appChain.name}.`, `Combos on HIP-4 markets · ${appHost}`);
}
