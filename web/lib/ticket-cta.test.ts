import { expect, test } from "vitest";
import { appChain, coreChain, HL_DRIP } from "./chain";
import { computeCta, type CtaInput } from "./ticket-cta";
import type { QuoteResult, WriterQuote } from "./writer";

const NOW = 1_000_000_000_000;
const quote = (deadlineSec: number): QuoteResult =>
  ({ ok: true, quote: { premium: "5000000", maxPayout: "20000000", deadline: String(deadlineSec) } as WriterQuote, sig: "0x" });
const HINT = "Claim testnet USDC at the Hyperliquid drip, then transfer it (and some HYPE for gas) from Core to EVM.";

const ready: CtaInput = {
  legCount: 2, walletReady: true, isConnected: true, isLinked: true, chainId: appChain.id, bridged: false,
  gas: 10n ** 18n, usdcBalance: 10_000_000n, stakeBase: 5_000_000n, usdcAddr: `0x${"1".repeat(40)}`,
  allowance: 5_000_000n, rpcError: false, mintState: "idle", minting: false, approving: false, quoting: false,
  quoteResult: quote(NOW / 1000 + 20), now: NOW,
};
const cta = (over: Partial<CtaInput>) => computeCta({ ...ready, ...over });
const pay = (label: string, enabled = false) => ({ kind: "pay", step: "mint", needsApproval: false, enabled, label });

test("leg count gate", () => {
  expect(cta({ legCount: 0 })).toEqual({ kind: "disabled", label: "Add 2 legs to price a ticket" });
  expect(cta({ legCount: 1 })).toEqual({ kind: "disabled", label: "Add 1 more leg to price a ticket" });
});

test("wallet gates", () => {
  expect(cta({ walletReady: false })).toEqual({ kind: "disabled", label: "Checking wallet…" });
  expect(cta({ isConnected: false })).toEqual({ kind: "connect", label: "Connect wallet" });
  expect(cta({ isLinked: false })).toEqual({ kind: "connect", label: "Verify wallet" });
  expect(cta({ chainId: appChain.id + 1 })).toEqual({ kind: "switch-chain", label: `Switch to ${appChain.name}` });
});

test("bridged lane: bridge shortfall and gas, then switch back from core", () => {
  expect(cta({ bridged: true, usdcBalance: 2_000_000n })).toEqual({ kind: "bridge", usdc: 3_000_000n, gas: false });
  expect(cta({ bridged: true, gas: 0n })).toEqual({ kind: "bridge", usdc: 0n, gas: true });
  expect(cta({ bridged: true, usdcBalance: 0n, stakeBase: null })).toEqual({ kind: "bridge", usdc: 0n, gas: false });
  expect(cta({ bridged: true, chainId: coreChain.id })).toEqual({ kind: "switch-chain", label: `Switch to ${appChain.name}` });
});

test("faucet steps", () => {
  expect(cta({ usdcBalance: 0n })).toEqual({ kind: "external", label: "Get testnet USDC →", href: HL_DRIP, hint: HINT });
  expect(cta({ gas: 0n })).toEqual({ kind: "external", label: "Get HYPE for gas →", href: HL_DRIP, hint: HINT });
});

test("stake, token and balance gates", () => {
  expect(cta({ stakeBase: null })).toEqual({ kind: "disabled", label: "Enter a stake to quote" });
  expect(cta({ allowance: undefined })).toEqual({ kind: "disabled", label: "Checking wallet…" });
  expect(cta({ usdcAddr: undefined, rpcError: true })).toEqual({ kind: "disabled", label: "RPC unavailable - try again later" });
  expect(cta({ stakeBase: 15_000_000n })).toEqual({ kind: "disabled", label: "Insufficient USDC - 10.00 available" });
});

test("minted", () => {
  expect(cta({ mintState: "done" })).toEqual({ kind: "done", label: "Minted · view positions", href: "/positions" });
});

test("approve step", () => {
  expect(cta({ allowance: 0n })).toEqual({ kind: "pay", step: "approve", needsApproval: true, enabled: true, label: "Approve USDC once" });
  expect(cta({ allowance: 0n, approving: true })).toEqual({ kind: "pay", step: "approve", needsApproval: true, enabled: false, label: "Confirm in wallet…" });
  expect(cta({ allowance: 0n, minting: true })).toEqual({ kind: "pay", step: "approve", needsApproval: true, enabled: false, label: "Approve USDC once" });
});

test("mint step waits", () => {
  expect(cta({ mintState: "pending" })).toEqual(pay("Confirm in wallet…"));
  expect(cta({ minting: true })).toEqual(pay("Confirm in wallet…"));
  expect(cta({ quoting: true })).toEqual(pay("Quoting…"));
  expect(cta({ quoteResult: null })).toEqual(pay("Waiting for quote…"));
  expect(cta({ quoteResult: { ok: false, status: 400, error: "x" } })).toEqual(pay("Unable to quote"));
  expect(cta({ quoteResult: quote(NOW / 1000) })).toEqual(pay("Refreshing quote…"));
});

test("mint enabled", () => {
  expect(cta({})).toEqual(pay("Mint ticket · $5.00", true));
});
