"use client";

import { useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { useAccount, useBalance, useSwitchChain } from "wagmi";
import { hyperEvmTestnet } from "@/lib/chain";
import { formatUsdc, shortAddress } from "@/lib/format";
import { useConnectAction, useDisconnectAction, useUsdc, useWalletState } from "@/lib/wallet";
import { HyperflipMark } from "./brand";

const EXPLORER = hyperEvmTestnet.blockExplorers.default.url;

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
      <button
        type="button"
        onClick={() => connect()}
        className="rounded-card bg-accent px-4 py-1.5 text-sm font-medium text-on-accent transition-transform motion-reduce:transition-none active:scale-[0.98] hover:opacity-90"
      >
        Connect wallet
      </button>
    );
  }

  const wrongChain = chainId !== undefined && chainId !== hyperEvmTestnet.id;

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
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex items-center gap-2 rounded-card border border-line bg-panel py-2 px-3.5 mono text-xs text-fg transition-colors hover:border-dim"
      >
        <span
          className={`inline-block size-1.5 rounded-full ${wrongChain ? "bg-no" : "bg-yes"}`}
          aria-hidden
        />
        {wrongChain ? "Wrong network" : shortAddress(address)}
      </button>

      {open && (
        <>
          {/* click-outside catcher - cheaper than a document listener */}
          <button
            type="button"
            aria-label="Close wallet menu"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-20 cursor-default"
          />
          <div
            role="dialog"
            aria-label="Wallet"
            className="absolute right-0 z-30 mt-2 w-72 rounded-card border border-line bg-panel p-4 text-xs shadow-[0_24px_60px_rgba(4,10,12,0.6)]"
          >
            <div className="mb-3 flex items-center gap-2 border-b border-line pb-3">
              <HyperflipMark className="size-5" />
              <span className="display text-sm">hyperflip wallet</span>
            </div>
            <p className="break-all mono text-[11px] leading-relaxed text-fg">{address}</p>

            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => void copy()}
                className="flex-1 rounded-[4px] border border-line px-2 py-1 mono text-[11px] text-dim transition-colors hover:text-fg"
              >
                {copied ? "Copied" : "Copy address"}
              </button>
              <a
                href={`${EXPLORER}/address/${address}`}
                target="_blank"
                rel="noreferrer"
                className="flex-1 rounded-[4px] border border-line px-2 py-1 text-center mono text-[11px] text-dim transition-colors hover:text-fg"
              >
                Explorer ↗
              </a>
            </div>

            <div className="mt-4 flex flex-col gap-2 border-t border-line pt-3">
              <Row label="USDC">{usdc === undefined ? "-" : formatUsdc(usdc)}</Row>
              <Row label="HYPE (gas)">
                {native ? Number(formatUnits(native.value, native.decimals)).toFixed(4) : "-"}
              </Row>
              <Row label="Network">
                <span className={wrongChain ? "text-no" : "text-dim"}>
                  {wrongChain ? `chain ${chainId}` : hyperEvmTestnet.name}
                </span>
              </Row>
            </div>

            {wrongChain && (
              <button
                type="button"
                onClick={() => switchChain({ chainId: hyperEvmTestnet.id })}
                className="mt-3 w-full rounded-[4px] bg-accent py-1.5 text-center font-medium text-on-accent transition-opacity hover:opacity-90"
              >
                Switch to {hyperEvmTestnet.name}
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                setOpen(false);
                disconnect();
              }}
              className="mt-3 w-full rounded-[4px] border border-no/40 py-1.5 text-center mono text-[11px] text-no transition-colors hover:bg-no/10"
            >
              Disconnect
            </button>
          </div>
        </>
      )}
    </div>
  );
}
