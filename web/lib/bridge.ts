import { encodeAbiParameters, erc20Abi, parseAbi, parseEther, type PublicClient } from "viem";
import type { UseWriteContractReturnType } from "wagmi";
import { coreChain } from "./chain";
import { receiptOrThrow } from "./ticket";

/** Elysium testnet's canonical Arbitrum bridge, on HyperEVM testnet (998). */
export const BRIDGE = {
  inbox: "0x11178Df40CBf87a4343f4B3F8B09B366ceFA8Ec0",
  router: "0x1aAE2caD8B0249905492087EF230FcCEa3707C45",
  gateway: "0x792487eF5E423104bec94e8c58E814e5E0450cEA",
  usdc: "0x2B3370eE501B4a559b57D449569354196457D8Ab",
} as const;

const inboxAbi = parseAbi([
  "function depositEth() payable returns (uint256)",
  "function calculateRetryableSubmissionFee(uint256 dataLength, uint256 baseFee) view returns (uint256)",
]);
const routerAbi = parseAbi([
  "function outboundTransfer(address token, address to, uint256 amount, uint256 maxGas, uint256 gasPriceBid, bytes data) payable returns (bytes)",
]);

export const BRIDGE_GAS = 300_000n;
/** Upper bound on the retryable's calldata; the fee is per byte and refunds the excess. */
const BRIDGE_DATA_LENGTH = 512n;
/** HYPE moved for gas in one go: months of 0.01 gwei Elysium transactions. */
export const GAS_TOPUP = parseEther("0.01");

/** Stock retryable pricing for one deposit: submission fee and Elysium gas both doubled so a
 * basefee move cannot strand the ticket; the excess refunds to the same address on Elysium. */
export function bridgeFees(submissionFee: bigint, l2GasPrice: bigint): {
  maxSubmissionCost: bigint; maxGas: bigint; gasPriceBid: bigint; value: bigint;
} {
  const maxSubmissionCost = submissionFee * 2n;
  const gasPriceBid = l2GasPrice * 2n;
  return { maxSubmissionCost, maxGas: BRIDGE_GAS, gasPriceBid, value: maxSubmissionCost + BRIDGE_GAS * gasPriceBid };
}

export function outboundData(maxSubmissionCost: bigint): `0x${string}` {
  return encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [maxSubmissionCost, "0x"]);
}

export async function quoteBridgeFees(core: PublicClient, l2GasPrice: bigint) {
  // Quote at the live 998 basefee: this Inbox returns 0 for baseFee 0 instead of substituting
  // block.basefee, and a 0 maxSubmissionCost makes the ticket revert on chain.
  const { baseFeePerGas } = await core.getBlock();
  const fee = await core.readContract({ address: BRIDGE.inbox, abi: inboxAbi, functionName: "calculateRetryableSubmissionFee", args: [BRIDGE_DATA_LENGTH, baseFeePerGas ?? 1_000_000_000n] });
  return bridgeFees(fee, l2GasPrice);
}

type Write = UseWriteContractReturnType["writeContractAsync"];

async function confirmed(core: PublicClient, hash: `0x${string}`, what: string): Promise<`0x${string}`> {
  await receiptOrThrow(core, hash, `${what} reverted`);
  return hash;
}

export async function bridgeUsdc({ core, write, taker, amount, fees }: {
  core: PublicClient; write: Write; taker: `0x${string}`; amount: bigint; fees: ReturnType<typeof bridgeFees>;
}): Promise<`0x${string}`> {
  const allowance = await core.readContract({ address: BRIDGE.usdc, abi: erc20Abi, functionName: "allowance", args: [taker, BRIDGE.gateway] });
  if (allowance < amount) {
    await confirmed(core, await write({ address: BRIDGE.usdc, abi: erc20Abi, functionName: "approve", args: [BRIDGE.gateway, amount], account: taker, chainId: coreChain.id }), "approve");
  }
  const hash = await write({ address: BRIDGE.router, abi: routerAbi, functionName: "outboundTransfer",
    args: [BRIDGE.usdc, taker, amount, fees.maxGas, fees.gasPriceBid, outboundData(fees.maxSubmissionCost)],
    value: fees.value, account: taker, chainId: coreChain.id });
  return confirmed(core, hash, "bridge");
}

export async function bridgeGas({ core, write, taker, amount }: { core: PublicClient; write: Write; taker: `0x${string}`; amount: bigint }): Promise<`0x${string}`> {
  const hash = await write({ address: BRIDGE.inbox, abi: inboxAbi, functionName: "depositEth", value: amount, account: taker, chainId: coreChain.id });
  return confirmed(core, hash, "gas deposit");
}
