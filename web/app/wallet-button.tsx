"use client";

import { useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { useAccount, useBalance, useSwitchChain } from "wagmi";
import { appChain, explorerAddress } from "@/lib/chain";
import { formatUsdc, shortAddress } from "@/lib/format";
import { useConnectAction, useDisconnectAction, useUsdc, useWalletState } from "@/lib/wallet";
import { HyperflipLogo } from "./brand";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RevokeAllowance } from "./revoke-allowance";


function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-dim">{label}</span>
      <span className="mono">{children}</span>
    </div>
  );
}

export function WalletButton() {
  const { ready, address, isConnected } = useWalletState();
  const { chainId } = useAccount();
  const connect = useConnectAction();
  const disconnect = useDisconnectAction();
  const { switchChain } = useSwitchChain();
  const { balance: usdc } = useUsdc();
  const { data: native } = useBalance({ address, query: { enabled: !!address } });

  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (copyTimer.current && clearTimeout(copyTimer.current)), []);

  // Popover only exists while connected - closing it on disconnect keeps a
  // stale panel from hanging over the "Connect wallet" button.
  useEffect(() => {
    if (!isConnected) setOpen(false);
  }, [isConnected]);

  // Placeholder holds the button's footprint while Privy restores its session,
  // so a connected user never sees "Connect wallet" flash first.
  if (!ready) {
    return <div className="h-[34px] w-[132px] animate-pulse motion-reduce:animate-none rounded-card bg-panel" aria-hidden />;
  }

  if (!isConnected || !address) {
    return (
      <Button onClick={() => connect()} className="h-[34px] px-4 text-sm">Connect wallet</Button>
    );
  }

  const wrongChain = chainId !== undefined && chainId !== appChain.id;
  const explorer = address ? explorerAddress(address) : null;

  async function copy() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (insecure context / denied) - leave the label alone */
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="mono h-[34px] gap-2 border-line bg-panel px-3.5 text-xs text-fg">
          <span className={`inline-block size-1.5 rounded-full ${wrongChain ? "bg-no" : "bg-yes"}`} aria-hidden />
          {wrongChain ? "Wrong network" : shortAddress(address)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Wallet" className="w-72 border border-line bg-panel p-4 font-sans text-xs text-fg shadow-[0_24px_60px_rgba(4,10,12,0.6)] ring-0">
            <div className="mb-3 flex items-center gap-2 border-b border-line pb-3">
              <HyperflipLogo className="size-5" />
              <span className="display text-sm">hyperflip wallet</span>
            </div>
            <p className="break-all mono text-[11px] leading-relaxed text-fg">{address}</p>

            <div className="mt-3 flex gap-2">
              <Button variant="outline" size="sm" onClick={() => void copy()} className="mono flex-1 border-line text-[11px] text-dim">{copied ? "Copied" : "Copy address"}</Button>
              {explorer && (
                <Button variant="outline" size="sm" asChild className="mono flex-1 border-line text-[11px] text-dim"><a href={explorer} target="_blank" rel="noreferrer">Explorer ↗</a></Button>
              )}
            </div>

            <div className="mt-4 flex flex-col gap-2 border-t border-line pt-3">
              <Row label="USDC">{usdc === undefined ? "-" : formatUsdc(usdc)}</Row>
              <Row label="HYPE (gas)">
                {native ? Number(formatUnits(native.value, native.decimals)).toFixed(4) : "-"}
              </Row>
              <Row label="Network">
                <span className={wrongChain ? "text-no" : "text-dim"}>
                  {wrongChain ? `chain ${chainId}` : appChain.name}
                </span>
              </Row>
            </div>

            {wrongChain && (
              <Button size="sm" onClick={() => switchChain({ chainId: appChain.id })} className="mt-3 w-full">Switch to {appChain.name}</Button>
            )}

            <RevokeAllowance className="mt-3 flex w-full items-center justify-between gap-4 text-left" />

            <Button variant="destructive" size="sm" onClick={() => { setOpen(false); disconnect(); }} className="mono mt-3 w-full text-[11px]">Disconnect</Button>
      </PopoverContent>
    </Popover>
  );
}
