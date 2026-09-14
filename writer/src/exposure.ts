interface Reservation {
  risk: bigint;
  vaults: string[];
  expiresAt: number;
  /** Quota identity the reservation counts against — the invite code, not the
   * taker address. Codes are limited-supply and gate /quote already, so rotating
   * them is not free (unlike addresses), and spam naming a victim's address burns
   * the attacker's own code budget. Opaque exact-match string: the invite gate
   * only admits canonical codes, so no case normalization here. */
  quotaKey: string;
}

interface OpenParlay {
  risk: bigint;
  vaults: string[];
}

/** In-memory exposure state (spec §4). Global truth is the on-chain writer allowance —
 * this book only tracks live quote reservations on top of it, plus per-market open
 * exposure (which the flat allowance number cannot break down). Lost on restart by
 * design: reservations expire within the quote TTL (+ grace, see below); per-market
 * opens are rebuilt from on-chain state at startup (Poker.seed(), mainnet-hardening
 * P1-6) instead of replaying ParlayMinted/ParlayResolved from genesis. */
export class ExposureBook {
  private reservations = new Map<string, Reservation>();
  private open = new Map<string, OpenParlay>();

  /** @param clusterOf Maps a lowercase vault address to its competition exposure group;
   * injected so the book can bucket entries recorded before/after registry changes
   * without storing cluster snapshots. Default: no clusters (cluster cap inert).
   * @param reservationGraceMs Keeps an expired-but-undetected reservation counted
   * past its TTL (mainnet-hardening P1-7). Without this, a taker who mints right at
   * the TTL deadline has their risk vanish from the book the instant the reservation
   * expires, but the poker doesn't detect the mint (and re-add it as `open`) until
   * its next tick — up to `pokerIntervalMs` later. A second quote request landing in
   * that gap would see stale headroom and could push real per-market/cluster exposure
   * past the configured cap. `onMinted` still deletes the reservation immediately
   * once the mint IS detected, so a real mint is never double-counted; this grace
   * only delays pruning a reservation nobody has confirmed onto/off chain yet.
   * Default 0 (exact-TTL pruning, pre-P1-7 behavior). */
  constructor(
    private clusterOf: (vault: string) => string | undefined = () => undefined,
    private reservationGraceMs: number = 0,
  ) {}

  private pruneExpired(now: number): void {
    for (const [id, r] of this.reservations) {
      if (r.expiresAt + this.reservationGraceMs <= now) this.reservations.delete(id);
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

  /** Reserved-but-unminted risk for one quota key — the invite code
   * (mainnet-hardening P0-4, re-keyed from taker address). Opens are
   * deliberately excluded: once a reservation converts via onMinted it's covered
   * by the allowance/per-market/per-cluster caps like any other open position,
   * so counting it again here would punish honest sequential minting instead of
   * throttling a caller who never mints. */
  reservedByKey(quotaKey: string, now: number): bigint {
    this.pruneExpired(now);
    let sum = 0n;
    for (const r of this.reservations.values()) if (r.quotaKey === quotaKey) sum += r.risk;
    return sum;
  }

  check(
    risk: bigint,
    vaults: string[],
    allowance: bigint,
    perMarketCap: bigint,
    now: number,
    perClusterCap?: bigint,
    quotaKey?: string,
    perKeyCap?: bigint,
  ): { ok: true } | { ok: false; reason: "at-capacity" | "market-cap" | "cluster-cap" | "quota-cap"; headroom: bigint } {
    // `headroom` is what the binding cap has left. Risk scales linearly with
    // stake, so the caller can turn it into "this ticket fits at stake X"
    // instead of a dead end the taker cannot act on.
    const globalRoom = allowance - this.reservedGlobal(now);
    if (risk > globalRoom) {
      return { ok: false, reason: "at-capacity", headroom: globalRoom > 0n ? globalRoom : 0n };
    }
    for (const v of vaults) {
      const room = perMarketCap - this.perMarket(v, now);
      if (risk > room) return { ok: false, reason: "market-cap", headroom: room > 0n ? room : 0n };
    }
    if (perClusterCap !== undefined) {
      const clusters = new Set<string>();
      for (const v of vaults) {
        const c = this.clusterOf(v.toLowerCase());
        if (c !== undefined) clusters.add(c);
      }
      for (const c of clusters) {
        const room = perClusterCap - this.perCluster(c, now);
        if (risk > room) return { ok: false, reason: "cluster-cap", headroom: room > 0n ? room : 0n };
      }
    }
    if (quotaKey !== undefined && perKeyCap !== undefined) {
      const room = perKeyCap - this.reservedByKey(quotaKey, now);
      if (risk > room) return { ok: false, reason: "quota-cap", headroom: room > 0n ? room : 0n };
    }
    return { ok: true };
  }

  reserve(quoteId: string, risk: bigint, vaults: string[], expiresAt: number, quotaKey: string): void {
    this.reservations.set(quoteId, {
      risk,
      vaults: vaults.map((v) => v.toLowerCase()),
      expiresAt,
      quotaKey,
    });
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
