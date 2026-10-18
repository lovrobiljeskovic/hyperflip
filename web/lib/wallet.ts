"use client";

import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useEffect, useState } from "react";
import { erc20Abi } from "viem";
import { useAccount, useDisconnect, useReadContract } from "wagmi";
import { appChain } from "./chain";
import { PARLAY_VAULT, parlayVaultAbi } from "./contracts";

// PRIVY_ENABLED is a build-time constant (inlined by Next.js), so branching hooks on it is safe;
// usePrivy() throws without a PrivyProvider, which only mounts when NEXT_PUBLIC_PRIVY_APP_ID is set.
const PRIVY_ENABLED = !!process.env.NEXT_PUBLIC_PRIVY_APP_ID;

/** What every connection-dependent branch renders from. Privy restores asynchronously and
 * @privy-io/wagmi mirrors into wagmi a tick later, so wagmi's `isConnected` is false for the first
 * frames; `ready` holds a neutral placeholder until both have landed. */
export function useWalletState(): {
  ready: boolean;
  isConnected: boolean;
  address?: `0x${string}`;
  isLinked: boolean;
  accountId?: string;
} {
  const { address, isConnected } = useAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Wallet providers can restore synchronously in the browser, while SSR can
  // only render the disconnected placeholder. Hold both to that placeholder
  // through the first client render so their hydration trees stay identical.
  if (!PRIVY_ENABLED) return { ready: mounted, isConnected, address, isLinked: false };
  const { ready: privyReady, user, authenticated } = usePrivy();
  const { ready: walletsReady, wallets } = useWallets();
  const [timedOut, setTimedOut] = useState(false);

  const syncing = privyReady && walletsReady && wallets.length > 0 && !isConnected;

  useEffect(() => {
    if (!syncing) return;
    // ponytail: fixed failsafe. If the Privy-to-wagmi sync never lands, show
    // the disconnected UI instead of an eternal placeholder.
    const t = setTimeout(() => setTimedOut(true), 2_000);
    return () => clearTimeout(t);
  }, [syncing]);

  return {
    ready: mounted && ((privyReady && walletsReady && !syncing) || timedOut),
    isConnected,
    address,
    accountId: user?.id,
    isLinked: authenticated && !!user?.linkedAccounts.some(a => a.type === "wallet" && a.chainType === "ethereum" && a.address.toLowerCase() === address?.toLowerCase()),
  };
}

/** After a reload Privy is `authenticated` but wagmi has no account, and login() is a no-op
 * ("already logged in"); connectWallet() re-establishes the connection. */
export function useConnectAction(): () => void {
  if (!PRIVY_ENABLED) return () => {};
  const { authenticated, login, connectWallet, linkWallet, user } = usePrivy();
  const { address, isConnected } = useAccount();
  const linked = user?.linkedAccounts.some(a => a.type === "wallet" && a.address.toLowerCase() === address?.toLowerCase());
  return () => !authenticated ? login({ loginMethods: ["wallet"] }) : isConnected && !linked ? linkWallet() : connectWallet();
}

/** Privy owns the session: wagmi's disconnect alone leaves the user authenticated and reconnected. */
export function useDisconnectAction(): () => void {
  const { disconnect } = useDisconnect();
  if (!PRIVY_ENABLED) return () => disconnect();
  const { logout } = usePrivy();
  return () => {
    disconnect();
    void logout().catch(() => {});
  };
}

export function useUsdc(): { address?: `0x${string}`; balance?: bigint; error: boolean } {
  const { address: account } = useAccount();
  const { data: token, isError: error } = useReadContract({
    address: PARLAY_VAULT,
    abi: parlayVaultAbi,
    functionName: "usdc",
    chainId: appChain.id,
  });
  const { data: balance } = useReadContract({
    chainId: appChain.id,
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    query: { enabled: !!token && !!account, refetchInterval: 15_000 },
  });
  return { address: token, balance, error };
}
