// Second half of the 8/19-vault recovery: once settle-recovery.mjs has settled the
// leg vaults, this closes out the parlays the poker would normally have poked.
//
// resolveParlay is permissionless, so this runs off POKER_PRIVATE_KEY — the same
// key the writer's poker uses.
//
// Parlay 6 is deliberately left Open. It is the only winner, and claim() auto-
// resolves an Open ticket, so leaving it lets the claim run end-to-end through the
// UI — which is also the live claim walkthrough the beta launch gates still want.
//
// Run after settle-recovery.mjs: cd keeper && node resolve-recovery.mjs

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
const account = privateKeyToAccount(process.env.POKER_PRIVATE_KEY);
const wallet = createWalletClient({ account, chain, transport });

const PARLAY_VAULT = process.env.PARLAY_VAULT_ADDRESS;

const abi = [
  { type: "function", name: "resolveParlay", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  {
    type: "function",
    name: "parlay",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "legs", type: "tuple[]", components: [{ name: "vault", type: "address" }, { name: "isYes", type: "bool" }] },
          { name: "writer", type: "address" },
          { name: "premium", type: "uint96" },
          { name: "maxPayout", type: "uint96" },
          { name: "status", type: "uint8" },
        ],
      },
    ],
  },
];

const STATUS = ["Open", "Won", "Dead", "Void"];
const TO_RESOLVE = [3n, 4n, 5n, 7n, 8n, 9n];

console.log("sender", account.address, "| gas", formatEther(await pub.getBalance({ address: account.address })), "HYPE\n");

for (const id of TO_RESOLVE) {
  const before = await pub.readContract({ address: PARLAY_VAULT, abi, functionName: "parlay", args: [id] });
  if (before.status !== 0) {
    console.log("SKIP", id.toString(), "already", STATUS[before.status]);
    continue;
  }

  try {
    await pub.simulateContract({ address: PARLAY_VAULT, abi, functionName: "resolveParlay", args: [id], account });
  } catch (err) {
    console.log("SIMULATE FAILED", id.toString(), String(err).split("\n")[0].slice(0, 100));
    continue;
  }

  const hash = await wallet.writeContract({ address: PARLAY_VAULT, abi, functionName: "resolveParlay", args: [id] });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  const after = await pub.readContract({ address: PARLAY_VAULT, abi, functionName: "parlay", args: [id] });

  console.log(receipt.status === "success" ? "OK  " : "FAIL", id.toString(), "->", STATUS[after.status]);
  console.log("     ", hash);

  await new Promise((r) => setTimeout(r, 2000));
}

console.log("\nparlay 6 left Open on purpose — claim it from /positions to close the loop.");
