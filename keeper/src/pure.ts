import { encodeAbiParameters, isAddress, keccak256, type Address, type Hex } from "viem";
import { coreVault } from "../../services/markets.mjs";

/** CoreConstants.OUTCOME_WEI_PER_SHARE — outcome wei is 5-decimal. */
const OUTCOME_WEI_PER_SHARE = 100_000n;
/** CoreConstants.SETTLED_VALUE_ONE — settledValue scale (1e8 = fraction 1.0). */
const SETTLED_VALUE_ONE = 100_000_000n;
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

export type BalanceVerdict = "attest-true" | "attest-false" | "hold" | "wait";

/** CRITICAL: "attest-false" only with a confident baseline; an unconfident timeout can only "hold". */
export function resolveBalanceCheck(
  baseline: bigint,
  current: bigint,
  opType: OpType,
  weiAmount: bigint,
  elapsedMs: number,
  timeoutMs: number,
  confidentBaseline: boolean,
): BalanceVerdict {
  if (deltaMatches(baseline, current, opType, weiAmount)) return "attest-true";
  if (elapsedMs <= timeoutMs) return "wait";
  return confidentBaseline ? "attest-false" : "hold";
}

export interface BalanceSample {
  readAt: number;
  balance: bigint;
}

/** Newest sample read at or before `beforeMs` (a block timestamp): Core cannot execute an action before
 * its block exists, so such a sample is provably pre-op. `marginMs` absorbs keeper clock running behind
 * chain time; `maxAgeMs` stops a stalled sampler's old sample from qualifying. */
export function newestSampleBefore(
  samples: readonly BalanceSample[],
  beforeMs: number,
  marginMs = 0,
  maxAgeMs = Infinity,
): BalanceSample | undefined {
  const cutoff = beforeMs - marginMs;
  const floor = cutoff - maxAgeMs;
  let best: BalanceSample | undefined;
  for (const s of samples) {
    if (s.readAt <= cutoff && s.readAt >= floor && (!best || s.readAt > best.readAt)) best = s;
  }
  return best;
}

/** CoreConstants.outcomeStatus settledValue (scale 1e8) -> OutcomeVault.settleFractionWad (1e18). */
export function fractionWadFromSettledValue(settledValue: bigint): bigint {
  return (settledValue * WAD) / SETTLED_VALUE_ONE;
}

/** JSON with bigint strings; vault keys lowercased so checksum-case config churn cannot orphan an entry. */
export function encodeFractionCache(cache: ReadonlyMap<string, bigint>): string {
  return JSON.stringify(Object.fromEntries([...cache].map(([v, f]) => [v.toLowerCase(), f.toString()])));
}

/** Reject damaged state so startup cannot replace it with a partial cache. */
export function decodeFractionCache(json: string): Map<string, bigint> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const out = new Map<string, bigint>();
    for (const [vault, fraction] of Object.entries(parsed)) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(vault) || typeof fraction !== "string" || !/^[0-9]+$/.test(fraction)) throw new Error();
      const value = BigInt(fraction);
      if (value > WAD || out.has(vault.toLowerCase())) throw new Error();
      out.set(vault.toLowerCase(), value);
    }
    return out;
  } catch { throw new Error("Invalid settlement cache; preserve and repair it before restarting"); }
}

/** Runs async calls one at a time. Wrap only the send: viem derives the nonce at send time, so concurrent
 * sends from one account collide, but holding the queue through a receipt wait would stall the other loop. */
export function createSerializer(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return function sendTx<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn, fn);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

/** The writer's registry is the keeper's vault list — one source of truth; malformed input throws. */
export function parseRegistryMarkets(json: string): { vault: Address; leg?: Address; expiryMs?: number }[] {
  const parsed = JSON.parse(json) as { markets?: { vault?: string; sourceVault?: unknown; expiryMs?: unknown }[] };
  if (!Array.isArray(parsed.markets)) throw new Error("registry has no markets array");
  if (parsed.markets.length === 0) throw new Error("registry lists no markets");
  return parsed.markets.map((m) => {
    if (typeof m?.vault !== "string" || !isAddress(m.vault)) {
      throw new Error(`invalid vault in registry: ${String(m?.vault)}`);
    }
    if (m.sourceVault !== undefined && (typeof m.sourceVault !== "string" || !isAddress(m.sourceVault))) {
      throw new Error(`invalid sourceVault in registry: ${String(m.sourceVault)}`);
    }
    // Lane rule: services/markets.mts. The keeper settles the Core account (`coreVault`).
    return {
      vault: coreVault(m as { vault: string; sourceVault?: string }) as Address,
      ...(m.sourceVault ? { leg: m.vault as Address } : {}),
      expiryMs: typeof m.expiryMs === "number" ? m.expiryMs : undefined,
    };
  });
}

/** Gas limit for OutcomeLeg.receiveSettlement on Elysium (two SSTOREs and an event; ~50k used). */
export const RELAY_GAS_LIMIT = 100_000n;
/** After a relay() is sent, how long to wait for the retryable to land before paying for another. */
export const RELAY_HOLD_MS = 3 * 60_000;

/** abi.encodeCall(OutcomeLeg.receiveSettlement, (vault, fractionWad)): selector + two words. */
const RELAY_DATA_LENGTH = 68n;

/** Stock retryable pricing for one relay(), quoted from the live 998 basefee: Nitro charges
 * (1400 + 6 * dataLength) * baseFee for submission, so a quote at basefee 0 is 0 and the Inbox
 * reverts InsufficientSubmissionCost at inclusion (2026-09-25, see Gotchas). Submission fee and
 * Elysium gas are both doubled so a basefee move between the quote and inclusion cannot strand
 * the ticket. Excess refunds to the keeper on Elysium. */
export function relayFees(baseFeePerGas: bigint, l2GasPrice: bigint): {
  maxSubmissionCost: bigint; gasLimit: bigint; maxFeePerGas: bigint; value: bigint;
} {
  if (baseFeePerGas <= 0n) throw new Error("relayFees: 998 basefee unavailable, refusing a zero submission quote");
  const maxSubmissionCost = (1400n + 6n * RELAY_DATA_LENGTH) * baseFeePerGas * 2n;
  const maxFeePerGas = l2GasPrice * 2n;
  return { maxSubmissionCost, gasLimit: RELAY_GAS_LIMIT, maxFeePerGas, value: maxSubmissionCost + RELAY_GAS_LIMIT * maxFeePerGas };
}

/** Relay when the leg is still unsettled and no relay is inside its hold window. */
export function shouldRelay(legSettled: boolean, sentAt: number | undefined, now: number): boolean {
  return !legSettled && (sentAt === undefined || now - sentAt >= RELAY_HOLD_MS);
}
