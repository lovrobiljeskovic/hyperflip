import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  zeroAddress,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { keeperVerifierAbi, outcomeVaultAbi } from "./abi.js";
import type { KeeperConfig } from "./config.js";
import { OUTCOME_ACTIVE, OUTCOME_PRUNED, OUTCOME_SETTLED, readOutcomeStatus } from "./core814.js";
import { fetchCoinBalanceWei } from "./infoApi.js";
import {
  coinIdForOutcome,
  evmToOutcomeWei,
  fractionWadFromSettledValue,
  newestSampleBefore,
  opKey,
  resolveBalanceCheck,
  type BalanceSample,
  type OpType,
} from "./pure.js";

const STATUS_PENDING = 0;
/** How long to wait for a submitted attest()/settle() tx to mine before treating it as failed. */
const RECEIPT_TIMEOUT_MS = 60_000;
/** Ambient balance-sample history kept per vault, in ticks — comfortably longer than
 * watchContractEvent's ~4s default poll interval, so a sample provably pre-dating a just-detected
 * OpQueued block is almost always already in hand. See sampleBefore. */
const HISTORY_LIMIT = 20;

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
  coinId: bigint;
  baseline: bigint | null;
  firstSeenAt: number;
  /** true only when `baseline` is PROVABLY pre-execution: a rolling ambient sample read strictly
   * before the OpQueued block's own timestamp (Core cannot execute an action before the block
   * containing it exists — see resolveLiveBaseline/sampleBefore). false whenever that can't be
   * established — a rebuilt op after restart, or a live op with no qualifying ambient sample yet
   * (e.g. right after startup) falls back to a best-effort read that is NOT provably pre-op. */
  confidentBaseline: boolean;
  /** Suppresses repeat alerts once a low-confidence op has already been flagged as held. */
  holdAlerted: boolean;
}

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}
function alert(...args: unknown[]): void {
  console.error(new Date().toISOString(), "ALERT", ...args);
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runKeeper(config: KeeperConfig): Promise<void> {
  const account = privateKeyToAccount(config.keeperPrivateKey);
  const chain = defineChain({
    id: 998,
    name: "HyperEVM Testnet",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  const transport = http(config.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });

  const vaultInfo = new Map<Address, VaultInfo>();
  const pendingOps = new Map<Address, PendingOp>();
  const lastKnownFraction = new Map<Address, bigint>(); // settlement fraction observed pre-prune
  const balanceHistory = new Map<Address, BalanceSample[]>(); // ambient yes-coin samples, per vault

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
    return newestSampleBefore(balanceHistory.get(vault) ?? [], beforeMs);
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
      coinId: coinIdForOutcome(info.outcome, true),
      baseline,
      firstSeenAt: Date.now(),
      confidentBaseline,
      holdAlerted: false,
    });
    log("tracking op", vault, opId.toString(), opType === 0 ? "Split" : "Merge", "confident:", confidentBaseline);
  }

  /** Resolves a baseline for a live-detected op from the rolling ambient sample history (remedy
   * for the timing race: a synchronous read at detection time can already be post-execution,
   * since Core may execute before the watcher even notices the log). Falls back to a best-effort
   * immediate read — explicitly marked NOT confident — only when no provable sample exists yet. */
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
      const current = await fetchCoinBalanceWei(config.infoApiUrl, vault, coinIdForOutcome(info.outcome, true));
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

  // Stateless rebuild: the vault allows at most one open op at a time (_requireIdle), so its own
  // pendingDeposit/pendingRedeem state on-chain IS the pending-op set on restart — no OpQueued
  // log replay needed. (See balanceLoop for how a rebuilt op's uncertain baseline is handled.)
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

  /** Submits attest(), waits for it to mine, and reports whether it actually landed. Returning
   * false (rather than swallowing every error) lets balanceLoop keep retrying instead of
   * abandoning the op — a transient RPC/nonce/gas error must not silently drop tracking. */
  async function attest(vault: Address, opId: bigint, executed: boolean): Promise<boolean> {
    const info = vaultInfo.get(vault)!;
    const key = opKey(vault, opId);
    try {
      const hash = await walletClient.writeContract({
        address: info.verifier,
        abi: keeperVerifierAbi,
        functionName: "attest",
        args: [key, executed],
        chain,
        account,
      });
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
        // A verdict is already recorded on-chain (this keeper's own earlier attempt, or a race)
        // — nothing left for local retry to do, whatever that verdict was.
        alert("already attested (prior attempt or race) — dropping local tracking", vault, opId.toString());
        return true;
      }
      alert("attest failed", vault, opId.toString(), msg);
      return false;
    }
  }

  // Balance-verification loop. Also doubles as the ambient sampler: every tick it reads and
  // records each vault's yes-coin balance regardless of whether an op is pending, so
  // resolveLiveBaseline almost always has a provably pre-execution sample in hand the moment an
  // OpQueued log is noticed. Only ops with confidentBaseline may reach attest(executed=false) on
  // timeout — see the failed-attestation-rule comment below; everything else times out to "hold".
  // ponytail: a held op (no confident baseline ever established, e.g. a rebuilt op) stays pending
  // forever if it truly dropped on Core — recovery is manual/owner-driven (setVerifier), same as
  // any other case this design defers to the owner rather than trusting elapsed time.
  async function balanceLoop(): Promise<void> {
    for (const vault of config.vaultAddresses) {
      const info = vaultInfo.get(vault)!;
      const coinId = coinIdForOutcome(info.outcome, true);
      let current: bigint;
      try {
        current = await fetchCoinBalanceWei(config.infoApiUrl, vault, coinId);
      } catch (err) {
        alert("balance sample failed", vault, (err as Error).message);
        continue;
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
          // Failed-attestation rule: attest executed=false only on positive evidence of a
          // dropped op if such evidence exists. Core gives none — a rejected split/merge is
          // silent (FINDINGS.md step 5: oversized send rejected with no error, no event, no
          // balance change). So a generous no-delta timeout is KEEPER-SIDE POLICY, not something
          // the chain trusts: it only decides which verdict this keeper attests, never proves
          // anything on its own. If the keeper is wrong here the owner can always swap it out via
          // OutcomeVault.setVerifier — that recovery path, not this timeout, is the trust anchor.
          alert("balance timeout with no delta, attesting executed=false", vault, op.opId.toString());
        }
        if (await attest(vault, op.opId, verdict === "attest-true")) pendingOps.delete(vault);
      } catch (err) {
        alert("balance check failed", vault, op.opId.toString(), (err as Error).message);
      }
    }
  }

  /** Submits settle() and waits for it to mine before returning, so settlementLoop's next tick
   * for this vault can't fire a duplicate while the first is still in flight. */
  async function settle(vault: Address, fractionWad: bigint): Promise<void> {
    try {
      const hash = await walletClient.writeContract({
        address: vault,
        abi: outcomeVaultAbi,
        functionName: "settle",
        args: [fractionWad],
        chain,
        account,
      });
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

  // Settlement watcher: 0x814 status 2 (settled) is trustlessly relayable by anyone, and settle()
  // ignores our fractionWad there. Status 3 (pruned) is the keeper-relay path — Core prunes fast
  // (FINDINGS.md: 2->3 observed within ~10 minutes), so this crank must fire promptly on status 2,
  // and cache the fraction in case the tx lands after pruning flips status to 3.
  async function settlementLoop(): Promise<void> {
    for (const vault of config.vaultAddresses) {
      const info = vaultInfo.get(vault)!;
      try {
        const settled = await readVault<boolean>(vault, "settled");
        if (settled) continue;
        const { status, settledValue, question } = await readOutcomeStatus(publicClient, info.outcome);
        if (status === OUTCOME_ACTIVE) continue;
        if (status === OUTCOME_SETTLED) {
          if (question !== info.question) {
            alert("outcome/question binding mismatch", vault, question, info.question);
            continue;
          }
          const fractionWad = fractionWadFromSettledValue(settledValue);
          lastKnownFraction.set(vault, fractionWad);
          log("settling (settled, pre-prune)", vault, fractionWad.toString());
          await settle(vault, fractionWad);
        } else if (status === OUTCOME_PRUNED) {
          const cached = lastKnownFraction.get(vault);
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
  for (;;) {
    await Promise.all([balanceLoop(), settlementLoop()]);
    await sleep(config.pollIntervalMs);
  }
}
