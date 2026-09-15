import { hashTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface QuoteLeg {
  vault: Address;
  isYes: boolean;
}

export interface ParlayQuote {
  taker: Address;
  legs: QuoteLeg[];
  premium: bigint;
  maxPayout: bigint;
  deadline: bigint;
  quoteId: Hex;
}

/** Must match ParlayVault QUOTE_TYPEHASH / LEG_TYPEHASH exactly — verified by the
 * forge parity vector in writer/test/quotes.test.ts. */
export const quoteTypes = {
  Quote: [
    { name: "taker", type: "address" },
    { name: "legs", type: "Leg[]" },
    { name: "premium", type: "uint96" },
    { name: "maxPayout", type: "uint96" },
    { name: "deadline", type: "uint256" },
    { name: "quoteId", type: "bytes32" },
  ],
  Leg: [
    { name: "vault", type: "address" },
    { name: "isYes", type: "bool" },
  ],
} as const;

export function quoteDomain(chainId: number, verifyingContract: Address) {
  return { name: "ParlayVault", version: "1", chainId, verifyingContract } as const;
}

export function quoteDigest(chainId: number, vault: Address, q: ParlayQuote): Hex {
  return hashTypedData({
    domain: quoteDomain(chainId, vault),
    types: quoteTypes,
    primaryType: "Quote",
    message: q,
  });
}

export async function signQuote(
  signerKey: `0x${string}`,
  chainId: number,
  vault: Address,
  q: ParlayQuote,
): Promise<Hex> {
  const account = privateKeyToAccount(signerKey);
  return account.signTypedData({
    domain: quoteDomain(chainId, vault),
    types: quoteTypes,
    primaryType: "Quote",
    message: q,
  });
}

export interface QuoteRecord {
  schemaVersion: 1;
  recordedAtMs: number;
  quoteId: Hex;
  quoteDigest: Hex;
  chainId: number;
  parlayVault: Address;
  taker: Address;
  legs: (QuoteLeg & { underlying: string; cluster: string; outcomeCoin: string })[];
  bookInputs: {
    priceWad: string;
    source: "l2Book" | "spotPx" | "prior";
    observedAtMs: number;
    depthWad: string | null;
    vwapWad: string | null;
    freshnessMs: number | null;
  }[];
  jointProbWad: string;
  edge: { baseBps: string; legBps: string; totalBps: string };
  premium: string;
  maxPayout: string;
  deadline: string;
  signatureHash: string;
}
