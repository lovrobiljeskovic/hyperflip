type Row = { vault: string; sourceVault?: string | null };

/**
 * Registry rows are written Elysium-first: `vault` is the OutcomeLeg the Elysium ParlayVault reads,
 * `sourceVault` the 998 OutcomeVault behind it. A Core-chain reader swaps them, so both lanes share
 * one registry file. A row without `sourceVault` is a 998-only address (pre-cutover or foreign venue);
 * the bridged lane drops it, because the same deployer nonce on both chains makes such an address
 * collide with a live leg and the app labels legs by address.
 */
export function laneRows<T extends Row>(rows: T[], chainId: number, coreChainId: number): T[] {
  if (chainId !== coreChainId) return rows.filter((row) => row.sourceVault);
  return rows.map(({ sourceVault, ...row }) => (sourceVault ? { ...row, vault: sourceVault } : row) as T);
}

/** The 998 OutcomeVault (the Core account) behind any row. */
export function coreVault(row: Row): string {
  return row.sourceVault ?? row.vault;
}
