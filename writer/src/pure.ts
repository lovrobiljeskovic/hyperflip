export const WAD = 1_000_000_000_000_000_000n;
export const BPS = 10_000n;

/** Decimal string ("0.65", "10.0") -> bigint at `decimals` precision. Truncates extra
 * fractional digits — inputs are exact info-API output, not user entry. */
/** Split [from, to] into inclusive ranges of at most `size` blocks — testnet RPC
 * rejects getLogs spans over 1000 blocks. Empty when to < from. */
export function blockRanges(from: bigint, to: bigint, size: bigint): { from: bigint; to: bigint }[] {
  const out: { from: bigint; to: bigint }[] = [];
  for (let start = from; start <= to; start += size) {
    out.push({ from: start, to: start + size - 1n > to ? to : start + size - 1n });
  }
  return out;
}

/** Watchdog stall threshold for the poker tick loop — mirrors the keeper's formula
 * (keeper/src/keeper.ts:468, docs/mainnet-hardening-facts.md): a tick sequentially pokes every
 * open parlay, each resolve() receipt wait capped at receiptTimeoutMs, plus the gap the tick
 * loop itself leaves between ticks (tickIntervalMs); marginMs covers everything else with no
 * explicit timeout (getLogs/getBlockNumber/readContract). */
export function stallThresholdMs(
  openCount: number,
  receiptTimeoutMs: number,
  tickIntervalMs: number,
  marginMs = 120_000,
): number {
  return openCount * receiptTimeoutMs + tickIntervalMs + marginMs;
}

/** Pure watchdog predicate: has the last-tick stamp gone stale? */
export function isStalled(lastTickAt: number, now: number, thresholdMs: number): boolean {
  return now - lastTickAt > thresholdMs;
}

export function parseDecimalToUnits(value: string, decimals: number): bigint {
  const neg = value.startsWith("-");
  const body = neg ? value.slice(1) : value;
  const [intPart, fracPart = ""] = body.split(".");
  const frac = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  const units = BigInt(intPart || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
  return neg ? -units : units;
}

/** House capacity is the smaller of what the vault may pull (allowance) and what
 * the wallet actually holds (balance): a max-approve with an empty wallet must
 * not let the exposure book reserve risk the mint tx cannot fund. */
export function bankrollRoom(allowance: bigint, balance: bigint): bigint {
  return allowance < balance ? allowance : balance;
}

/** Edge-triggered low-bankroll alert: fires once when room drops below the
 * threshold and re-arms only after it recovers, so a flat-broke wallet does not
 * page on every quote. */
export function lowBankrollAlerter(threshold: bigint): (room: bigint) => boolean {
  let armed = true;
  return (room) => {
    if (room >= threshold) {
      armed = true;
      return false;
    }
    if (!armed) return false;
    armed = false;
    return true;
  };
}
