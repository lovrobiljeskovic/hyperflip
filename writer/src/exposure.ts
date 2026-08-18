interface Reservation {
  risk: bigint;
  vaults: string[];
  expiresAt: number;
}

interface OpenParlay {
  risk: bigint;
  vaults: string[];
}

/** In-memory exposure state (spec §4). Global truth is the on-chain writer allowance —
 * this book only tracks live quote reservations on top of it, plus per-market open
 * exposure (which the flat allowance number cannot break down). Lost on restart by
 * design: reservations expire within the quote TTL, per-market opens are rebuilt from
 * ParlayMinted/ParlayResolved events at startup. */
export class ExposureBook {
  private reservations = new Map<string, Reservation>();
  private open = new Map<string, OpenParlay>();

  /** Maps a lowercase vault address to its correlation cluster; injected so the
   * book can bucket entries recorded before/after registry changes without
   * storing cluster snapshots. Default: no clusters (cluster cap inert). */
  constructor(private clusterOf: (vault: string) => string | undefined = () => undefined) {}

  private pruneExpired(now: number): void {
    for (const [id, r] of this.reservations) {
      if (r.expiresAt <= now) this.reservations.delete(id);
    }
  }

  reservedGlobal(now: number): bigint {
    this.pruneExpired(now);
    let sum = 0n;
    for (const r of this.reservations.values()) sum += r.risk;
    return sum;
  }

  perMarket(vault: string, now: number): bigint {
    this.pruneExpired(now);
    const v = vault.toLowerCase();
    let sum = 0n;
    for (const r of this.reservations.values()) if (r.vaults.includes(v)) sum += r.risk;
    for (const o of this.open.values()) if (o.vaults.includes(v)) sum += o.risk;
    return sum;
  }

  perCluster(cluster: string, now: number): bigint {
    this.pruneExpired(now);
    const inCluster = (vs: string[]) => vs.some((v) => this.clusterOf(v) === cluster);
    let sum = 0n;
    for (const r of this.reservations.values()) if (inCluster(r.vaults)) sum += r.risk;
    for (const o of this.open.values()) if (inCluster(o.vaults)) sum += o.risk;
    return sum;
  }

  check(
    risk: bigint,
    vaults: string[],
    allowance: bigint,
    perMarketCap: bigint,
    now: number,
    perClusterCap?: bigint,
  ): { ok: true } | { ok: false; reason: "at-capacity" | "market-cap" | "cluster-cap" } {
    if (risk > allowance - this.reservedGlobal(now)) return { ok: false, reason: "at-capacity" };
    for (const v of vaults) {
      if (this.perMarket(v, now) + risk > perMarketCap) return { ok: false, reason: "market-cap" };
    }
    if (perClusterCap !== undefined) {
      const clusters = new Set<string>();
      for (const v of vaults) {
        const c = this.clusterOf(v.toLowerCase());
        if (c !== undefined) clusters.add(c);
      }
      for (const c of clusters) {
        if (this.perCluster(c, now) + risk > perClusterCap) return { ok: false, reason: "cluster-cap" };
      }
    }
    return { ok: true };
  }

  reserve(quoteId: string, risk: bigint, vaults: string[], expiresAt: number): void {
    this.reservations.set(quoteId, { risk, vaults: vaults.map((v) => v.toLowerCase()), expiresAt });
  }

  /** Undo a reservation that never became a mint (e.g. signing failed after reserve). */
  release(quoteId: string): void {
    this.reservations.delete(quoteId);
  }

  onMinted(quoteId: string, parlayId: string, risk: bigint, vaults: string[]): void {
    this.reservations.delete(quoteId);
    this.open.set(parlayId, { risk, vaults: vaults.map((v) => v.toLowerCase()) });
  }

  onResolved(parlayId: string): void {
    this.open.delete(parlayId);
  }
}
