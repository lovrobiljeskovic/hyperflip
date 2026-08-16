import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

/** CoreConstants.OUTCOME_WEI_PER_SHARE — outcome wei is 5-decimal. */
export const OUTCOME_WEI_PER_SHARE = 100_000n;
/** CoreConstants.SETTLED_VALUE_ONE — settledValue scale (1e8 = fraction 1.0). */
export const SETTLED_VALUE_ONE = 100_000_000n;
export const WAD = 1_000_000_000_000_000_000n;

/** opKey = keccak256(abi.encode(vaultAddress, opId)) — KeeperVerifier.sol /
 * OutcomeVault._statusOf. abi.encode (padded words), not encodePacked. */
export function opKey(vault: Address, opId: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [vault, opId]));
}

/** Mirrors CoreConstants._convert for the outcome-wei leg (evmToOutcomeWei). Used only to
 * recompute a rebuilt op's weiAmount from `pendingDeposit`/`pendingRedeem` state (no OpQueued
 * log replayed on restart) — throws the same way Solidity's `_convert` would on dust/zero. */
export function evmToOutcomeWei(amountEvm: bigint, evmUnitsPerShare: bigint): bigint {
  const scaled = amountEvm * OUTCOME_WEI_PER_SHARE;
  const w = scaled / evmUnitsPerShare;
  if (w <= 0n || w > 2n ** 64n - 1n) throw new Error("BAD_AMOUNT");
  if (w * evmUnitsPerShare !== scaled) throw new Error("DUST");
  return w;
}

/** Core's coin encoding for one side of an outcome: coin name "+<id>", id = 10*outcome + side
 * (0 = yes, 1 = no). FINDINGS.md confirmed live as "+123850" / "+123851". */
export function coinIdForOutcome(outcome: number, yes: boolean): bigint {
  return 10n * BigInt(outcome) + (yes ? 0n : 1n);
}

/** Parses a spotClearinghouseState `coin` field like "+123850" into its numeric id. Returns
 * null for anything that isn't that shape (e.g. "USDC") so callers can filter non-outcome coins. */
export function parseCoinId(coin: string): bigint | null {
  if (!/^\+\d+$/.test(coin)) return null;
  return BigInt(coin.slice(1));
}

/** Decimal balance string ("10.0", "0.007") -> bigint at `decimals` precision. Truncates (does
 * not round) extra fractional digits — inputs here are exact info-API output, not user entry. */
export function parseDecimalToUnits(value: string, decimals: number): bigint {
  const neg = value.startsWith("-");
  const body = neg ? value.slice(1) : value;
  const [intPart, fracPart = ""] = body.split(".");
  const frac = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  const units = BigInt(intPart || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
  return neg ? -units : units;
}

/** OutcomeVault.OpType: Split = 0, Merge = 1. */
export type OpType = 0 | 1;

/** Split mints (+weiAmount) on both sides; merge burns (-weiAmount) on both sides, in the same
 * CoreWriter action — so checking one side (yes) is sufficient to confirm the other executed. */
export function expectedDelta(opType: OpType, weiAmount: bigint): bigint {
  return opType === 0 ? weiAmount : -weiAmount;
}

export function deltaMatches(baseline: bigint, current: bigint, opType: OpType, weiAmount: bigint): boolean {
  return current - baseline === expectedDelta(opType, weiAmount);
}

/** CoreConstants.outcomeStatus settledValue (scale 1e8) -> OutcomeVault.settleFractionWad (1e18). */
export function fractionWadFromSettledValue(settledValue: bigint): bigint {
  return (settledValue * WAD) / SETTLED_VALUE_ONE;
}
