import { erc20Abi, parseUnits, type Address, type PublicClient } from "viem";
import { parlayVaultAbi } from "./abi.js";

/** House capacity is the smaller of what the vault may pull (allowance) and what
 * the wallet actually holds (balance): a max-approve with an empty wallet must
 * not let the exposure book reserve risk the mint tx cannot fund. */
export function bankrollRoom(allowance: bigint, balance: bigint): bigint {
  return allowance < balance ? allowance : balance;
}

/** Edge-triggered low-bankroll alert: fires once when room drops below the
 * threshold and re-arms only after it recovers, so a flat-broke wallet does not
 * page on every quote. */
export function lowBankrollAlerter(threshold: bigint): (room: bigint) => boolean {
  let armed = true;
  return (room) => {
    if (room >= threshold) {
      armed = true;
      return false;
    }
    if (!armed) return false;
    armed = false;
    return true;
  };
}

/** Reads the vault's USDC address once, then returns the per-quote bankroll read and the
 * last value seen (for /health). Alerts on stderr with the `ALERT` token ops/alert-relay.sh greps. */
export async function bankrollReader(
  publicClient: Pick<PublicClient, "readContract">,
  addrs: { parlayVault: Address; writerAddress: Address },
) {
  const usdcAddress = (await publicClient.readContract({
    address: addrs.parlayVault,
    abi: parlayVaultAbi,
    functionName: "usdc",
  })) as Address;
  const lowBankroll = parseUnits(process.env.LOW_BANKROLL ?? "100", 6);
  const shouldAlertLowBankroll = lowBankrollAlerter(lowBankroll);
  let lastBankroll: bigint | null = null;
  return {
    readAllowance: async () => {
      const [allowance, balance] = await Promise.all([
        publicClient.readContract({ address: usdcAddress, abi: erc20Abi, functionName: "allowance", args: [addrs.writerAddress, addrs.parlayVault] }),
        publicClient.readContract({ address: usdcAddress, abi: erc20Abi, functionName: "balanceOf", args: [addrs.writerAddress] }),
      ]);
      lastBankroll = bankrollRoom(allowance, balance);
      if (shouldAlertLowBankroll(lastBankroll))
        console.error(new Date().toISOString(), "ALERT", JSON.stringify({ event: "low-bankroll", bankroll: lastBankroll.toString(), allowance: allowance.toString(), balance: balance.toString(), threshold: lowBankroll.toString() }));
      return lastBankroll;
    },
    bankroll: () => lastBankroll,
  };
}
