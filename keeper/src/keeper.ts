import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  zeroAddress,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { keeperVerifierAbi, outcomeVaultAbi } from "./abi.js";
import type { KeeperConfig } from "./config.js";
import { OUTCOME_ACTIVE, OUTCOME_PRUNED, OUTCOME_SETTLED, readOutcomeStatus, readSpotBalanceWei } from "./core814.js";
import { readFileSync, writeFileSync } from "node:fs";
import {
  blockChunks,
  decodeFractionCache,
  encodedOutcomeAssetId,
  encodeFractionCache,
  evmToOutcomeWei,
  fractionWadFromSettledValue,
  opKey,
  resolveBalanceCheck,
  type OpType,
} from "./pure.js";

const STATUS_PENDING = 0;
/** How long to wait for a submitted attest()/settle() tx to mine before treating it as failed. */
const RECEIPT_TIMEOUT_MS = 60_000;
/** How far past a market's registry expiry a vault may sit unsettled before the keeper alerts.
 * Core needs some time to move a market from active to settled, so this is deliberately loose —
 * it is a "nobody is settling this" tripwire, not a deadline. It exists because a keeper that is
 * dead, misconfigured, or watching the wrong vault list looks exactly like a healthy one from the
 * outside; that silence is what let the 8/19 vaults expire, prune, and strand unnoticed. */
