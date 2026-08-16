import { decodeAbiParameters, encodeAbiParameters, type PublicClient } from "viem";

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
