import { decodeAbiParameters, encodeAbiParameters, type Address, type PublicClient } from "viem";

/** CoreConstants.OUTCOME_STATUS_PRECOMPILE. */
export const OUTCOME_STATUS_PRECOMPILE = "0x0000000000000000000000000000000000000814" as const;
export const OUTCOME_ACTIVE = 1;
export const OUTCOME_SETTLED = 2;
export const OUTCOME_PRUNED = 3;

export interface OutcomeStatus {
  status: number;
  settledValue: bigint;
  question: number;
}

/** Raw precompile call — the same request CoreConstants.outcomeStatus makes on-chain (and that
 * OutcomeVault.settle() reads): no function selector, calldata is plain abi.encode(uint32
 * outcome), return is abi.encode(uint8 status, uint64 settledValue, uint32 question). */
export async function readOutcomeStatus(client: PublicClient, outcome: number): Promise<OutcomeStatus> {
  const data = encodeAbiParameters([{ type: "uint32" }], [outcome]);
  const { data: ret } = await client.call({ to: OUTCOME_STATUS_PRECOMPILE, data });
  if (!ret) throw new Error("empty outcomeStatus response");
  const [status, settledValue, question] = decodeAbiParameters(
    [{ type: "uint8" }, { type: "uint64" }, { type: "uint32" }],
    ret,
  );
  return { status: Number(status), settledValue, question: Number(question) };
}

/** CoreConstants.SPOT_BALANCE_PRECOMPILE. */
export const SPOT_BALANCE_PRECOMPILE = "0x0000000000000000000000000000000000000801" as const;

/** Raw 0x801 read — the same request CoreConstants.spotBalance makes on-chain. `token` accepts
 * the encoded outcome asset id (pure.ts encodedOutcomeAssetId) since the 2026-08 testnet update.
 * Returns SpotBalance.total in Core wei (5-decimal for outcome coins), read at latest state only.
 * "Precompile values match Core state at block construction" holds only INSIDE real block
 * execution (e.g. a contract reading 0x801 mid-tx); a pinned `eth_call` via RPC does not replay
 * that block — it returns LIVE Core state regardless of the block number given (0x809 probe,
 * 2026-08-25, see spec "Historical reads"). So this function must never be used to claim a
 * pre-op baseline by pinning it to an OpQueued block; see keeper.ts resolveLiveBaseline for how
 * pre-op baselines are actually established (ambient sampling, not a pinned read). */
export async function readSpotBalanceWei(
  client: Pick<PublicClient, "call">,
  user: Address,
  token: bigint,
): Promise<bigint> {
  const data = encodeAbiParameters([{ type: "address" }, { type: "uint64" }], [user, token]);
  const { data: ret } = await client.call({ to: SPOT_BALANCE_PRECOMPILE, data });
  if (!ret) throw new Error("empty spotBalance response");
  const [total] = decodeAbiParameters([{ type: "uint64" }, { type: "uint64" }, { type: "uint64" }], ret);
  return total;
}
