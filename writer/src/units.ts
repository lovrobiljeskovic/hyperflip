export const WAD = 1_000_000_000_000_000_000n;
export const BPS = 10_000n;

/** Probability → WAD at 1e-6 precision, and back. */
export const toWad = (p: number): bigint => BigInt(Math.round(p * 1e6)) * 10n ** 12n;
export const fromWad = (wad: bigint): number => Number(wad / 10n ** 12n) / 1e6;
