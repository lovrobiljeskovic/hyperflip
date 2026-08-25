import { decodeAbiParameters, encodeAbiParameters, type PublicClient } from "viem";

/** L1Read.sol SPOT_PX_PRECOMPILE_ADDRESS — accepts the encoded outcome asset id
 * 100000000 + coin id (= 10*outcome + side) since the 2026-08 testnet update. */
export const SPOT_PX_PRECOMPILE = "0x0000000000000000000000000000000000000808" as const;

/** Raw 0x808 read for an outcome coin, scaled to WAD. Core returns the px as a 1e8-scaled
 * uint64 (testnet-verified against l2Book mids 2026-08-25), so WAD = raw * 1e10. Latest state
 * only — pinned precompile eth_calls return live Core state (see keeper spec "Historical
 * reads"), which is fine here: a quote wants the freshest px there is. */
export async function readSpotPxWad(client: Pick<PublicClient, "call">, coinId: bigint): Promise<bigint> {
  const data = encodeAbiParameters([{ type: "uint32" }], [Number(100_000_000n + coinId)]);
  const { data: ret } = await client.call({ to: SPOT_PX_PRECOMPILE, data });
  if (!ret) throw new Error("empty spotPx response");
  const [raw] = decodeAbiParameters([{ type: "uint64" }], ret);
  return raw * 10n ** 10n;
}
