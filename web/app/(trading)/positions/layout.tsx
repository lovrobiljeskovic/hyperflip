import { appPageMetadata } from "@/lib/site";

export const metadata = {
  ...appPageMetadata("Positions", "Your open and settled Hyperflip slips.", "/positions"),
  robots: { index: false },
};

export default function PositionsLayout({ children }: LayoutProps<"/positions">) {
  return children;
}
