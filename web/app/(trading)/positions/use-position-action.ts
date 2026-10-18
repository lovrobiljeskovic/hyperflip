"use client";

import { useEffect, useRef, useState } from "react";
import type { PublicClient, TransactionReceipt } from "viem";
import type { UseWriteContractReturnType } from "wagmi";
import { deriveRow, loadRow, type Row } from "@/lib/positions";
import { PARLAY_VAULT, parlayVaultAbi } from "@/lib/contracts";
import { shortError } from "@/lib/format";
import { appChain } from "@/lib/chain";
import { rememberPosition } from "@/lib/position-receipts";
import { receiptOrThrow } from "@/lib/ticket";

export function usePositionAction(
  publicClient: PublicClient | undefined,
  address: `0x${string}` | undefined,
  writeContractAsync: UseWriteContractReturnType["writeContractAsync"],
  reloadRow: (row: Row, receipt: TransactionReceipt) => Promise<void>,
) {
  const actionInFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [pending, setPending] = useState<{ id: bigint; kind: "claim" | "resolve" } | null>(null);
  const [actionError, setActionError] = useState<{ id: bigint; msg: string } | null>(null);

  async function act(row: Row, kind: "claim" | "resolve") {
    const id = row.id;
    if (!publicClient || !address || actionInFlight.current) return;
    actionInFlight.current = true;
    setPending({ id, kind });
    setActionError(null);
    try {
      const fresh = await loadRow(publicClient, row);
      if (deriveRow(fresh, address).action?.kind !== kind) throw new Error("Position changed. Refresh before trying again.");
      await publicClient.simulateContract({ address: PARLAY_VAULT, abi: parlayVaultAbi,
        functionName: kind === "claim" ? "claim" : "resolveParlay", args: [id], account: address });
      const hash = await writeContractAsync({
        address: PARLAY_VAULT,
        abi: parlayVaultAbi,
        functionName: kind === "claim" ? "claim" : "resolveParlay",
        args: [id],
        account: address,
        chainId: appChain.id,
      });
      const receipt = await receiptOrThrow(publicClient, hash, "Transaction reverted; retry after refreshing the position.");
      rememberPosition(address, receipt, kind, id, row.block);
      if (!mounted.current) return;
      await reloadRow(row, receipt);
    } catch (err) {
      if (mounted.current) setActionError({ id, msg: shortError(err) });
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setPending(null);
    }
  }

  return { pending, actionError, act };
}
