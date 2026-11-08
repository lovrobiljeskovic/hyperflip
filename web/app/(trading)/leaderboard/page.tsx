import { appChain } from "@/lib/chain";
import { appPageMetadata } from "@/lib/site";
import { Board } from "./board";

// ISR: the scan and reads run at most once a minute, never per view. Nested metadata replaces the
// trading layout's noindex: this page is the one app page meant to be found and linked.
export const revalidate = 60;
export const metadata = {
  ...appPageMetadata("Leaderboard", `Top slips on ${appChain.name} by win/loss record.`, "/leaderboard"),
  robots: { index: true, follow: true },
};

export default function LeaderboardPage() {
  return <Board />;
}
