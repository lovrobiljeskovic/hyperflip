import type { Address, Chain, PublicClient, Transport, WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { KeeperConfig } from "./config.js";
import type { OpType } from "./pure.js";

/** How long to wait for a submitted attest()/settle() tx to mine before treating it as failed. */
export const RECEIPT_TIMEOUT_MS = 60_000;

export interface VaultInfo {
  outcome: number;
  question: number;
  evmUnitsPerShare: bigint;
  verifier: Address;
}

/** At most one per vault — the vault itself enforces this (_requireIdle), so vault is the map key. */
export interface PendingOp {
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

/** What runKeeper builds once and the balance and settlement loops share. */
export interface KeeperState {
  config: KeeperConfig;
  chain: Chain;
  account: PrivateKeyAccount;
  publicClient: PublicClient<Transport, Chain>;
  elysiumClient: PublicClient | undefined;
  walletClient: WalletClient<Transport, Chain, PrivateKeyAccount>;
  sendTx: <T>(fn: () => Promise<T>) => Promise<T>;
  vaultInfo: Map<Address, VaultInfo>;
  pendingOps: Map<Address, PendingOp>;
  settledVaults: Set<Address>;
  lastKnownFraction: Map<string, bigint>;
  readVault: <T>(vault: Address, functionName: string, args?: readonly unknown[]) => Promise<T>;
}
