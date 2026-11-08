import Link from "next/link";
import { appChain, explorerAddress } from "@/lib/chain";
import { aggregate, type Entry } from "@/lib/leaderboard";
import { loadLeaderboardRows } from "@/lib/leaderboard-source";
import { formatUsdc, pct1, shortAddress } from "@/lib/format";
import { appHref, appPageMetadata } from "@/lib/site";
import { ShareRecord, type WireEntry } from "./share-record";

// ISR: the scan and reads run at most once a minute, never per view. Nested metadata replaces the
// trading layout's noindex: this page is the one app page meant to be found and linked.
export const revalidate = 60;
export const metadata = {
  ...appPageMetadata("Leaderboard", `Top slips on ${appChain.name} by win/loss record.`, "/leaderboard"),
  robots: { index: true, follow: true },
};

const cell = "px-5 py-4";
const head = "px-5 py-3 font-normal";
const signed = (v: bigint) => `${v < 0n ? "−" : "+"}${formatUsdc(v < 0n ? -v : v)}`;
const profitClass = (v: bigint) => v > 0n ? "text-yes" : v < 0n ? "text-no" : "text-dim";

function Wallet({ wallet }: { wallet: string }) {
  const href = explorerAddress(wallet);
  const label = shortAddress(wallet);
  return href ? <a href={href} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">{label}</a> : <>{label}</>;
}

export default async function LeaderboardPage() {
  let board: ReturnType<typeof aggregate> | null = null;
  try { board = aggregate((await loadLeaderboardRows()).rows); } catch { /* rendered below */ }

  return (
    <div className="min-h-screen text-[13px] text-fg">
      <main className="mx-auto max-w-[1280px] px-4 py-8 sm:px-6 sm:py-10">
        <h1 className="display text-[32px] [font-variation-settings:'wght'_700] tracking-[-0.03em]">Leaderboard</h1>
        <p className="mt-1 text-[15px] text-dim">Settled slips on {appChain.name}. Ranked by wins, then win rate.</p>

        {/* No entries but unresolved reads is a degraded load, not an empty board. */}
        {!board || (board.entries.length === 0 && board.unknown > 0) ? (
          <div className="mt-10 rounded-card border border-line bg-panel p-6">
            <p className="text-dim">Leaderboard is updating. Try again in a minute.</p>
          </div>
        ) : board.entries.length === 0 ? (
          <div className="mt-10 rounded-card border border-line bg-panel p-6">
            <p className="text-dim">
              No settled slips yet -{" "}
              <Link href={appHref()} className="text-accent underline underline-offset-4">build one</Link>.
            </p>
          </div>
        ) : (
          <>
            <div className="mt-6 grid grid-cols-3 gap-px overflow-hidden rounded-card border border-line bg-line">
              {([["Players", String(board.entries.length)], ["Slips settled", String(board.settled)], ["Paid out", `${formatUsdc(board.paidOut)} USDC`]] as const).map(([label, value]) => (
                <div key={label} className="bg-panel px-[18px] py-[14px]">
                  <p className="mono text-[10px] uppercase tracking-[0.16em] text-dim">{label}</p>
                  <p className="mono mt-1 text-[16px]">{value}</p>
                </div>
              ))}
            </div>

            <ShareRecord entries={board.entries.map(wire)} />

            {/* Mobile: one card per wallet. */}
            <div className="mt-4 flex flex-col gap-3 md:hidden">
              {board.entries.map((e) => (
                <div key={e.wallet} className="mono rounded-card border border-line bg-panel px-4 py-3 text-[12px]">
                  <div className="flex items-baseline justify-between gap-3">
                    <span><span className={e.rank <= 3 ? "text-accent" : "text-dim"}>#{e.rank}</span> <Wallet wallet={e.wallet} /></span>
                    <span>{e.wins}-{e.losses}</span>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {([["Win %", pct1(e.winRate), ""], ["Net profit", signed(e.profit), profitClass(e.profit)], ["Staked", formatUsdc(e.staked), ""]] as const).map(([label, value, cls]) => (
                      <div key={label}>
                        <p className="text-[9px] uppercase tracking-[0.16em] text-dim">{label}</p>
                        <p className={`mt-0.5 ${cls}`}>{value}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 hidden overflow-x-auto rounded-card border border-line bg-panel md:block">
              <table className="w-full text-left text-sm">
                <thead className="mono text-[9px] uppercase tracking-[0.16em] text-dim">
                  <tr className="border-b border-line">
                    <th className={head}>Rank</th>
                    <th className={head}>Wallet</th>
                    <th className={`${head} text-right`}>W-L</th>
                    <th className={`${head} text-right`}>Win %</th>
                    <th className={`${head} text-right`}>Net profit</th>
                    <th className={`${head} text-right`}>Staked</th>
                  </tr>
                </thead>
                <tbody className="mono text-[12px]">
                  {board.entries.map((e, i) => (
                    <tr key={e.wallet} className={i < board!.entries.length - 1 ? "border-b border-line" : ""}>
                      <td className={`${cell} ${e.rank <= 3 ? "text-accent" : "text-dim"}`}>#{e.rank}</td>
                      <td className={cell}><Wallet wallet={e.wallet} /></td>
                      <td className={`${cell} text-right`}>{e.wins}-{e.losses}</td>
                      <td className={`${cell} text-right`}>{pct1(e.winRate)}</td>
                      <td className={`${cell} text-right ${profitClass(e.profit)}`}>{signed(e.profit)}</td>
                      <td className={`${cell} text-right text-dim`}>{formatUsdc(e.staked)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-4 text-xs text-dim">
              Record belongs to the wallet that minted the slip. Voided slips don&apos;t count. USDC. Updates every minute.
              {board.unknown > 0 && ` ${board.unknown} ${board.unknown === 1 ? "slip is" : "slips are"} still updating.`}
            </p>
          </>
        )}
      </main>
    </div>
  );
}

function wire(e: Entry): WireEntry {
  return { ...e, profit: String(e.profit), staked: String(e.staked) };
}
