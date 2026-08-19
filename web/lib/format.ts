import { formatUnits } from "viem";

export const USDC_DECIMALS = 6;

export function formatUsdc(v: bigint): string {
  return Number(formatUnits(v, USDC_DECIMALS)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function multiplier(premium: bigint, maxPayout: bigint): string {
  if (premium === 0n) return "—";
  return `${(Number(maxPayout) / Number(premium)).toFixed(2)}x`;
}

export function impliedPct(mid: number): string {
  return `${Math.round(mid * 100)}%`;
}

export function secondsLeft(deadlineSec: bigint, nowMs: number): number {
  return Math.floor(Math.max(0, Number(deadlineSec) * 1000 - nowMs) / 1000);
}
