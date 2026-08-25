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
 * Returns SpotBalance.total in Core wei (5-decimal for outcome coins). `blockNumber` pins the
 * read: precompile values are guaranteed to match Core state at that block's construction, which
 * is what makes a read pinned to an OpQueued block provably pre-execution (Core cannot execute
 * an action before the block containing it exists). */
export async function readSpotBalanceWei(
  client: Pick<PublicClient, "call">,
  user: Address,
  token: bigint,
  blockNumber?: bigint,
): Promise<bigint> {
  const data = encodeAbiParameters([{ type: "address" }, { type: "uint64" }], [user, token]);
  const { data: ret } = await client.call({ to: SPOT_BALANCE_PRECOMPILE, data, blockNumber });
  if (!ret) throw new Error("empty spotBalance response");
  const [total] = decodeAbiParameters([{ type: "uint64" }, { type: "uint64" }, { type: "uint64" }], ret);
  return total;
}
