"use client";

import { useEffect, useRef, useState } from "react";
import { BRIDGED, HL_DRIP } from "@/lib/chain";
import { formatUsdc } from "@/lib/format";
import { useConnectAction, useUsdc, useWalletState } from "@/lib/wallet";
import { BridgeStep } from "@/app/(trading)/build/bridge-step";

/** Balance plus Deposit. Deposit is the faucet on 998 and the bridge on a bridged lane. */
export function FundsChip() {
  const { ready, isConnected, address } = useWalletState();
  const connect = useConnectAction();
  const { balance } = useUsdc();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  if (!ready) return <div className="h-9 w-32 animate-pulse rounded-full bg-panel motion-reduce:animate-none" aria-hidden />;
  if (!isConnected || !address) {
    return (
      <button type="button" onClick={() => connect()} className="rounded-full bg-accent px-4 py-2 text-[13px] font-medium text-on-accent transition-transform active:scale-[0.98] motion-reduce:transition-none">
        Connect wallet
      </button>
    );
  }
  const deposit = "rounded-full bg-accent px-3 py-1 text-[11px] font-semibold text-on-accent transition-transform active:scale-[0.98] motion-reduce:transition-none";
  return (
    <div className="mono flex items-center gap-2 rounded-full border border-line py-1 pl-3 pr-1 text-[12px] text-fg">
      <span aria-label="USDC balance">${balance === undefined ? "–" : formatUsdc(balance)}</span>
      {BRIDGED ? (
        <button type="button" onClick={() => setOpen(true)} className={deposit}>Deposit</button>
      ) : (
        <a href={HL_DRIP} target="_blank" rel="noreferrer" className={deposit}>Deposit</a>
      )}
      {BRIDGED && (
        <dialog ref={ref} onClose={() => setOpen(false)} onClick={(e) => e.target === e.currentTarget && setOpen(false)}
          className="m-auto w-[min(100%-2rem,420px)] rounded-card border border-line bg-panel p-4 text-fg backdrop:bg-ink/80">
          <BridgeStep address={address} needUsdc={0n} needGas={false} />
          <button type="button" onClick={() => setOpen(false)} className="mono mt-3 w-full py-1 text-[11px] text-dim hover:text-fg">Close</button>
        </dialog>
      )}
    </div>
  );
}
