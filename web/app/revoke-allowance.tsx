"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePublicClient, useWriteContract } from "wagmi";
import { shortError } from "@/lib/format";
import { revokeUsdc } from "@/lib/ticket";
import { useUsdc, useWalletState } from "@/lib/wallet";
import { Button } from "@/components/ui/button";

const row = "flex w-full items-center justify-between gap-4 py-2 text-left text-[12px] normal-case tracking-normal";

/** Standing USDC allowance revoke: button, live status, error line. */
export function RevokeAllowance({ className = row }: { className?: string }) {
  const { address } = useWalletState();
  const { address: usdc } = useUsdc();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const [revoking, setRevoking] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [error, setError] = useState("");

  async function revoke() {
    if (!client || !usdc || !address) return;
    setRevoking("pending");
    try {
      await revokeUsdc({ client, write: writeContractAsync, usdc, taker: address, current: () => true });
      setRevoking("done");
      void queryClient.invalidateQueries();
    } catch (err) { setError(shortError(err)); setRevoking("error"); }
  }

  return (
    <>
      <Button variant="ghost" disabled={revoking === "pending"} onClick={() => void revoke()} className={`${className} h-auto px-0 font-normal text-dim hover:bg-transparent hover:text-fg`}>
        <span>Revoke USDC allowance</span>
        <span aria-live="polite" className="mono text-[11px]">{revoking === "pending" ? "Confirm in wallet…" : revoking === "done" ? "Revoked" : ""}</span>
      </Button>
      {revoking === "error" && <p className="mono text-[11px] text-no">{error}</p>}
    </>
  );
}
