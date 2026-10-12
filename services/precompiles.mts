/** HyperCore read precompiles, called the way CoreConstants.sol calls them on-chain: no function
 * selector, calldata is plain abi.encode of the arguments, return is plain abi.encode.
 *
 * Outcome coins: outcome `id` trades as two coins, `#<id*10>` (yes / participant A) and
 * `#<id*10 + 1>` (no / participant B). The 0x801 spot-balance and 0x808 spot-px precompiles
 * accept the encoded asset id `100000000 + coin` (since the 2026-08 testnet update; L1Read.sol).
 *
 * 0x801 reads return LIVE Core state even when the eth_call is pinned to an older block: "values
 * match Core state at block construction" holds only inside real block execution. Never use a
 * pinned read as a pre-op baseline; the keeper's resolveLiveBaseline samples ambiently instead. */

type Hex = `0x${string}`;
/** Structural subset of viem's PublicClient (services/ must not import viem). */
export interface PrecompileClient {
  call(args: { to: Hex; data: Hex }): Promise<{ data?: Hex }>;
}

export const SPOT_BALANCE_PRECOMPILE = "0x0000000000000000000000000000000000000801" as const;
export const SPOT_PX_PRECOMPILE = "0x0000000000000000000000000000000000000808" as const;
export const OUTCOME_STATUS_PRECOMPILE = "0x0000000000000000000000000000000000000814" as const;
export const OUTCOME_ACTIVE = 1;
export const OUTCOME_SETTLED = 2;
export const OUTCOME_PRUNED = 3;

export interface OutcomeStatus {
  status: number;
  settledValue: bigint;
  question: number;
}

export const outcomeCoin = (outcome: number, yes: boolean): string => `#${10 * outcome + (yes ? 0 : 1)}`;
export const encodedAssetId = (coinId: bigint): bigint => 100_000_000n + coinId;
export const encodedOutcomeAssetId = (outcome: number, yes: boolean): bigint =>
  encodedAssetId(10n * BigInt(outcome) + (yes ? 0n : 1n));

/** abi.encode of uint/address args: each one 32-byte left-padded word. */
const encode = (...args: (bigint | number | Hex)[]): Hex =>
  `0x${args.map((a) => (typeof a === "string" ? a.slice(2).toLowerCase() : BigInt(a).toString(16)).padStart(64, "0")).join("")}`;
const word = (data: Hex, i: number): bigint => {
  if (data.length < 2 + 64 * (i + 1)) throw new Error("short precompile response");
  return BigInt(`0x${data.slice(2 + 64 * i, 2 + 64 * (i + 1))}`);
};

/** Return is abi.encode(uint8 status, uint64 settledValue, uint32 question). */
export async function readOutcomeStatus(client: PrecompileClient, outcome: number): Promise<OutcomeStatus> {
  const { data } = await client.call({ to: OUTCOME_STATUS_PRECOMPILE, data: encode(outcome) });
  if (!data) throw new Error("empty outcomeStatus response");
  return { status: Number(word(data, 0)), settledValue: word(data, 1), question: Number(word(data, 2)) };
}

/** SpotBalance.total in Core wei (5-decimal for outcome coins); hold and entryNtl are dropped. */
export async function readSpotBalanceWei(client: PrecompileClient, user: Hex, token: bigint): Promise<bigint> {
  const { data } = await client.call({ to: SPOT_BALANCE_PRECOMPILE, data: encode(user, token) });
  if (!data) throw new Error("empty spotBalance response");
  return word(data, 0);
}

/** Core returns the px as a 1e8-scaled uint64, so WAD = raw * 1e10. 0x808 carries no timestamp. */
export async function readSpotPxWad(client: PrecompileClient, coinId: bigint): Promise<bigint> {
  const { data } = await client.call({ to: SPOT_PX_PRECOMPILE, data: encode(encodedAssetId(coinId)) });
  if (!data) throw new Error("empty spotPx response");
  return word(data, 0) * 10n ** 10n;
}
