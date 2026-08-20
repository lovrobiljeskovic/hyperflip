"use client";

import { usePrivy } from "@privy-io/react-auth";
import { erc20Abi } from "viem";
import { useAccount, useDisconnect, useReadContract } from "wagmi";
import { PARLAY_VAULT, parlayVaultAbi } from "./contracts";

// @privy-io/wagmi's WagmiProvider only mounts when NEXT_PUBLIC_PRIVY_APP_ID is
// set (see app/providers.tsx); usePrivy() throws without a PrivyProvider
// ancestor. PRIVY_ENABLED is a build-time constant (inlined by Next.js), so it
// never changes across a running instance's renders — safe to branch a hook
// call on it.
const PRIVY_ENABLED = !!process.env.NEXT_PUBLIC_PRIVY_APP_ID;

/** Click handler for every "Connect wallet" button.
 *
 * Privy's auth session survives a reload, but an external wallet's *connection*
 * does not: after a refresh the user is `authenticated` with a linked wallet
 * while useWallets() (and therefore wagmi) has no account, so the UI still
 * gates on wagmi's isConnected. In that state login() is a no-op — Privy logs
 * "Attempted to log in, but user is already logged in" and the button does
 * nothing. connectWallet() is the path that re-establishes the connection and
 * lets @privy-io/wagmi's sync hook wire it into wagmi. */
export function useConnectAction(): () => void {
  if (!PRIVY_ENABLED) return () => {};
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { authenticated, login, connectWallet } = usePrivy();
  return () => (authenticated ? connectWallet() : login());
}

/** Click handler for "Disconnect". Privy owns the session, so logout() is the
 * one that actually clears it — wagmi's disconnect alone leaves the user
 * authenticated and silently reconnected on the next render. */
export function useDisconnectAction(): () => void {
  const { disconnect } = useDisconnect();
  if (!PRIVY_ENABLED) return () => disconnect();
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { logout } = usePrivy();
  return () => {
    disconnect();
    void logout();
  };
}

/** USDC token address + the connected wallet's balance, read through the vault
 * so the token never has to be configured twice. */
export function useUsdc(): { address?: `0x${string}`; balance?: bigint } {
  const { address: account } = useAccount();
  const { data: token } = useReadContract({
    address: PARLAY_VAULT,
    abi: parlayVaultAbi,
    functionName: "usdc",
  });
  const { data: balance } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    query: { enabled: !!token && !!account, refetchInterval: 15_000 },
  });
  return { address: token, balance };
}
