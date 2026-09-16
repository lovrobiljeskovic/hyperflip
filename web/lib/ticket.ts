import { erc20Abi, parseUnits, type PublicClient } from "viem";
import type { UseWriteContractReturnType } from "wagmi";
import { requestQuote, type QuoteResult, type WriterQuote } from "./writer";
import { PARLAY_VAULT, parlayVaultAbi } from "./contracts";
import { hyperEvmTestnet } from "./chain";
import { secondsLeft, USDC_DECIMALS } from "./format";

export interface BuilderLeg {
  vault: `0x${string}`;
  isYes: boolean;
  title: string;
  coin: string;
  /** Side label from the registry ("Twins", "Over"); YES/NO when absent. */
  label?: string;
  /** Question group this leg belongs to; one leg per group on a slip. */
  group?: string;
}


export function tryParseStake(v: string): bigint | null {
  if (!v.trim()) return null;
  try {
    const n = parseUnits(v, USDC_DECIMALS);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

export class TicketSession {
  private key = "";
  private request = 0;
  revision = 0;
  minting = false;

  select(key: string): void {
    if (key !== this.key) { this.key = key; this.invalidate(); }
  }
  invalidate(): void { this.revision++; this.request++; }
  beginMint(): boolean {
    if (this.minting) return false;
    this.minting = true;
    this.request++;
    return true;
  }

  async quote(input: Parameters<typeof requestQuote>[0]) {
    const request = ++this.request;
    const revision = this.revision;
    let result = await requestQuote(input);
    if (result.ok && !quoteMatches(result.quote, input)) result = { ok: false, status: 0, error: "quote-mismatch" };
    return request === this.request && revision === this.revision ? { revision, result } : null;
  }
}

/** Step one of the two-tx flow: exact-amount USDC approval for the vault. */
export async function approveUsdc({ client, write, usdc, taker, amount, current }: {
  client: PublicClient;
  write: UseWriteContractReturnType["writeContractAsync"];
  usdc: `0x${string}`;
  taker: `0x${string}`;
  amount: bigint;
  current: () => boolean;
}): Promise<void> {
  const hash = await write({ address: usdc, abi: erc20Abi, functionName: "approve", args: [PARLAY_VAULT, amount], account: taker, chainId: hyperEvmTestnet.id });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (!current()) throw new Error("Ticket changed; review the current ticket before minting.");
  if (receipt.status !== "success") throw new Error("approve reverted");
}

export async function mintTicket({ client, write, usdc, quote, sig, input, current, onQuote }: {
  client: PublicClient;
  write: UseWriteContractReturnType["writeContractAsync"];
  usdc: `0x${string}`;
  quote: WriterQuote;
  sig: `0x${string}`;
  input: Parameters<typeof requestQuote>[0];
  current: () => boolean;
  onQuote: (result: QuoteResult) => void;
}): Promise<boolean> {
  function check() {
    if (!current()) throw new Error("Ticket changed; review the current ticket before minting.");
  }
  check();
  if (!quoteMatches(quote, input)) throw new Error("Quote changed ticket terms");
  let premium = BigInt(quote.premium);
  const [allowance, balance] = await Promise.all([
    client.readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [quote.taker, PARLAY_VAULT] }),
    client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [quote.taker] }),
  ]);
  check();
  if (balance < premium) throw new Error("transfer amount exceeds balance");
  // Fallback only: the UI approves first, but a stale allowance read must not
  // reach a mint that reverts on-chain.
  if (allowance < premium) await approveUsdc({ client, write, usdc, taker: quote.taker, amount: premium, current });
  if (allowance < premium || secondsLeft(BigInt(quote.deadline), Date.now()) < 10) {
    const result = await requestQuote(input);
    check();
    // Exact approval remains sufficient only for the same premium and selections.
    if (result.ok && !quoteMatches(result.quote, input)) throw new Error("Refreshed quote changed ticket terms");
    onQuote(result);
    if (!result.ok) return false;
    quote = result.quote;
    sig = result.sig;
    premium = BigInt(quote.premium);
  }
  const args = [{ taker: quote.taker, legs: quote.legs, premium, maxPayout: BigInt(quote.maxPayout), deadline: BigInt(quote.deadline), quoteId: quote.quoteId }, sig] as const;
  await client.simulateContract({ address: PARLAY_VAULT, abi: parlayVaultAbi, functionName: "mint", args, account: quote.taker });
  check();
  const hash = await write({ address: PARLAY_VAULT, abi: parlayVaultAbi, functionName: "mint", args, account: quote.taker, chainId: hyperEvmTestnet.id });
  const receipt = await client.waitForTransactionReceipt({ hash });
  check();
  if (receipt.status !== "success") throw new Error("QUOTE_EXPIRED (mint reverted on-chain)");
  return true;
}

export function quoteMatches(quote: WriterQuote, input: Parameters<typeof requestQuote>[0]): boolean {
  return quote.taker.toLowerCase() === input.taker.toLowerCase() && quote.premium === input.stake &&
    quote.legs.length === input.legs.length && quote.legs.every((leg, i) =>
      leg.vault.toLowerCase() === input.legs[i].vault.toLowerCase() && leg.isYes === input.legs[i].isYes);
}
