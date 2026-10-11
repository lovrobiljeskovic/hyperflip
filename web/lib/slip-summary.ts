import { formatUsdc, USDC_DECIMALS } from "./format";

export const STAKE_CHIPS = [5, 10, 25, 50, 100] as const;
const MIN_LEGS = 2;

export function chipState(usdc: number, maxStake: bigint | null, balance: bigint | undefined): { enabled: boolean; title?: string } {
  const base = BigInt(usdc) * 10n ** BigInt(USDC_DECIMALS);
  if (maxStake !== null && base > maxStake) return { enabled: false, title: `House limit ${formatUsdc(maxStake)} USDC per ticket` };
  if (balance !== undefined && base > balance) return { enabled: false, title: `Balance ${formatUsdc(balance)} USDC` };
  return { enabled: true };
}

/** Text for the collapsed sheet bar. `right` is the to-win figure once a quote exists. */
export function barSummary({ legs, multiplier, stakeUsdc, maxPayout }: { legs: number; multiplier: number | null; stakeUsdc: bigint | null; maxPayout: bigint | null }) {
  const primary = `${legs} ${legs === 1 ? "leg" : "legs"} · ${multiplier === null ? "—" : `${multiplier.toFixed(2)}x`}`;
  const secondary = legs < MIN_LEGS ? `add ${MIN_LEGS - legs} more leg${MIN_LEGS - legs === 1 ? "" : "s"}` : stakeUsdc === null ? "enter a stake" : `$${formatUsdc(stakeUsdc)} stake`;
  const right = maxPayout === null ? null : `→ $${formatUsdc(maxPayout)}`;
  return { primary, secondary, right };
}
