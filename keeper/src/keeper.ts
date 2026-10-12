import { verifyDeploymentRpc } from "../../registry/deployment.mjs";
import { rpcUrls } from "../../services/env.mjs";
import { alert, log } from "../../services/log.mjs";
import { every, watchdog } from "../../services/loop.mjs";
import {
  encodedOutcomeAssetId,
  OUTCOME_ACTIVE,
  OUTCOME_PRUNED,
  OUTCOME_SETTLED,
  readOutcomeStatus,
  readSpotBalanceWei,
} from "../../services/precompiles.mjs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  parseAbi,
  zeroAddress,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { keeperVerifierAbi, outcomeVaultAbi } from "./abi.js";
import type { KeeperConfig } from "./config.js";
import { loadFractionCache, saveFraction } from "./cache.js";
import {
  createSerializer,
  evmToOutcomeWei,
  fractionWadFromSettledValue,
  newestSampleBefore,
  opKey,
  relayFees,
  resolveBalanceCheck,
  shouldRelay,
  type BalanceSample,
  type OpType,
} from "./pure.js";

const STATUS_PENDING = 0;
/** How long to wait for a submitted attest()/settle() tx to mine before treating it as failed. */
const RECEIPT_TIMEOUT_MS = 60_000;
/** Ambient samples kept per vault, in ticks: longer than the ~4s event poll so a pre-op sample is usually in hand. */
const HISTORY_LIMIT = 20;
/** Keeper clock behind chain time makes a post-op sample look pre-op; assumes skew ≤ this. */
const CLOCK_SKEW_MARGIN_MS = 2_000;
/** Unsettled this long past registry expiry raises an alert: a loose tripwire, not a deadline. */
const SETTLEMENT_STALE_AFTER_MS = 15 * 60_000;
/** A stalled sampler must not serve an old balance as a confident baseline. */
const MAX_SAMPLE_AGE_MS = 60_000;
/** Elysium settlement path (src/SettlementRelay.sol, src/OutcomeLeg.sol): three calls, hand-written, not generated. */
const settlementRelayAbi = parseAbi([
  "function relay(address vault, address leg, uint256 maxSubmissionCost, uint256 gasLimit, uint256 maxFeePerGas) payable returns (uint256)",
]);
const outcomeLegAbi = parseAbi(["function settled() view returns (bool)"]);

interface VaultInfo {
  outcome: number;
  question: number;
  evmUnitsPerShare: bigint;
  verifier: Address;
}

