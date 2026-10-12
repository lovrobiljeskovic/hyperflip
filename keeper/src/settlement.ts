import { readOptionalFile, replaceFile } from "../../services/files.mjs";
import { alert, log } from "../../services/log.mjs";
import { OUTCOME_ACTIVE, OUTCOME_PRUNED, OUTCOME_SETTLED, readOutcomeStatus } from "../../services/precompiles.mjs";
import { parseAbi, type Address } from "viem";
import { outcomeVaultAbi } from "./abi.js";
import {
  decodeFractionCache,
  encodeFractionCache,
  fractionWadFromSettledValue,
  relayFees,
  shouldRelay,
} from "./pure.js";
import { RECEIPT_TIMEOUT_MS, type KeeperState } from "./state.js";

/** Unsettled this long past registry expiry raises an alert: a loose tripwire, not a deadline. */
const SETTLEMENT_STALE_AFTER_MS = 15 * 60_000;
/** Elysium settlement path (src/SettlementRelay.sol, src/OutcomeLeg.sol): three calls, hand-written, not generated. */
const settlementRelayAbi = parseAbi([
  "function relay(address vault, address leg, uint256 maxSubmissionCost, uint256 gasLimit, uint256 maxFeePerGas) payable returns (uint256)",
]);
const outcomeLegAbi = parseAbi(["function settled() view returns (bool)"]);

export function loadFractionCache(file: string): Map<string, bigint> {
  const json = readOptionalFile(file);
  return json === undefined ? new Map() : decodeFractionCache(json);
}

export function saveFraction(cache: Map<string, bigint>, file: string, vault: string, fraction: bigint): void {
  // Keep the observation available to this process even if the disk fails.
  cache.set(vault.toLowerCase(), fraction);
  replaceFile(file, encodeFractionCache(cache));
}

export function createSettlementLoop(state: KeeperState) {
  const { config, chain, account, publicClient, elysiumClient, walletClient, sendTx, vaultInfo, settledVaults, lastKnownFraction, readVault } = state;
  const staleAlerted = new Set<Address>(); // suppresses repeat past-expiry alerts, per vault
  const relaySentAt = new Map<Address, number>();
  const relayedLegs = new Set<Address>();

  function rememberFraction(vault: Address, fractionWad: bigint): void {
    try {
      saveFraction(lastKnownFraction, config.settlementCachePath, vault, fractionWad);
    } catch (err) {
      // In-memory copy still works for this process; only a restart would lose it.
      alert("could not persist settlement cache", config.settlementCachePath, (err as Error).message);
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
  async function tick(): Promise<void> {
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

  return { tick };
}
