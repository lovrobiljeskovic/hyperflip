"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { appChain, explorerAddress } from "@/lib/chain";
import { shortAddress, shortError } from "@/lib/format";
import { revokeUsdc } from "@/lib/ticket";
import { useDisconnectAction, useUsdc, useWalletState } from "@/lib/wallet";
import { OddsFormatToggle } from "./odds-format-toggle";

const row = "flex w-full items-center justify-between gap-4 py-2 text-left text-[12px] normal-case tracking-normal";

/** Hamburger rows under the nav links: odds format, wallet facts, chain, allowance, disconnect. */
export function WalletMenu() {
  const { address, isConnected } = useWalletState();
  const { chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const disconnect = useDisconnectAction();
  const { address: usdc } = useUsdc();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [revoking, setRevoking] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const wrongChain = chainId !== undefined && chainId !== appChain.id;
  const explorer = address ? explorerAddress(address) : null;

  async function revoke() {
    if (!client || !usdc || !address) return;
    setRevoking("pending");
    try { await revokeUsdc({ client, write: writeContractAsync, usdc, taker: address, current: () => true }); setRevoking("done"); }
    catch (err) { setError(shortError(err)); setRevoking("error"); }
  }

  return (
    <div className="flex flex-col border-t border-line pt-2">
      <div className={row}><span className="text-dim">Odds format</span><OddsFormatToggle /></div>
      {isConnected && address && (
        <>
          <div className={row}><span className="text-dim">Wallet</span>
            {explorer ? <a href={explorer} target="_blank" rel="noreferrer" className="mono text-fg">{shortAddress(address)} ↗</a> : <span className="mono">{shortAddress(address)}</span>}
          </div>
          <div className={row}><span className="text-dim">Network</span><span className={`mono ${wrongChain ? "text-no" : ""}`}>{wrongChain ? `chain ${chainId}` : appChain.name}</span></div>
          {wrongChain && <button type="button" onClick={() => switchChain({ chainId: appChain.id })} className={`${row} text-accent`}>Switch to {appChain.name}</button>}
          <button type="button" disabled={revoking === "pending"} onClick={() => void revoke()} className={`${row} text-dim hover:text-fg`}>
            <span>Revoke USDC allowance</span><span className="mono text-[11px]">{revoking === "pending" ? "Confirm in wallet…" : revoking === "done" ? "Revoked" : ""}</span>
          </button>
          {revoking === "error" && <p className="mono text-[11px] text-no">{error}</p>}
          <button type="button" onClick={() => disconnect()} className={`${row} text-no`}>Disconnect</button>
        </>
      )}
    </div>
  );
}
