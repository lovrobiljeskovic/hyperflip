import { verifyDeploymentRpc } from "../../registry/deployment.mjs";
import { rpcUrls } from "../../services/env.mjs";
import { alert, log } from "../../services/log.mjs";
import { every, watchdog } from "../../services/loop.mjs";
import { createPublicClient, createWalletClient, defineChain, fallback, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { outcomeVaultAbi } from "./abi.js";
import { createBalanceLoop } from "./balance.js";
import type { KeeperConfig } from "./config.js";
import { createSerializer } from "./pure.js";
import { createSettlementLoop, loadFractionCache } from "./settlement.js";
import { RECEIPT_TIMEOUT_MS, type KeeperState, type VaultInfo } from "./state.js";

export async function runKeeper(config: KeeperConfig): Promise<void> {
  const account = privateKeyToAccount(config.keeperPrivateKey);
  // Every URL must serve 0x814 and 0x801 — see rpc-check.ts.
  const urls = rpcUrls(config.rpcUrl);
  const chain = defineChain({
    id: config.coreChainId,
    name: "HyperEVM Testnet",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: { default: { http: urls } },
  });
  const transport = fallback(urls.map((u) => http(u)));
  const publicClient = createPublicClient({ chain, transport });
  // With the ParlayVault on Elysium, the manifest is verified against the Elysium RPC and this
  // client only has to be the Core chain; settle() never touches the ParlayVault.
  const elysiumClient = config.elysiumRpcUrl
    ? createPublicClient({ transport: fallback(rpcUrls(config.elysiumRpcUrl).map((u) => http(u))) })
    : undefined;
  if (config.chainId === config.coreChainId) await verifyDeploymentRpc(publicClient, config);
  else {
    if ((await publicClient.getChainId()) !== config.coreChainId) throw new Error("TESTNET_RPC chain disagrees with the manifest's coreChainId");
    await verifyDeploymentRpc(elysiumClient!, config);
  }
  const walletClient = createWalletClient({ account, chain, transport });
  // Both loops send from one account with no explicit nonce; serialize the send, not the receipt wait.
  const sendTx = createSerializer();

  const vaultInfo = new Map<Address, VaultInfo>();
  // Persisted: Core prunes within ~10 min and the pruned path can only replay a fraction seen at status 2.
  const lastKnownFraction = loadFractionCache(config.settlementCachePath);
  if (lastKnownFraction.size > 0) log("loaded settlement cache", lastKnownFraction.size, "entries");

  async function readVault<T>(vault: Address, functionName: string, args: readonly unknown[] = []): Promise<T> {
    return (await publicClient.readContract({ address: vault, abi: outcomeVaultAbi, functionName, args })) as T;
  }

  for (const vault of config.vaultAddresses) {
    const [outcome, question, evmUnitsPerShare, verifier] = await Promise.all([
      readVault<bigint | number>(vault, "outcome"),
      readVault<bigint | number>(vault, "question"),
      readVault<bigint>(vault, "evmUnitsPerShare"),
      readVault<Address>(vault, "verifier"),
    ]);
    vaultInfo.set(vault, { outcome: Number(outcome), question: Number(question), evmUnitsPerShare, verifier });
    log("vault config", vault, { outcome: Number(outcome), question: Number(question), verifier });
  }

  // Vaults seen settled: no op can be pending and 0x801 throws on the pruned coin, so they are not sampled.
  const settledVaults = new Set<Address>();
  const state: KeeperState = {
    config, chain, account, publicClient, elysiumClient, walletClient, sendTx,
    vaultInfo, settledVaults, lastKnownFraction, readVault,
  };
  const balance = createBalanceLoop(state);
  const settlement = createSettlementLoop(state);

  for (const vault of config.vaultAddresses) await balance.seedPendingOps(vault);
  balance.watchOpQueued();

  log("keeper started", { vaults: config.vaultAddresses.length, pollIntervalMs: config.pollIntervalMs });

  // Independent cadences: a wedged await in one loop must not freeze the other.
  const lastTick = { balance: Date.now(), settlement: Date.now() };
  // A hung await never throws but setInterval still fires; ticks are bounded, so a stamp older than this is a hang: exit.
  const stallAfterMs = config.vaultAddresses.length * RECEIPT_TIMEOUT_MS + 120_000;
  watchdog(lastTick, () => stallAfterMs, (name, staleMs) =>
    alert(`${name} loop stalled for ${staleMs}ms — exiting so systemd restarts us`),
  );
  every(
    config.pollIntervalMs,
    () => balance.tick().then(() => { lastTick.balance = Date.now(); }),
    (err) => alert("balance loop failed", String((err as Error)?.message ?? err)),
  );
  every(
    config.pollIntervalMs,
    () => settlement.tick().then(() => { lastTick.settlement = Date.now(); }),
    (err) => alert("settlement loop failed", String((err as Error)?.message ?? err)),
  );
}
