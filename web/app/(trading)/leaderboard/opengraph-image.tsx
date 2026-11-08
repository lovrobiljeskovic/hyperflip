import { appChain } from "@/lib/chain";
import { ogCard } from "@/lib/og";
import { appHost } from "@/lib/site";

export { size, contentType } from "@/lib/og";
export const alt = `Hyperflip leaderboard. Top slips on ${appChain.name}.`;

export default function OpenGraphImage() {
  return ogCard(`Top slips on ${appChain.name}.`, `Win/loss leaderboard · ${appHost}`);
}
