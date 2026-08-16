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
  deltaMatches,
  evmToOutcomeWei,
  fractionWadFromSettledValue,
  opKey,
  type OpType,
} from "./pure.js";

const STATUS_PENDING = 0;

interface VaultInfo {
  outcome: number;
  question: number;
  evmUnitsPerShare: bigint;
  verifier: Address;
}

interface PendingOp {
  vault: Address;
  opId: bigint;
  opType: OpType;
  weiAmount: bigint;
  coinId: bigint;
  baseline: bigint | null;
  firstSeenAt: number;
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
  const pendingOps = new Map<string, PendingOp>(); // key: `${vault}:${opId}`
  const lastKnownFraction = new Map<Address, bigint>(); // settlement fraction observed pre-prune

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

  function track(vault: Address, opId: bigint, opType: OpType, weiAmount: bigint, info: VaultInfo): void {
    const mapKey = `${vault}:${opId}`;
    if (pendingOps.has(mapKey)) return;
    pendingOps.set(mapKey, {
      vault,
      opId,
      opType,
      weiAmount,
      coinId: coinIdForOutcome(info.outcome, true),
      baseline: null,
      firstSeenAt: Date.now(),
    });
    log("tracking op", vault, opId.toString(), opType === 0 ? "Split" : "Merge");
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
    track(vault, opId, opType, weiAmount, info);
  }

  // Stateless rebuild: the vault allows at most one open op at a time (_requireIdle), so its own
  // pendingDeposit/pendingRedeem state on-chain IS the pending-op set on restart — no OpQueued
  // log replay needed. (See balanceLoop's baseline comment for the one gap this leaves.)
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
        for (const l of logs) {
          const { args } = l as unknown as { args: { opId: bigint; opType: number; weiAmount: bigint } };
          track(vault, args.opId, Number(args.opType) as OpType, args.weiAmount, info);
        }
      },
      onError: (err) => alert("watchContractEvent error", vault, err.message),
    });
  }

  async function attest(vault: Address, opId: bigint, executed: boolean): Promise<void> {
    const info = vaultInfo.get(vault)!;
    const key = opKey(vault, opId);
    try {
      await walletClient.writeContract({
        address: info.verifier,
        abi: keeperVerifierAbi,
        functionName: "attest",
        args: [key, executed],
        chain,
        account,
      });
      log("attested", vault, opId.toString(), executed);
    } catch (err) {
      alert("attest failed", vault, opId.toString(), (err as Error).message);
    }
  }

  // Balance-verification loop. Baseline = the coin balance the first time we observe a pending
  // op. Core executes split/merge asynchronously ("a few seconds", FINDINGS.md), so a baseline
  // taken right when the op is first seen is pre-execution in practice for LIVE-detected ops.
  //
  // ponytail: known gap for ops REBUILT from pendingDeposit/pendingRedeem after a restart — if
  // Core already executed the op before this process started, "first observed" balance is really
  // the post-execution balance, and the delta check can never fire (false negative -> executed
  // wrongly attested false after the timeout). Upgrade path: a small on-disk baseline cache keyed
  // by opKey, written before the first balance read and consulted on boot, if this proves to
  // matter in practice — the stateless design accepts the gap for v1.
  async function balanceLoop(): Promise<void> {
    for (const [mapKey, op] of pendingOps) {
      try {
        const current = await fetchCoinBalanceWei(config.infoApiUrl, op.vault, op.coinId);
        if (op.baseline === null) {
          pendingOps.set(mapKey, { ...op, baseline: current });
          continue;
        }
        if (deltaMatches(op.baseline, current, op.opType, op.weiAmount)) {
          await attest(op.vault, op.opId, true);
          pendingOps.delete(mapKey);
        } else if (Date.now() - op.firstSeenAt > config.balanceTimeoutMs) {
          // Failed-attestation rule: attest executed=false only on positive evidence of a
          // dropped op if such evidence exists. Core gives none — a rejected split/merge is
          // silent (FINDINGS.md step 5: oversized send rejected with no error, no event, no
          // balance change). So a generous no-delta timeout is KEEPER-SIDE POLICY, not something
          // the chain trusts: it only decides which verdict this keeper attests, never proves
          // anything on its own. If the keeper is wrong here the owner can always swap it out via
          // OutcomeVault.setVerifier — that recovery path, not this timeout, is the trust anchor.
          alert("balance timeout with no delta, attesting executed=false", op.vault, op.opId.toString());
          await attest(op.vault, op.opId, false);
          pendingOps.delete(mapKey);
        }
      } catch (err) {
        alert("balance check failed", op.vault, op.opId.toString(), (err as Error).message);
      }
    }
  }

  async function settle(vault: Address, fractionWad: bigint): Promise<void> {
    try {
      await walletClient.writeContract({
        address: vault,
        abi: outcomeVaultAbi,
        functionName: "settle",
        args: [fractionWad],
        chain,
        account,
      });
      log("settle() sent", vault, fractionWad.toString());
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