/** At most one per vault — the vault itself enforces this (_requireIdle), so vault is the map key. */
interface PendingOp {
  opId: bigint;
  opType: OpType;
  weiAmount: bigint;
  baseline: bigint | null;
  firstSeenAt: number;
  /** true only when `baseline` was sampled before the OpQueued block, so it is provably pre-execution. */
  confidentBaseline: boolean;
  /** Suppresses repeat alerts once a low-confidence op has already been flagged as held. */
  holdAlerted: boolean;
}

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
  const pendingOps = new Map<Address, PendingOp>();
  // Persisted: Core prunes within ~10 min and the pruned path can only replay a fraction seen at status 2.
  const lastKnownFraction = loadFractionCache(config.settlementCachePath);
  if (lastKnownFraction.size > 0) log("loaded settlement cache", lastKnownFraction.size, "entries");

  function rememberFraction(vault: Address, fractionWad: bigint): void {
    try {
      saveFraction(lastKnownFraction, config.settlementCachePath, vault, fractionWad);
    } catch (err) {
      // In-memory copy still works for this process; only a restart would lose it.
      alert("could not persist settlement cache", config.settlementCachePath, (err as Error).message);
    }
  }
  const balanceHistory = new Map<Address, BalanceSample[]>(); // ambient yes-coin samples, per vault
  const staleAlerted = new Set<Address>(); // suppresses repeat past-expiry alerts, per vault

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

  function recordSample(vault: Address, balance: bigint): void {
    const arr = balanceHistory.get(vault) ?? [];
    arr.push({ readAt: Date.now(), balance });
    if (arr.length > HISTORY_LIMIT) arr.shift();
    balanceHistory.set(vault, arr);
  }

  function sampleBefore(vault: Address, beforeMs: number): BalanceSample | undefined {
    return newestSampleBefore(balanceHistory.get(vault) ?? [], beforeMs, CLOCK_SKEW_MARGIN_MS, MAX_SAMPLE_AGE_MS);
  }

  function track(
    vault: Address,
    opId: bigint,
    opType: OpType,
    weiAmount: bigint,
    info: VaultInfo,
    baseline: bigint | null,
    confidentBaseline: boolean,
  ): void {
    if (pendingOps.has(vault)) return; // _requireIdle guarantees at most one; ignore a stray duplicate
    pendingOps.set(vault, {
      opId,
      opType,
      weiAmount,
      baseline,
      firstSeenAt: Date.now(),
      confidentBaseline,
      holdAlerted: false,
    });
    log("tracking op", vault, opId.toString(), opType === 0 ? "Split" : "Merge", "confident:", confidentBaseline);
  }

  /** A read at detection time can already be post-execution, so only a pre-block sample is confident. */
  async function resolveLiveBaseline(vault: Address, blockNumber: bigint): Promise<{ baseline: bigint | null; confident: boolean }> {
    try {
      const block = await publicClient.getBlock({ blockNumber });
      const sample = sampleBefore(vault, Number(block.timestamp) * 1000);
      if (sample) return { baseline: sample.balance, confident: true };
    } catch (err) {
      alert("could not establish provable baseline provenance, falling back", vault, (err as Error).message);
    }
    try {
      const info = vaultInfo.get(vault)!;
      const current = await readSpotBalanceWei(publicClient, vault, encodedOutcomeAssetId(info.outcome, true));
      return { baseline: current, confident: false };
    } catch (err) {
      alert("fallback baseline read also failed", vault, (err as Error).message);
      return { baseline: null, confident: false };
    }
  }

  async function trackIfStillPending(vault: Address, opId: bigint, opType: OpType, weiAmount: bigint, info: VaultInfo): Promise<void> {
    const key = opKey(vault, opId);
    const status = await publicClient.readContract({
      address: info.verifier,
      abi: keeperVerifierAbi,
      functionName: "statusOf",
      args: [key],
    });
    if (Number(status) !== STATUS_PENDING) return; // already attested (this or a prior run)
    track(vault, opId, opType, weiAmount, info, null, false); // rebuilt: no provable pre-op baseline exists
  }

  /** _requireIdle allows one open op per vault, so on-chain pendingDeposit/pendingRedeem is the pending set on restart. */
  async function seedPendingOps(vault: Address): Promise<void> {
    const info = vaultInfo.get(vault)!;
    const [depUser, depAmount, depOpId] = await readVault<[Address, bigint, bigint, bigint]>(vault, "pendingDeposit");
    if (depUser !== zeroAddress) {
      await trackIfStillPending(vault, depOpId, 0, evmToOutcomeWei(depAmount, info.evmUnitsPerShare), info);
    }
    const [redUser, redAmount, redOpId] = await readVault<[Address, bigint, bigint]>(vault, "pendingRedeem");
    if (redUser !== zeroAddress) {
      await trackIfStillPending(vault, redOpId, 1, evmToOutcomeWei(redAmount, info.evmUnitsPerShare), info);
    }
  }

  for (const vault of config.vaultAddresses) await seedPendingOps(vault);

  // Live detection going forward: poll-based watcher (works over plain HTTP transport).
  for (const vault of config.vaultAddresses) {
    const info = vaultInfo.get(vault)!;
    publicClient.watchContractEvent({
      address: vault,
      abi: outcomeVaultAbi,
      eventName: "OpQueued",
      onLogs: (logs) => {
        void (async () => {
          for (const l of logs) {
            const { args, blockNumber } = l as unknown as {
              args: { opId: bigint; opType: number; weiAmount: bigint };
              blockNumber: bigint;
            };
            if (pendingOps.has(vault)) continue;
            const { baseline, confident } = await resolveLiveBaseline(vault, blockNumber);
            track(vault, args.opId, Number(args.opType) as OpType, args.weiAmount, info, baseline, confident);
          }
        })().catch((err) => alert("OpQueued handler crashed", vault, (err as Error).message));
      },
      onError: (err) => alert("watchContractEvent error", vault, err.message),
    });
  }

  /** Reports whether attest() landed; false keeps the op tracked so a transient error cannot drop it. */
  async function attest(vault: Address, opId: bigint, executed: boolean): Promise<boolean> {
    const info = vaultInfo.get(vault)!;
    const key = opKey(vault, opId);
    try {
      const hash = await sendTx(() =>
        walletClient.writeContract({
          address: info.verifier,
          abi: keeperVerifierAbi,
          functionName: "attest",
          args: [key, executed],
          chain,
          account,
        }),
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
      if (receipt.status !== "success") {
        alert("attest tx reverted", vault, opId.toString(), hash);
        return false;
      }
      log("attested", vault, opId.toString(), executed, hash);
      return true;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("ALREADY_ATTESTED")) {
        // A verdict is already on-chain, whatever it was; local retry has nothing left to do.
        alert("already attested (prior attempt or race) — dropping local tracking", vault, opId.toString());
        return true;
      }
      alert("attest failed", vault, opId.toString(), msg);
      return false;
    }
  }

  // Balance-verification loop; doubles as the ambient sampler so a pre-op sample exists before OpQueued is noticed.
  // ponytail: a held op (no confident baseline ever established, e.g. a rebuilt op) stays pending
  // forever if it truly dropped on Core — recovery is manual/owner-driven (setVerifier), same as
  // any other case this design defers to the owner rather than trusting elapsed time.
  // Consecutive failed balance-read samples per vault — throttles the alert, nothing else.
  const sampleFailures = new Map<string, number>();
  // Vaults seen settled: no op can be pending and 0x801 throws on the pruned coin, so they are not sampled.
  const settledVaults = new Set<Address>();

  async function balanceLoop(): Promise<void> {
    for (const vault of config.vaultAddresses) {
      if (settledVaults.has(vault)) continue;
      const info = vaultInfo.get(vault)!;
      const assetId = encodedOutcomeAssetId(info.outcome, true);
      let current: bigint;
      try {
        current = await readSpotBalanceWei(publicClient, vault, assetId);
      } catch (err) {
        // Settled vault (startup race before settlementLoop's first tick, or settled since last
        // tick): 0x801 throws on its pruned coin and there is nothing to verify — not an alert.
        if (await readVault<boolean>(vault, "settled").catch(() => false)) {
          settledVaults.add(vault);
          continue;
        }
        // RPC reads fail in bursts (-32005 rate limits). One alert per tick per vault buries every
        // other alert in the journal, so speak on the first failure and then once a minute,
        // and keep the nginx error page out of the log.
        const n = (sampleFailures.get(vault) ?? 0) + 1;
        sampleFailures.set(vault, n);
        if (n === 1 || (n * config.pollIntervalMs) % 60_000 < config.pollIntervalMs) {
          alert("balance sample failed", vault, `x${n}`, (err as Error).message.split("\n")[0].slice(0, 200));
        }
        continue;
      }
      const failed = sampleFailures.get(vault);
      if (failed) {
        log("balance sample recovered", vault, `after ${failed} failures`);
        sampleFailures.delete(vault);
      }
      recordSample(vault, current);

      const op = pendingOps.get(vault);
      if (!op) continue;
      try {
        if (op.baseline === null) {
          op.baseline = current; // late capture (fallback path only); confidence already false
          continue;
        }
        const verdict = resolveBalanceCheck(
          op.baseline,
          current,
          op.opType,
          op.weiAmount,
          Date.now() - op.firstSeenAt,
          config.balanceTimeoutMs,
          op.confidentBaseline,
        );
        if (verdict === "wait") continue;
        if (verdict === "hold") {
          if (!op.holdAlerted) {
            alert(
              "balance timeout with no confidently pre-op baseline — holding, not attesting false; check manually",
              vault,
              op.opId.toString(),
            );
            op.holdAlerted = true;
          }
          continue;
        }
        if (verdict === "attest-false") {
          // Keeper-side policy: Core gives no signal for a dropped op; the owner's setVerifier is the trust anchor, not this timeout.
          alert("balance timeout with no delta, attesting executed=false", vault, op.opId.toString());
        }
        if (await attest(vault, op.opId, verdict === "attest-true")) pendingOps.delete(vault);
      } catch (err) {
        alert("balance check failed", vault, op.opId.toString(), (err as Error).message);
      }
    }
  }

  /** Waits for the receipt so the next tick cannot send a duplicate settle() while one is in flight. */
  async function settle(vault: Address, fractionWad: bigint): Promise<void> {
    try {
      const hash = await sendTx(() =>
        walletClient.writeContract({
          address: vault,
          abi: outcomeVaultAbi,
          functionName: "settle",
          args: [fractionWad],
          chain,
          account,
        }),
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
      if (receipt.status !== "success") {
        alert("settle tx reverted", vault, hash);
        return;
      }
      log("settle() confirmed", vault, fractionWad.toString(), hash);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("ALREADY_SETTLED")) return; // race lost to a permissionless caller — fine
      alert("settle() failed", vault, msg);
    }
  }

  const relaySentAt = new Map<Address, number>();
  const relayedLegs = new Set<Address>();
  /** relay() reads the fraction on-chain and the leg rejects a second delivery, so a stray send costs fees only. */
  async function relayIfNeeded(vault: Address): Promise<void> {
    const leg = config.legs.get(vault.toLowerCase());
    if (!leg || !elysiumClient || !config.settlementRelay || relayedLegs.has(leg)) return;
    const legSettled = await elysiumClient.readContract({ address: leg, abi: outcomeLegAbi, functionName: "settled" });
    if (legSettled) {
      relayedLegs.add(leg);
      relaySentAt.delete(leg);
      return;
    }
    if (!shouldRelay(legSettled, relaySentAt.get(leg), Date.now())) return;
    // 998 gas price (basefee + tip) covers the basefee the Inbox charges; a basefee-0 quote reverts every relay.
    const [l1GasPrice, l2GasPrice] = await Promise.all([publicClient.getGasPrice(), elysiumClient.getGasPrice()]);
    const fees = relayFees(l1GasPrice, l2GasPrice);
    relaySentAt.set(leg, Date.now());
    const hash = await sendTx(() =>
      walletClient.writeContract({
        address: config.settlementRelay!,
        abi: settlementRelayAbi,
        functionName: "relay",
        args: [vault, leg, fees.maxSubmissionCost, fees.gasLimit, fees.maxFeePerGas],
        value: fees.value,
        chain,
        account,
      }),
    );
    log("relay sent", vault, leg, fees.value.toString(), hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    if (receipt.status !== "success") {
      alert("relay tx reverted", vault, leg, hash);
      return;
    }
    log("relay confirmed", vault, leg, hash);
  }

  // Status 2 is relayable by anyone and settle() ignores our fraction; status 3 needs the cached fraction — see src/CoreConstants.sol.
  async function settlementLoop(): Promise<void> {
    for (const vault of config.vaultAddresses) {
      const info = vaultInfo.get(vault)!;
      try {
        const settled = await readVault<boolean>(vault, "settled");
        if (settled) {
          settledVaults.add(vault);
          staleAlerted.delete(vault); // settled late (manual relay, or a race won elsewhere) — re-arm
          await relayIfNeeded(vault);
          continue;
        }
        // Staleness tripwire: fires on silence from any cause.
        const expiryMs = config.marketExpiries.get(vault.toLowerCase());
        if (expiryMs !== undefined && Date.now() > expiryMs + SETTLEMENT_STALE_AFTER_MS && !staleAlerted.has(vault)) {
          alert(
            "vault past expiry and still unsettled — nothing is relaying settlement for it",
            vault,
            "expired",
            new Date(expiryMs).toISOString(),
          );
          staleAlerted.add(vault); // once per vault per process; the loop would otherwise alert every tick
        }
        const { status, settledValue, question } = await readOutcomeStatus(publicClient, info.outcome);
        if (status === OUTCOME_ACTIVE) continue;
        if (status === OUTCOME_SETTLED) {
          if (question !== info.question) {
            alert("outcome/question binding mismatch", vault, question, info.question);
            continue;
          }
          const fractionWad = fractionWadFromSettledValue(settledValue);
          // Persist before sending: a crash mid-flight must not lose the only fraction that can still settle.
          rememberFraction(vault, fractionWad);
          log("settling (settled, pre-prune)", vault, fractionWad.toString());
          await settle(vault, fractionWad);
        } else if (status === OUTCOME_PRUNED) {
          const cached = lastKnownFraction.get(vault.toLowerCase());
          if (cached === undefined) {
            alert(
              "outcome pruned before this keeper ever observed it settled — no trustworthy fraction to relay, manual recovery needed",
              vault,
            );
            continue;
          }
          log("settling (relayed from pre-prune observation)", vault, cached.toString());
          await settle(vault, cached);
        }
      } catch (err) {
        alert("settlement check failed", vault, (err as Error).message);
      }
    }
  }

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
    () => balanceLoop().then(() => { lastTick.balance = Date.now(); }),
    (err) => alert("balance loop failed", (err as Error).message),
  );
  every(
    config.pollIntervalMs,
    () => settlementLoop().then(() => { lastTick.settlement = Date.now(); }),
    (err) => alert("settlement loop failed", (err as Error).message),
  );
}
