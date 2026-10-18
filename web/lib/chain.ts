import { defineChain } from "viem";

const HYPE = { name: "HYPE", symbol: "HYPE", decimals: 18 };
const CORE_CHAIN_ID = 998;
const CORE_RPC = "https://rpcs.chain.link/hyperevm/testnet";
const ELYSIUM_RPC = "https://testnet-rpc.elysium.kinetiq.xyz";
const PURRSEC = { name: "Purrsec", url: "https://testnet.purrsec.com" };
const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID);
const explorerUrl = process.env.NEXT_PUBLIC_EXPLORER_URL;

/** Chain the ParlayVault lives on, from the deployment manifest: HyperEVM testnet (998) or
 * Elysium testnet (99801). Every wallet action on /build and /positions targets this chain. */
export const appChain = defineChain({
  id: chainId,
  name: process.env.NEXT_PUBLIC_CHAIN_NAME ?? "HyperEVM Testnet",
  nativeCurrency: HYPE,
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_RPC_URL ?? (chainId === CORE_CHAIN_ID ? CORE_RPC : ELYSIUM_RPC)] } },
  // Elysium testnet has no published explorer yet; links that need one hide themselves.
  ...(explorerUrl ? { blockExplorers: { default: { name: "Explorer", url: explorerUrl } } }
    : chainId === CORE_CHAIN_ID ? { blockExplorers: { default: PURRSEC } } : {}),
  testnet: true,
});

export const coreChain = appChain.id === CORE_CHAIN_ID ? appChain : defineChain({
  id: CORE_CHAIN_ID,
  name: "HyperEVM Testnet",
  nativeCurrency: HYPE,
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_CORE_RPC_URL ?? CORE_RPC] } },
  blockExplorers: { default: PURRSEC },
  testnet: true,
});

export const BRIDGED = appChain.id !== coreChain.id;

/** Explorer page for an address on the app chain, or null when the chain has no explorer. */
export const explorerAddress = (address: string): string | null =>
  appChain.blockExplorers ? `${appChain.blockExplorers.default.url}/address/${address}` : null;

export const HL_APP = "https://app.hyperliquid-testnet.xyz";
export const HL_DRIP = `${HL_APP}/drip`;
export const tradeUrl = (coin: string) => `${HL_APP}/trade/${encodeURIComponent(coin)}`;
