import { encodeAbiParameters, isAddress, keccak256, type Address, type Hex } from "viem";

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

/** Encoded outcome asset id accepted by the 0x801 spot-balance and 0x808 spot-px precompiles
 * (2026-08 testnet update): 100000000 + 10*outcome + side (0 = yes, 1 = no). Official
 * L1Read.sol. */
export const OUTCOME_ASSET_BASE = 100_000_000n;
export function encodedOutcomeAssetId(outcome: number, yes: boolean): bigint {
  return OUTCOME_ASSET_BASE + 10n * BigInt(outcome) + (yes ? 0n : 1n);
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

/** Pure decision for one balanceLoop tick. CRITICAL invariant: "attest-false" is only ever
 * returned when `confidentBaseline` is true — a low-confidence baseline (a rebuilt op whose
 * pre-execution status is unknown, see keeper.ts track()) is not positive evidence of a drop, so
 * a timeout there can only "hold" (keep waiting, alert once) rather than guess. See keeper.ts
 * balanceLoop for the failed-attestation-rule rationale behind "attest-false" itself. */
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

/** Newest sample read at or before `beforeMs` (a block timestamp in ms), within `maxAgeMs` of it.
 * Core cannot have executed an action before the block containing it exists, so a sample whose
 * read time predates that block's own timestamp is provably pre-execution — independent of any
 * assumption about Core's actual processing latency. This is the crux of the live-baseline fix in
 * keeper.ts (resolveLiveBaseline): picking the wrong sample here silently reintroduces the race it
 * fixes.
 *
 * `marginMs` (default 0) is subtracted from `beforeMs` before comparing: `readAt` is the keeper's
 * own wall clock (Date.now()) while `beforeMs` derives from a chain block timestamp, and a keeper
 * clock running behind chain time would under-report `readAt`, making a post-execution sample look
 * falsely pre-op. The margin assumes the keeper clock cannot be behind by more than that much.
 *
 * `maxAgeMs` (default Infinity) additionally requires `readAt >= cutoff - maxAgeMs`: without it a
 * stalled sampler's arbitrarily old sample could still "qualify" as pre-op and serve as a baseline
 * nobody actually vouches for as current. */
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

/** Serialization for the settlement-fraction cache (see keeper.ts settlementLoop).
 *
 * Core prunes a settled outcome within ~10 minutes, and the pruned relay path can only replay a
 * fraction this keeper observed while status was still 2. Holding that only in memory means any
 * restart inside the window — a crash, a redeploy, a supervisor bounce — destroys the one number
 * that can still settle the vault, and recovery drops to manual. That is exactly what stranded
 * the 8/19 vaults on Aug 20. JSON keeps bigints as strings; vault keys are lowercased so a
 * checksum-case config change cannot orphan an entry. */
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

/** Serializes async calls through a promise chain: each call waits for the previous one to
 * settle (success or failure) before starting. keeper.ts uses one shared instance to wrap every
 * walletClient.writeContract call — attest() (balanceLoop) and settle() (settlementLoop) send
 * from the same account with no explicit nonce, so viem derives the nonce at send time from the
 * account's pending tx count; two concurrent sends would race that derivation and collide on the
 * same nonce. Only wrap the send itself (through the point a hash comes back), not any
 * subsequent receipt wait — the nonce is consumed once the node accepts the tx into its pool, and
 * holding the queue through a ~60s receipt wait would stall the other loop for no reason. */
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

/** Markets out of registry/markets.json (the file the writer serves at GET /markets).
 *
 * The keeper and the writer used to keep separate market lists — VAULT_ADDRESSES env here,
 * MARKETS_FILE there — agreeing only by hand. Adding a vault to the registry and forgetting the
 * env made the writer quote a market the keeper would never settle, which surfaces only at
 * expiry, as a stranded vault. One source of truth removes the failure mode.
 *
 * `expiryMs` is optional, matching the writer's own parseMarkets: a market without it simply
 * gets no staleness check. Everything else throws, because a keeper booted against a bad
 * registry must fail loudly rather than silently watch a shorter list than the writer quotes. */
export function parseRegistryMarkets(json: string): { vault: Address; expiryMs?: number }[] {
  const parsed = JSON.parse(json) as { markets?: { vault?: string; expiryMs?: unknown }[] };
  if (!Array.isArray(parsed.markets)) throw new Error("registry has no markets array");
  if (parsed.markets.length === 0) throw new Error("registry lists no markets");
  return parsed.markets.map((m) => {
    if (typeof m?.vault !== "string" || !isAddress(m.vault)) {
      throw new Error(`invalid vault in registry: ${String(m?.vault)}`);
    }
    return {
      vault: m.vault as Address,
      expiryMs: typeof m.expiryMs === "number" ? m.expiryMs : undefined,
    };
  });
}
