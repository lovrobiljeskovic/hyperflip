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

  check(
    risk: bigint,
    vaults: string[],
    allowance: bigint,
    perMarketCap: bigint,
    now: number,
  ): { ok: true } | { ok: false; reason: "at-capacity" | "market-cap" } {
    if (risk > allowance - this.reservedGlobal(now)) return { ok: false, reason: "at-capacity" };
    for (const v of vaults) {
      if (this.perMarket(v, now) + risk > perMarketCap) return { ok: false, reason: "market-cap" };
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
