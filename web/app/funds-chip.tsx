"use client";

import { useState } from "react";
import { BRIDGED, HL_DRIP } from "@/lib/chain";
import { formatUsdc } from "@/lib/format";
import { useConnectAction, useUsdc, useWalletState } from "@/lib/wallet";
import { BridgeStep } from "@/app/(trading)/build/bridge-step";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** `connect={false}` renders nothing while disconnected (desktop, where WalletButton has Connect). */
export function FundsChip({ connect: showConnect = true }: { connect?: boolean }) {
  const { ready, isConnected, address } = useWalletState();
  const connect = useConnectAction();
  const { balance } = useUsdc();
  const [open, setOpen] = useState(false);

  if (!showConnect && (!ready || !isConnected || !address)) return null;
  if (!ready) return <div className="h-9 w-32 animate-pulse rounded-full bg-panel motion-reduce:animate-none" aria-hidden />;
  if (!isConnected || !address) {
    return <Button onClick={() => connect()} className="h-9 rounded-full px-4 text-[13px]">Connect wallet</Button>;
  }
  const deposit = "h-7 rounded-full px-3 text-[11px] font-semibold";
  return (
    <div className="mono flex items-center gap-2 rounded-full border border-line py-1 pl-3 pr-1 text-[12px] text-fg">
      <span><span className="sr-only">USDC balance </span>${balance === undefined ? "–" : formatUsdc(balance)}</span>
      {BRIDGED ? (
        <Button size="sm" onClick={() => setOpen(true)} className={deposit}>Deposit</Button>
      ) : (
        <Button size="sm" asChild className={deposit}><a href={HL_DRIP} target="_blank" rel="noreferrer">Deposit<span className="sr-only"> (opens in a new tab)</span></a></Button>
      )}
      {BRIDGED && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="font-sans border-line bg-panel text-[13px] text-fg">
            <DialogHeader>
              <DialogTitle className="display text-[18px] font-normal">Deposit</DialogTitle>
              <DialogDescription>Move USDC and gas from HyperEVM to this chain.</DialogDescription>
            </DialogHeader>
            {open && <BridgeStep address={address} needUsdc={0n} needGas={false} />}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
