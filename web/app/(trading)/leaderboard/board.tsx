import Link from "next/link";
import { appChain, explorerAddress } from "@/lib/chain";
import { aggregate, type Entry } from "@/lib/leaderboard";
import { loadLeaderboardRows } from "@/lib/leaderboard-source";
import { loadIdentities, type Identities, type Identity } from "@/lib/identities";
import { formatUsdc, pct1, shortAddress } from "@/lib/format";
import { appHref } from "@/lib/site";
import { ShareRecord } from "./share-record";


const cell = "px-5 py-4";
const head = "px-5 py-3 font-normal";

/** A linked X account shows as avatar + handle with the address one glyph away; otherwise the
 * short address linking to the explorer. Plain <img>: X serves `_normal` 48 px avatars. */
function Wallet({ wallet, identity }: { wallet: string; identity?: Identity }) {
  const href = explorerAddress(wallet);
  if (!identity) {
    const label = shortAddress(wallet);
    return href ? <a href={href} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">{label}</a> : <>{label}</>;
  }
  return (
    <span className="inline-flex items-center gap-2">
      {identity.avatar && <img src={identity.avatar} alt="" width={20} height={20} loading="lazy" referrerPolicy="no-referrer" className="size-5 rounded-full bg-line" />}
      <a href={`https://x.com/${identity.username}`} target="_blank" rel="noreferrer" className="text-fg underline-offset-4 hover:underline">@{identity.username}</a>
      {href && <a href={href} target="_blank" rel="noreferrer" title={wallet} className="text-dim hover:text-fg">↗</a>}
    </span>
  );
}

const settledOf = (e: Entry) => e.wins + e.losses > 0;
const winPct = (e: Entry) => settledOf(e) ? pct1(e.winRate) : "—";

/** The board itself; `highlight` rings one wallet's row (its /leaderboard/<wallet> page). */
export async function Board({ highlight }: { highlight?: `0x${string}` } = {}) {
  let board: ReturnType<typeof aggregate> | null = null;
  let identities: Identities = {};
  try {
    const [rows, ids] = await Promise.all([loadLeaderboardRows(), loadIdentities()]);
    board = aggregate(rows.rows);
    identities = ids;
  } catch { /* rendered below */ }

  return (
    <div className="min-h-screen text-[13px] text-fg">
      <main className="mx-auto max-w-[1280px] px-4 py-8 sm:px-6 sm:py-10">
        <h1 className="display text-[32px] [font-variation-settings:'wght'_700] tracking-[-0.03em]">Leaderboard</h1>
        <p className="mt-1 text-[15px] text-dim">Every trader who minted a slip on {appChain.name}. Ranked by wins, then fewer losses.</p>

        {/* No entries but unresolved reads is a degraded load, not an empty board. */}
        {!board || (board.entries.length === 0 && board.unknown > 0) ? (
          <div className="mt-10 rounded-card border border-line bg-panel p-6">
            <p className="text-dim">Leaderboard is updating. Try again in a minute.</p>
          </div>
        ) : board.entries.length === 0 ? (
          <div className="mt-10 rounded-card border border-line bg-panel p-6">
            <p className="text-dim">
              No slips minted yet -{" "}
              <Link href={appHref()} className="text-accent underline underline-offset-4">build one</Link>.
            </p>
          </div>
        ) : (
          <>
            <div className="mt-6 grid grid-cols-3 gap-px overflow-hidden rounded-card border border-line bg-line">
              {([["Traders", String(board.entries.length)], ["Slips settled", String(board.settled)], ["Paid out", `${formatUsdc(board.paidOut)} USDC`]] as const).map(([label, value]) => (
                <div key={label} className="bg-panel px-[18px] py-[14px]">
                  <p className="mono text-[10px] uppercase tracking-[0.16em] text-dim">{label}</p>
                  <p className="mono mt-1 text-[16px]">{value}</p>
                </div>
              ))}
            </div>

            <ShareRecord entries={board.entries} />

            {/* Mobile: one card per wallet. */}
            <div className="mt-4 flex flex-col gap-3 md:hidden">
              {board.entries.map((e) => (
                <div key={e.wallet} className={`mono rounded-card border bg-panel px-4 py-3 text-[12px] ${e.wallet === highlight ? "border-accent/60" : "border-line"}`}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span><span className={e.rank <= 3 ? "text-accent" : "text-dim"}>#{e.rank}</span> <Wallet wallet={e.wallet} identity={identities[e.wallet]} /></span>
                    <span>{e.wins}-{e.losses}</span>
                  </div>
                  <div className="mt-3">
                    <p className="text-[9px] uppercase tracking-[0.16em] text-dim">Win %</p>
                    <p className="mt-0.5">{winPct(e)}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 hidden overflow-x-auto rounded-card border border-line bg-panel md:block">
              <table className="w-full text-left text-sm">
                <thead className="mono text-[9px] uppercase tracking-[0.16em] text-dim">
                  <tr className="border-b border-line">
                    <th className={head}>Rank</th>
                    <th className={head}>Trader</th>
                    <th className={`${head} text-right`}>W-L</th>
                    <th className={`${head} text-right`}>Win %</th>
                  </tr>
                </thead>
                <tbody className="mono text-[12px]">
                  {board.entries.map((e, i) => (
                    <tr key={e.wallet} className={`${i < board!.entries.length - 1 ? "border-b border-line" : ""} ${e.wallet === highlight ? "bg-accent/[0.06]" : ""}`}>
                      <td className={`${cell} ${e.rank <= 3 ? "text-accent" : "text-dim"}`}>#{e.rank}</td>
                      <td className={cell}><Wallet wallet={e.wallet} identity={identities[e.wallet]} /></td>
                      <td className={`${cell} text-right`}>{e.wins}-{e.losses}</td>
                      <td className={`${cell} text-right`}>{winPct(e)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-4 text-xs text-dim">
              Record belongs to the wallet that minted the slip. Open and voided slips don&apos;t count. Updates every minute.
              {board.unknown > 0 && ` ${board.unknown} ${board.unknown === 1 ? "slip is" : "slips are"} still updating.`}
            </p>
          </>
        )}
      </main>
    </div>
  );
}
