"use client";

import { useState } from "react";
import { erc20Abi, formatUnits } from "viem";
import { useBalance, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { appChain, coreChain, HL_DRIP } from "@/lib/chain";
import { BRIDGE, bridgeGas, bridgeUsdc, GAS_TOPUP, quoteBridgeFees } from "@/lib/bridge";
import { formatUsdc, shortError, USDC_DECIMALS } from "@/lib/format";
import { tryParseStake } from "@/lib/ticket";

const DEFAULT_USDC = "5";

/** Moves USDC and gas from HyperEVM to the app chain through the canonical bridge: approve the
 * gateway, `outboundTransfer` on the router, `depositEth` on the Inbox, then switch the wallet
 * back. Funds land on the same address after about a minute; the balances above refetch on
 * their own, so the CTA turns into the pay buttons without a reload. */
export function BridgeStep({ address, needUsdc, needGas }: { address: `0x${string}`; needUsdc: bigint; needGas: boolean }) {
  const core = usePublicClient({ chainId: coreChain.id });
  const app = usePublicClient({ chainId: appChain.id });
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();
  const { data: coreUsdc } = useReadContract({ chainId: coreChain.id, address: BRIDGE.usdc, abi: erc20Abi, functionName: "balanceOf",
    args: [address], query: { refetchInterval: 15_000 } });
  const { data: coreGas } = useBalance({ chainId: coreChain.id, address, query: { refetchInterval: 15_000 } });
  const [amount, setAmount] = useState(needUsdc > 0n ? formatUnits(needUsdc, USDC_DECIMALS) : DEFAULT_USDC);
  const [state, setState] = useState<"idle" | "pending" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  const usdc = tryParseStake(amount);
  const noCoreUsdc = coreUsdc !== undefined && coreUsdc === 0n;
  const noCoreGas = coreGas !== undefined && coreGas.value === 0n;
  const tooMuch = usdc !== null && coreUsdc !== undefined && usdc > coreUsdc;
  const ready = !!core && !!app && state !== "pending" && !noCoreGas && (needGas || (usdc !== null && !tooMuch));

  async function run() {
    if (!core || !app || !ready) return;
    setState("pending");
    setError("");
    try {
      await switchChainAsync({ chainId: coreChain.id });
      const fees = await quoteBridgeFees(core, await app.getGasPrice());
      if (usdc !== null && usdc > 0n && !tooMuch) await bridgeUsdc({ core, write: writeContractAsync, taker: address, amount: usdc, fees });
      if (needGas) await bridgeGas({ core, write: writeContractAsync, taker: address, amount: GAS_TOPUP });
      setState("sent");
    } catch (err) {
      setError(shortError(err));
      setState("error");
    } finally {
      try { await switchChainAsync({ chainId: appChain.id }); } catch {} // wallet may already be back
    }
  }

  return (
    <div className="mt-4 flex flex-col gap-2 rounded-card border border-line p-3">
      <p className="mono text-[11px] uppercase tracking-[0.1em] text-dim">Bridge from {coreChain.name}</p>
      <p className="text-[12px] text-dim">
        Tickets mint on {appChain.name}. Your {coreChain.name} wallet holds {coreUsdc === undefined ? "…" : formatUsdc(coreUsdc)} USDC
        {coreGas ? ` and ${Number(formatUnits(coreGas.value, coreGas.decimals)).toFixed(4)} HYPE` : ""}. Bridging takes about a minute.
      </p>
      {(noCoreUsdc || noCoreGas) && (
        <a href={HL_DRIP} target="_blank" rel="noreferrer" className="text-[12px] underline decoration-line underline-offset-4">
          Get testnet USDC and HYPE at the Hyperliquid drip first, then move them from Core to EVM ↗
        </a>
      )}
      <label className="flex items-center gap-2 text-[12px]">
        <span className="text-dim">USDC</span>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          disabled={state === "pending"}
          className="mono w-28 rounded-[4px] border border-line bg-transparent px-2 py-1 text-fg"
        />
        {needGas && <span className="text-dim">+ {formatUnits(GAS_TOPUP, 18)} HYPE for gas</span>}
      </label>
      <button
        type="button"
        disabled={!ready}
        onClick={() => void run()}
        className="mono w-full rounded-card bg-accent py-[15px] text-center text-[12px] uppercase tracking-[0.1em] text-on-accent transition-transform disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none active:scale-[0.98] hover:opacity-90"
      >
        {state === "pending" ? "Confirm in wallet…" : state === "sent" ? "Sent - arriving on " + appChain.name + "…" : tooMuch ? "Not enough USDC on " + coreChain.name : "Bridge to " + appChain.name}
      </button>
      {state === "error" && <p className="text-[12px] text-no">{error}</p>}
    </div>
  );
}
