import type { Address } from "viem";
import { parseCoinId, parseDecimalToUnits } from "./pure.js";

interface Balance {
  coin: string;
  total: string;
}
interface SpotClearinghouseState {
  balances: Balance[];
}

/** POST api.hyperliquid-testnet.xyz/info {type:"spotClearinghouseState", user} — the vault's
 * Core balances. Outcome coins come back as coin "+<10*outcome+side>" with a decimal `total`
 * and no numeric token id (FINDINGS.md kill-switch: no 0x801 read for outcome tokens). Returns
 * the balance in outcome wei (5-decimal), or 0n if the coin has never appeared. */
export async function fetchCoinBalanceWei(infoApiUrl: string, user: Address, coinId: bigint): Promise<bigint> {
  // Hard timeout: without it a stalled connection hangs this await forever, and
  // balanceLoop shares one Promise.all with settlementLoop — a single wedged
  // sample froze all settlement for hours (the 0x232a strand, 2026-08-22).
  // The signal also bounds the body reads below.
  const res = await fetch(infoApiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "spotClearinghouseState", user }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`info API ${res.status}: ${await res.text()}`);
  const state = (await res.json()) as SpotClearinghouseState;
  for (const b of state.balances ?? []) {
    if (parseCoinId(b.coin) === coinId) return parseDecimalToUnits(b.total, 5);
  }
  return 0n;
}