const SETTLEMENT_STALE_AFTER_MS = 15 * 60_000;
/** ~2h at ~1s blocks; CANCEL_TIMEOUT (1h) bounds how old a live pending op can usefully be. */
const OP_LOOKBACK_BLOCKS = 7_200n;
/** Official endpoint's getLogs span cap (see rpc-check.mjs finding 2). */
const GETLOGS_CHUNK = 1_000n;

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
  assetId: bigint;
  baseline: bigint | null;
  firstSeenAt: number;
  /** true only when `baseline` is PROVABLY pre-execution: a 0x801 read pinned to the OpQueued
   * block (see resolveBaseline). false whenever that can't be established — a rebuilt op whose
   * OpQueued log is beyond the lookback window, or a failed pinned read, falls back to a
   * best-effort latest read that is NOT provably pre-op. */
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
  // TESTNET_RPC takes a comma-separated list; viem's fallback tries them in order. The primary
  // endpoint is a free public service with no SLA, and an unusable RPC is exactly what stranded
  // the 8/19 vaults, so a second one costs nothing to keep behind it. Note the whole list must
  // serve the 0x814 precompile — see keeper/rpc-check.mjs.
  const rpcUrls = config.rpcUrl.split(",").map((u) => u.trim()).filter(Boolean);
  const chain = defineChain({
    id: 998,
    name: "HyperEVM Testnet",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: { default: { http: rpcUrls } },
  });
  // Testnet RPCs rate-limit bursts (-32005 limit exceeded, which viem treats as retryable);
  // startup alone reads 4 calls per vault. Retry hard with a long backoff instead of crashing
  // on a transient limiter, then fall through to the next endpoint.
  const transport = fallback(rpcUrls.map((u) => http(u, { retryCount: 6, retryDelay: 2_000 })));
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });

  const vaultInfo = new Map<Address, VaultInfo>();
  const pendingOps = new Map<Address, PendingOp>();
  // Settlement fractions observed pre-prune. Persisted, because Core prunes within ~10 minutes
  // and the pruned relay path can only replay a fraction this keeper saw at status 2 — a restart
  // inside that window used to destroy the only number that could still settle the vault. Keys
  // are lowercased vault addresses (see encodeFractionCache).
  let lastKnownFraction: Map<string, bigint>;
  try {
    lastKnownFraction = decodeFractionCache(readFileSync(config.settlementCachePath, "utf8"));
    if (lastKnownFraction.size > 0) log("loaded settlement cache", lastKnownFraction.size, "entries");
  } catch {
    lastKnownFraction = new Map(); // absent on first run; a cold cache is not an error
  }

  function rememberFraction(vault: Address, fractionWad: bigint): void {
    lastKnownFraction.set(vault.toLowerCase(), fractionWad);
    try {
      writeFileSync(config.settlementCachePath, encodeFractionCache(lastKnownFraction));
    } catch (err) {
      // In-memory copy still works for this process; only a restart would lose it.
      alert("could not persist settlement cache", config.settlementCachePath, (err as Error).message);
    }
  }
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
      assetId: encodedOutcomeAssetId(info.outcome, true),
      baseline,
      firstSeenAt: Date.now(),
      confidentBaseline,
      holdAlerted: false,
    });
    log("tracking op", vault, opId.toString(), opType === 0 ? "Split" : "Merge", "confident:", confidentBaseline);
  }

  /** Baseline for an op. A read pinned to the OpQueued block is provably pre-execution BY
   * CONSTRUCTION — precompile values match Core state at block construction, and Core cannot
   * execute an action before the block containing it exists — so no wall-clock provenance is
   * needed (the sample-history machinery this replaced). `blockNumber === null` (rebuilt op whose
   * OpQueued log is beyond the getLogs lookback) or a failed pinned read falls back to a
   * best-effort latest read that is explicitly NOT confident, preserving the invariant that
   * attest(executed=false) only ever fires on a confident baseline. */
  async function resolveBaseline(
    vault: Address,
    assetId: bigint,
    blockNumber: bigint | null,
  ): Promise<{ baseline: bigint | null; confident: boolean }> {
    if (blockNumber !== null) {
      try {
        const b = await readSpotBalanceWei(publicClient, vault, assetId, blockNumber);
        return { baseline: b, confident: true };
      } catch (err) {
        alert("pinned baseline read failed, falling back to unconfident latest", vault, (err as Error).message);
      }
    }
    try {
      const b = await readSpotBalanceWei(publicClient, vault, assetId);
      return { baseline: b, confident: false };
    } catch (err) {
      alert("fallback baseline read also failed", vault, (err as Error).message);
      return { baseline: null, confident: false };
    }
  }

  /** OpQueued block for a rebuilt op, or null when it is beyond the lookback — the vault stores
   * no queue block, so the log is the only source. opId is indexed, so the RPC filters it. */
  async function findOpQueuedBlock(vault: Address, opId: bigint): Promise<bigint | null> {
    const head = await publicClient.getBlockNumber();
    for (const { from, to } of blockChunks(head, OP_LOOKBACK_BLOCKS, GETLOGS_CHUNK)) {
      const logs = await publicClient.getContractEvents({
        address: vault,
        abi: outcomeVaultAbi,
        eventName: "OpQueued",
        args: { opId },
        fromBlock: from,
        toBlock: to,
      });
      if (logs.length > 0) return logs[0].blockNumber;
    }
    return null; // ponytail: beyond the 7200-block window stays unconfident/hold; archive-node getLogs if it ever occurs
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
    const queuedAt = await findOpQueuedBlock(vault, opId);
    const { baseline, confident } = await resolveBaseline(vault, encodedOutcomeAssetId(info.outcome, true), queuedAt);
    track(vault, opId, opType, weiAmount, info, baseline, confident);
  }

  // Stateless rebuild: the vault allows at most one open op at a time (_requireIdle), so its own
  // pendingDeposit/pendingRedeem state on-chain IS the pending-op set on restart — no OpQueued
  // log replay needed. A rebuilt op recovers a confident baseline via the OpQueued log whenever it
  // is within OP_LOOKBACK_BLOCKS (see trackIfStillPending/findOpQueuedBlock); beyond that it falls
  // back to an unconfident baseline.
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
            const { baseline, confident } = await resolveBaseline(vault, encodedOutcomeAssetId(info.outcome, true), blockNumber);
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

  // Balance-verification loop. Reads happen only while an op is pending — the ambient
  // sampler role died with the info API: baselines now come from block-pinned precompile
  // reads, not from a history of wall-clock samples.
  async function balanceLoop(): Promise<void> {
    for (const [vault, op] of pendingOps) {
      let current: bigint;
      try {
        current = await readSpotBalanceWei(publicClient, vault, op.assetId);
      } catch (err) {
        alert("balance read failed", vault, (err as Error).message.split("\n")[0].slice(0, 200));
        continue;
      }
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
          // silent. The generous no-delta timeout is KEEPER-SIDE POLICY — the recovery anchor
          // remains OutcomeVault.setVerifier, not this timeout.
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
        if (settled) {
          staleAlerted.delete(vault); // settled late (manual relay, or a race won elsewhere) — re-arm
          continue;
        }
        // Staleness tripwire. Fires regardless of WHY nothing settled — dead keeper, wrong vault
        // list, RPC down, Core never settling — which is the point: the failure that stranded the
        // 8/19 vaults was silence, and every cause of silence looks identical from outside.
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
          // Persist BEFORE sending: if settle() fails or this process dies mid-flight, the
          // fraction has to outlive the attempt or the prune strands the vault for good.
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

  // The two loops run on independent cadences — they used to share one
  // Promise.all tick, so a single wedged await in balance sampling froze
  // settlement for hours (the 0x232a strand, 2026-08-22) and the vault missed
  // Core's ~10-minute settle→prune window for good.
  const lastTick = { balance: Date.now(), settlement: Date.now() };

  // Watchdog: a hung await never throws, so from outside the process looks
  // healthy while doing nothing — the exact failure mode twice now. Every tick
  // is bounded (fetch 10s, receipt waits RECEIPT_TIMEOUT_MS), so a stamp older
  // than the worst legitimate tick means a true hang: exit and let systemd
  // (Restart=always) bring us back with fresh sockets. setInterval still fires
  // while a promise hangs — the event loop itself is alive.
  const stallAfterMs = config.vaultAddresses.length * RECEIPT_TIMEOUT_MS + 120_000;
  setInterval(() => {
    for (const [name, t] of Object.entries(lastTick)) {
      if (Date.now() - t > stallAfterMs) {
        alert(`${name} loop stalled for ${Date.now() - t}ms — exiting so systemd restarts us`);
        process.exit(1);
      }
    }
  }, 10_000);

  async function run(name: keyof typeof lastTick, tick: () => Promise<void>): Promise<never> {
    for (;;) {
      await tick();
      lastTick[name] = Date.now();
      await sleep(config.pollIntervalMs);
    }
  }
  await Promise.all([run("balance", balanceLoop), run("settlement", settlementLoop)]);
}
