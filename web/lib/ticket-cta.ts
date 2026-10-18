import { appChain, coreChain, HL_DRIP } from "./chain";
import { formatUsdc, secondsLeft } from "./format";
import { MIN_LEGS } from "./ticket";
import type { QuoteResult } from "./writer";

const DRIP_HINT = "Claim testnet USDC at the Hyperliquid drip, then transfer it (and some HYPE for gas) from Core to EVM.";

export type Cta =
  | { kind: "disabled"; label: string }
  | { kind: "connect"; label: string }
  /** Off-site next step (the faucet) - opens a new tab, with a one-line hint. */
  | { kind: "external"; label: string; href: string; hint: string }
  | { kind: "done"; label: string; href: string }
  | { kind: "switch-chain"; label: string }
  /** Funds live on HyperEVM; the bridge panel moves the USDC shortfall and gas across first. */
  | { kind: "bridge"; usdc: bigint; gas: boolean }
  /** Past every gate: step one approves the stake, step two mints once the allowance covers it. */
  | { kind: "pay"; step: "approve" | "mint"; label: string; enabled: boolean; needsApproval: boolean };

export type CtaInput = {
  legCount: number;
  walletReady: boolean;
  isConnected: boolean;
  isLinked: boolean;
  chainId: number | undefined;
  bridged: boolean;
  gas: bigint | undefined;
  usdcBalance: bigint | undefined;
  stakeBase: bigint | null;
  usdcAddr: `0x${string}` | undefined;
  allowance: bigint | undefined;
  rpcError: boolean;
  mintState: "idle" | "pending" | "done" | "requoted" | "error";
  minting: boolean;
  approving: boolean;
  quoting: boolean;
  quoteResult: QuoteResult | null;
  now: number;
};

export function computeCta(i: CtaInput): Cta {
  if (i.legCount < MIN_LEGS) return { kind: "disabled", label: i.legCount === 1 ? "Add 1 more leg to price a ticket" : "Add 2 legs to price a ticket" };
  if (!i.walletReady) return { kind: "disabled", label: "Checking wallet…" };
  if (!i.isConnected) return { kind: "connect", label: "Connect wallet" };
  if (!i.isLinked) return { kind: "connect", label: "Verify wallet" };
  // The bridge step moves the wallet to the core chain mid-flow; keep it mounted (and its
  // "sent" status visible) instead of swapping in the switch-chain CTA until funds land.
  const onCore = i.bridged && i.chainId === coreChain.id;
  if (i.chainId !== undefined && i.chainId !== appChain.id && !onCore)
    return { kind: "switch-chain", label: `Switch to ${appChain.name}` };
  if (i.bridged) {
    const gasOut = i.gas === 0n;
    const short = i.stakeBase !== null && i.usdcBalance !== undefined ? i.stakeBase - i.usdcBalance : 0n;
    if (gasOut || i.usdcBalance === 0n || short > 0n) return { kind: "bridge", usdc: short > 0n ? short : 0n, gas: gasOut };
  }
  if (onCore) return { kind: "switch-chain", label: `Switch to ${appChain.name}` };
  if (i.usdcBalance === 0n) return { kind: "external", label: "Get testnet USDC →", href: HL_DRIP, hint: DRIP_HINT };
  if (i.gas === 0n)
    return { kind: "external", label: "Get HYPE for gas →", href: HL_DRIP, hint: DRIP_HINT };
  if (i.stakeBase === null) return { kind: "disabled", label: "Enter a stake to quote" };
  // approve() needs the token address and mint needs a real allowance read; never offer
  // "Approve" while either is unknown, or the click is a silent no-op.
  if (!i.usdcAddr || i.allowance === undefined)
    return { kind: "disabled", label: i.rpcError ? "RPC unavailable - try again later" : "Checking wallet…" };
  if (i.usdcBalance !== undefined && i.stakeBase > i.usdcBalance)
    return { kind: "disabled", label: `Insufficient USDC - ${formatUsdc(i.usdcBalance)} available` };
  if (i.mintState === "done") return { kind: "done", label: "Minted · view positions", href: "/positions" };
  const minting = i.minting || i.mintState === "pending";
  // premium === stake by construction (quoteMatches), so the allowance needed is
  // known before any quote arrives and survives requotes.
  if (i.allowance < i.stakeBase) {
    return { kind: "pay", step: "approve", needsApproval: true, enabled: !i.approving && !minting,
      label: i.approving ? "Confirm in wallet…" : "Approve USDC once" };
  }
  const q = i.quoteResult;
  const waiting =
    minting ? "Confirm in wallet…"
    : i.quoting ? "Quoting…"
    : !q ? "Waiting for quote…"
    : !q.ok ? "Unable to quote"
    : secondsLeft(BigInt(q.quote.deadline), i.now) <= 0 ? "Refreshing quote…"
    : null;
  if (waiting || !q?.ok) return { kind: "pay", step: "mint", needsApproval: false, enabled: false, label: waiting ?? "Waiting for quote…" };
  return { kind: "pay", step: "mint", needsApproval: false, enabled: true, label: `Mint ticket · $${formatUsdc(BigInt(q.quote.premium))}` };
}
