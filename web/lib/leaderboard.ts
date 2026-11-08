import { deriveRow, type Row } from "./positions";

/** House and operator wallets (Operations/Wallets.md): bank, box EOA, keeper, signer, reserve,
 * both cold owners, both HIP-4 venue owners. Lowercase. */
export const HOUSE_WALLETS: ReadonlySet<string> = new Set([
  "0x3325d57d906f24ae9afde5229ac8174a8fa0c5a7",
  "0x171070fe2e9f5bb1738ecf6979c24057ebe1576d",
  "0x51ae82d30646b1d8ac782c9e02ab06ca8a436ed1",
  "0x2b24db9e6f7283f805760dc995520353b30191ec",
  "0x520d677c908cf1b7fed1ca37aed647046bed37f2",
  "0xd6286f560714b536a8aa93b533eb94dda7385553",
  "0x9776b108291162383220086befe1d4c096ae1d7a",
  "0x0eb313e1ee2eafdb0fb0eb11c120a218b9114d64",
  "0x8920070b374ba6a9dd09bf1f8d9d0841c64e0db4",
]);

export type Entry = {
  rank: number;
  wallet: `0x${string}`;
  wins: number;
  losses: number;
  winRate: number;
  profit: bigint; // Σ(maxPayout − premium) over wins − Σ premium over losses
  staked: bigint; // Σ premium over settled (won + lost) slips
  open: number;   // slips not yet decided (open, void or still updating)
};

type Outcome = "won" | "lost" | "unknown" | null;

/** One definition of won/lost, shared with the Positions page: unclaimed wins count, a lost leg
 * counts before the poker resolves the ticket, void and open slips count for nothing. */
function outcome(row: Row): Outcome {
  const label = deriveRow(row).statusLabel;
  if (label === "Claimable" || label === "Claimed") return "won";
  if (label === "Lost") return "lost";
  if (label === "Updating outcomes") return "unknown";
  return null;
}

const settledOf = (e: { wins: number; losses: number }) => e.wins + e.losses;

/** Every taker on the lane. Ranked by wins, then win rate, then profit; wallets with nothing
 * settled yet follow, most open slips first, so a new minter is on the board from the first slip. */
export function aggregate(rows: Row[], exclude: ReadonlySet<string> = HOUSE_WALLETS) {
  const byWallet = new Map<string, Omit<Entry, "rank" | "winRate">>();
  let settled = 0, unknown = 0, paidOut = 0n;
  for (const row of rows) {
    const wallet = row.taker?.toLowerCase();
    if (!wallet || exclude.has(wallet)) continue;
    const e = byWallet.get(wallet) ?? { wallet: wallet as `0x${string}`, wins: 0, losses: 0, profit: 0n, staked: 0n, open: 0 };
    byWallet.set(wallet, e);
    const result = outcome(row);
    if (result === null || result === "unknown") {
      if (result === "unknown") unknown++;
      e.open++;
      continue;
    }
    const { premium, maxPayout } = row.parlay;
    settled++;
    e.staked += premium;
    if (result === "won") { e.wins++; e.profit += maxPayout - premium; paidOut += maxPayout; }
    else { e.losses++; e.profit -= premium; }
  }
  const entries: Entry[] = [...byWallet.values()]
    .map(e => ({ ...e, rank: 0, winRate: settledOf(e) ? e.wins / settledOf(e) : 0 }))
    .sort((x, y) => Number(settledOf(y) > 0) - Number(settledOf(x) > 0)
      || y.wins - x.wins || y.winRate - x.winRate || (y.profit > x.profit ? 1 : y.profit < x.profit ? -1 : 0)
      || y.open - x.open || x.wallet.localeCompare(y.wallet))
    .map((e, i) => ({ ...e, rank: i + 1 }));
  return { entries, settled, unknown, paidOut };
}

export function recordShareText(e: Entry, chainName: string): string {
  return `${e.wins}-${e.losses} on @hyperflip_xyz (#${e.rank} on ${chainName})`;
}
