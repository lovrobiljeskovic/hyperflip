import { defineChain } from "viem";

export const hyperEvmTestnet = defineChain({
  id: 998,
  name: "HyperEVM Testnet",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpcs.chain.link/hyperevm/testnet"] },
  },
  blockExplorers: {
    default: { name: "Purrsec", url: "https://testnet.purrsec.com" },
  },
  testnet: true,
});

/** Hyperliquid testnet frontend — Core order books and the testnet faucet. */
export const HL_APP = "https://app.hyperliquid-testnet.xyz";
export const HL_DRIP = `${HL_APP}/drip`;
