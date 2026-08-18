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

export function parseDecimalToUnits(value: string, decimals: number): bigint {
  const neg = value.startsWith("-");
  const body = neg ? value.slice(1) : value;
  const [intPart, fracPart = ""] = body.split(".");
  const frac = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  const units = BigInt(intPart || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
  return neg ? -units : units;
}
