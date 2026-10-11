import { ogCard } from "@/lib/og";

export { size, contentType } from "@/lib/og";
export const alt = "Hyperflip. Combos on HIP-4 markets.";

export default function OpenGraphImage() {
  return ogCard("Stack your picks. Multiply the payout.", "Combos on HIP-4 markets · hyperflip.xyz");
}
