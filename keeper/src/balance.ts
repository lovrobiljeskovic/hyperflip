import { alert, log } from "../../services/log.mjs";
import { encodedOutcomeAssetId, readSpotBalanceWei } from "../../services/precompiles.mjs";
import { zeroAddress, type Address } from "viem";
import { keeperVerifierAbi, outcomeVaultAbi } from "./abi.js";
import {
  evmToOutcomeWei,
  newestSampleBefore,
  opKey,
  resolveBalanceCheck,
  type BalanceSample,
  type OpType,
} from "./pure.js";
import { RECEIPT_TIMEOUT_MS, type KeeperState, type PendingOp, type VaultInfo } from "./state.js";

const STATUS_PENDING = 0;
/** Ambient samples kept per vault, in ticks: longer than the ~4s event poll so a pre-op sample is usually in hand. */
const HISTORY_LIMIT = 20;
/** Keeper clock behind chain time makes a post-op sample look pre-op; assumes skew ≤ this. */
const CLOCK_SKEW_MARGIN_MS = 2_000;
/** A stalled sampler must not serve an old balance as a confident baseline. */
const MAX_SAMPLE_AGE_MS = 60_000;

export function createBalanceLoop(state: KeeperState) {
  const { config, chain, account, publicClient, walletClient, sendTx, vaultInfo, settledVaults, readVault } = state;
  const pendingOps = new Map<Address, PendingOp>();
  // Consecutive failed balance-read samples per vault — throttles the alert, nothing else.
  const sampleFailures = new Map<string, number>();
  const balanceHistory = new Map<Address, BalanceSample[]>(); // ambient yes-coin samples, per vault

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
    track(vault, opId, opType, weiAmount, null, false); // rebuilt: no provable pre-op baseline exists
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

  // Live detection going forward: poll-based watcher (works over plain HTTP transport).
  function watchOpQueued(): void {
    for (const vault of config.vaultAddresses) {
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
              track(vault, args.opId, Number(args.opType) as OpType, args.weiAmount, baseline, confident);
            }
          })().catch((err) => alert("OpQueued handler crashed", vault, (err as Error).message));
        },
        onError: (err) => alert("watchContractEvent error", vault, err.message),
      });
    }
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
  async function tick(): Promise<void> {
    for (const vault of config.vaultAddresses) {
      if (settledVaults.has(vault)) continue;
      const info = vaultInfo.get(vault)!;
      const assetId = encodedOutcomeAssetId(info.outcome, true);
      let current: bigint;
      try {
        current = await readSpotBalanceWei(publicClient, vault, assetId);
      } catch (err) {
        // Settled vault (startup race before the settlement loop's first tick, or settled since last
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

  return { seedPendingOps, watchOpQueued, tick };
}
