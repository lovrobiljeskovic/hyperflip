"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider, createConfig } from "@privy-io/wagmi";
import { WagmiProvider as WagmiProviderNoPrivy, createConfig as createWagmiConfigNoPrivy } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http } from "viem";
import { appChain, BRIDGED, coreChain } from "@/lib/chain";

// The bridge step signs on HyperEVM, so the wallet needs both chains when the vault is on Elysium.
const chains = BRIDGED ? ([appChain, coreChain] as const) : ([appChain] as const);
// batch: Elysium has no Multicall3 but its RPC accepts JSON-RPC batches; one request per tick
// instead of a burst of ~6 per position row. App-chain reads go through /api/rpc so the keyed
// Elysium URL stays server-side: the public endpoint rejects ~7 calls per burst (-32017).
// The core transport exists only when bridged: on 998 the two ids are equal and a second key
// would overwrite the proxy with the public URL (2026-10-17: the 998 lane never used /api/rpc).
const transports = {
  [appChain.id]: http("/api/rpc", { batch: true, retryCount: 6, retryDelay: 2_000 }),
  ...(BRIDGED ? { [coreChain.id]: http(undefined, { batch: true, retryCount: 6, retryDelay: 2_000 }) } : {}),
};

const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

// Fallback config for when no Privy app id is set (below): @privy-io/wagmi's
// WagmiProvider renders a connector that calls @privy-io/react-auth hooks
// internally, which throw without a PrivyProvider ancestor. Plain wagmi's
// WagmiProvider needs no such ancestor - same chain, zero connectors, so
// wagmi hooks (useAccount, usePublicClient, useReadContract, ...) resolve
// instead of crashing, with wallet-connect features simply inert.
// Only the config the app id selects is built.
const wagmiConfig = privyAppId ? createConfig({ chains, transports }) : null;
const wagmiConfigNoPrivy = privyAppId ? null : createWagmiConfigNoPrivy({ chains, transports });

const queryClient = new QueryClient();

export function Providers({ children }: { children: React.ReactNode }) {
  if (wagmiConfigNoPrivy) {
    return (
      <QueryClientProvider client={queryClient}>
        <WagmiProviderNoPrivy config={wagmiConfigNoPrivy}>{children}</WagmiProviderNoPrivy>
      </QueryClientProvider>
    );
  }

  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        loginMethods: ["wallet"],
        embeddedWallets: { ethereum: { createOnLogin: "off" }, solana: { createOnLogin: "off" } },
        defaultChain: appChain,
        supportedChains: [...chains],
        appearance: { theme: "dark", accentColor: "#C8F36A", logo: "/icon.svg" },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig!}>{children}</WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
