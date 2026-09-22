"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider, createConfig } from "@privy-io/wagmi";
import { WagmiProvider as WagmiProviderNoPrivy, createConfig as createWagmiConfigNoPrivy } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http } from "viem";
import { appChain, BRIDGED, coreChain } from "@/lib/chain";

// The bridge step signs on HyperEVM, so the wallet needs both chains when the vault is on Elysium.
const chains = BRIDGED ? ([appChain, coreChain] as const) : ([appChain] as const);
const transports = { [appChain.id]: http(undefined, { retryCount: 6, retryDelay: 2_000 }), [coreChain.id]: http(undefined, { retryCount: 6, retryDelay: 2_000 }) };

const wagmiConfig = createConfig({
  chains,
  transports,
});

// Fallback config for when no Privy app id is set (below): @privy-io/wagmi's
// WagmiProvider renders a connector that calls @privy-io/react-auth hooks
// internally, which throw without a PrivyProvider ancestor. Plain wagmi's
// WagmiProvider needs no such ancestor - same chain, zero connectors, so
// wagmi hooks (useAccount, usePublicClient, useReadContract, ...) resolve
// instead of crashing, with wallet-connect features simply inert.
const wagmiConfigNoPrivy = createWagmiConfigNoPrivy({
  chains,
  transports,
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
        loginMethods: ["email", "wallet"],
        embeddedWallets: { ethereum: { createOnLogin: "off" }, solana: { createOnLogin: "off" } },
        defaultChain: appChain,
        supportedChains: [...chains],
        appearance: { theme: "dark", accentColor: "#C8F36A", logo: "/icon.svg" },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
