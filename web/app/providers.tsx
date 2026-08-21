"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider, createConfig } from "@privy-io/wagmi";
import { WagmiProvider as WagmiProviderNoPrivy, createConfig as createWagmiConfigNoPrivy } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http } from "viem";
import { hyperEvmTestnet } from "@/lib/chain";

const wagmiConfig = createConfig({
  chains: [hyperEvmTestnet],
  transports: { [hyperEvmTestnet.id]: http() },
});

// Fallback config for when no Privy app id is set (below): @privy-io/wagmi's
// WagmiProvider renders a connector that calls @privy-io/react-auth hooks
// internally, which throw without a PrivyProvider ancestor. Plain wagmi's
// WagmiProvider needs no such ancestor — same chain, zero connectors, so
// wagmi hooks (useAccount, usePublicClient, useReadContract, ...) resolve
// instead of crashing, with wallet-connect features simply inert.
const wagmiConfigNoPrivy = createWagmiConfigNoPrivy({
  chains: [hyperEvmTestnet],
  transports: { [hyperEvmTestnet.id]: http() },
});

const queryClient = new QueryClient();

const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

export function Providers({ children }: { children: React.ReactNode }) {
  if (!privyAppId) {
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
        defaultChain: hyperEvmTestnet,
        supportedChains: [hyperEvmTestnet],
        appearance: { theme: "dark", accentColor: "#f5a091" },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
