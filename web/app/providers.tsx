"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider, createConfig } from "@privy-io/wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http } from "viem";
import { hyperEvmTestnet } from "@/lib/chain";

const wagmiConfig = createConfig({
  chains: [hyperEvmTestnet],
  transports: { [hyperEvmTestnet.id]: http() },
});

const queryClient = new QueryClient();

const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

export function Providers({ children }: { children: React.ReactNode }) {
  // No Privy app id configured yet (see web/.env.example) — render the tree
  // with wallet features inert instead of mounting PrivyProvider, which
  // throws on an invalid/empty appId and would crash prerendering.
  if (!privyAppId) {
    return <>{children}</>;
  }

  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        defaultChain: hyperEvmTestnet,
        supportedChains: [hyperEvmTestnet],
        appearance: { theme: "dark", accentColor: "#f0b43c" },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
