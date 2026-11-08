"use client";

import { useAccount, useSwitchChain } from "wagmi";
import { appChain, explorerAddress } from "@/lib/chain";
import { shortAddress } from "@/lib/format";
import { useDisconnectAction, useLinkX, useWalletState } from "@/lib/wallet";
import { RevokeAllowance } from "./revoke-allowance";
import { OddsFormatToggle } from "./odds-format-toggle";
import { Button } from "@/components/ui/button";

const row = "flex w-full items-center justify-between gap-4 py-2 text-left text-[12px] normal-case tracking-normal";

export function WalletMenu() {
  const { address, isConnected } = useWalletState();
  const { chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const disconnect = useDisconnectAction();
  const x = useLinkX();
  const wrongChain = chainId !== undefined && chainId !== appChain.id;
  const explorer = address ? explorerAddress(address) : null;

  return (
    <div className="flex flex-col border-t border-line pt-2">
      <div className={row}><span className="text-dim">Odds format</span><OddsFormatToggle /></div>
      {isConnected && address && (
        <>
          <div className={row}><span className="text-dim">Wallet</span>
            {explorer ? <a href={explorer} target="_blank" rel="noreferrer" className="mono text-fg">{shortAddress(address)} ↗</a> : <span className="mono">{shortAddress(address)}</span>}
          </div>
          {(x.handle || x.canLink) && (
            <div className={row}><span className="text-dim">X</span>
              {x.handle
                ? <a href={`https://x.com/${x.handle}`} target="_blank" rel="noreferrer" className="mono text-fg">@{x.handle} ↗</a>
                : <button type="button" onClick={x.link} className="mono text-accent">Link X</button>}
            </div>
          )}
          <div className={row}><span className="text-dim">Network</span><span className={`mono ${wrongChain ? "text-no" : ""}`}>{wrongChain ? `chain ${chainId}` : appChain.name}</span></div>
          {wrongChain && <Button variant="ghost" onClick={() => switchChain({ chainId: appChain.id })} className={`${row} h-auto justify-start px-0 text-accent`}>Switch to {appChain.name}</Button>}
          <RevokeAllowance />
          <Button variant="ghost" onClick={() => disconnect()} className={`${row} h-auto justify-start px-0 text-no hover:text-no`}>Disconnect</Button>
        </>
      )}
    </div>
  );
}
