// One-off recovery: the 8/19 outcome vaults expired Aug 20 and Core pruned all of
// them before anything relayed settlement, so the permissionless settle() window
// (Core status 2) is gone. The pruned path in OutcomeVault.settle is keeper-only,
// and these vaults were deployed with keeper = the deployer address, so this runs
// off PRIVATE_KEY rather than KEEPER_PRIVATE_KEY.
//
// Fractions come from HyperLiquid testnet marks at each market's expiry (close of
// the minute ending 03:00 UTC). Every underlying finished far from its strike, so
// the candle-boundary choice does not change any verdict. ZEC is the exception:
// its mid has been frozen at exactly the strike since deploy with no trading
// history, so it settles fractional, which routes parlay 3 to Void and refunds the
// taker's premium.
//
// Only the five vaults carrying open parlay legs are settled. The three BTC-range
// vaults have no legs against them and are left alone.
//
// Run once: cd keeper && node settle-recovery.mjs

import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config as dotenv } from "dotenv";

dotenv({ path: "../.env" });

const RPC = "https://rpc.hyperliquid-testnet.xyz/evm";
const transport = http(RPC, { retryCount: 8, retryDelay: 3000 });
const chain = {
  id: 998,
  name: "HyperEVM Testnet",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
const pub = createPublicClient({ chain, transport });
const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const wallet = createWalletClient({ account, chain, transport });

const abi = [
  { type: "function", name: "settle", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "settled", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "settleFractionWad", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "keeper", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

const WAD = 10n ** 18n;

const PLAN = [
  ["0x69288D331911984fAeC8Af82688B7f718e2bB541", WAD, "BTC above 64200 — mark 69371 — YES"],
  ["0xd6959Ac6a60b5af8edFf8165f642FBc7D02C1c0E", WAD, "ETH above 1907.9 — mark 2341.0 — YES"],
  ["0x5f7661C2656Caf075898f74d5F337B95e709dbDc", WAD, "SOL above 76.656 — mark 84.869 — YES"],
  ["0x6265280746941f2dc05CcF111B0812CFF9708540", WAD, "HYPE above 58.403 — mark 67.58 — YES"],
  ["0xEA83C9450B5323103f98c285127c2D7D6bc20476", WAD / 2n, "ZEC above 138.65 — mark 138.65, no discovery — VOID"],
];

const balance = await pub.getBalance({ address: account.address });
console.log("sender", account.address, "| gas", formatEther(balance), "HYPE\n");

for (const [vault, fraction, note] of PLAN) {
  if (await pub.readContract({ address: vault, abi, functionName: "settled" })) {
    console.log("SKIP", vault, "already settled");
    continue;
  }

  const keeper = await pub.readContract({ address: vault, abi, functionName: "keeper" });
  if (keeper.toLowerCase() !== account.address.toLowerCase()) {
    console.log("SKIP", vault, "keeper is", keeper, "— this key cannot relay it");
    continue;
  }

  // settle() is irreversible (settled is a one-way latch), so never send one blind.
  try {
    await pub.simulateContract({ address: vault, abi, functionName: "settle", args: [fraction], account });
  } catch (err) {
    console.log("SIMULATE FAILED", vault, String(err).split("\n")[0].slice(0, 100));
    continue;
  }

  const hash = await wallet.writeContract({ address: vault, abi, functionName: "settle", args: [fraction] });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  const written = await pub.readContract({ address: vault, abi, functionName: "settleFractionWad" });

  console.log(receipt.status === "success" ? "OK  " : "FAIL", vault, "fraction", written.toString(), "|", note);
  console.log("     ", hash);

  await new Promise((r) => setTimeout(r, 2000));
}
