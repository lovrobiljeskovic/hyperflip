import crypto from "node:crypto";
import { readOptionalFile, replaceFile } from "../../services/files.mjs";

export interface WaitlistEntry {
  email: string;
  code: string;
  /** ms epoch of signup — the funding-metrics growth curve lives here. */
  ts: number;
}

/** Pragmatic format check, not RFC 5321 — Resend bounces anything undeliverable. */
export function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Disk-backed email→invite-code store. One JSON array, rewritten atomically on
 * every signup — fine at beta scale (thousands, not millions). */
export class Waitlist {
  private entries: WaitlistEntry[];
  private failed = false;
  private codes = new Set<string>();
  private byEmail = new Map<string, WaitlistEntry>();

  constructor(
    private file: string,
    private now: () => number = Date.now,
  ) {
    const json = readOptionalFile(file);
    try {
      this.entries = json === undefined ? [] : JSON.parse(json);
      if (!Array.isArray(this.entries)) throw new Error();
      for (const e of this.entries) {
        if (!e || typeof e.email !== "string" || !isValidEmail(e.email) || e.email !== e.email.trim().toLowerCase() ||
            typeof e.code !== "string" || !e.code.trim() || !Number.isFinite(e.ts) || e.ts < 0 ||
            this.byEmail.has(e.email) || this.codes.has(e.code)) throw new Error();
        this.codes.add(e.code);
        this.byEmail.set(e.email, e);
      }
    } catch { throw new Error("Invalid waitlist; preserve and repair it before restarting"); }
  }

  has(code: string): boolean {
    return this.codes.has(code);
  }

  size(): number {
    return this.entries.length;
  }

  /** Idempotent: a repeat signup returns the same code so the email can simply
   * be re-sent instead of leaking one code per retry. */
  signup(rawEmail: string): { code: string; isNew: boolean } {
    if (this.failed) throw new Error("Waitlist save failed; inspect the file and restart before signup");
    const email = rawEmail.trim().toLowerCase();
    if (!isValidEmail(email)) throw new Error("Invalid email");
    const existing = this.byEmail.get(email);
    if (existing) return { code: existing.code, isNew: false };
    let code: string;
    do { code = `OVR-${crypto.randomBytes(3).toString("hex").toUpperCase()}`; } while (this.codes.has(code));
    const entry: WaitlistEntry = { email, code, ts: this.now() };
    try { replaceFile(this.file, JSON.stringify([...this.entries, entry], null, 2)); }
    catch (error) {
      this.failed = true;
      throw error;
    }
    this.entries.push(entry);
    this.codes.add(code);
    this.byEmail.set(email, entry);
    return { code, isNew: true };
  }
}

/** Sliding-window per-IP limiter for the public signup endpoint — guards the
 * Resend quota and the disk file, nothing more.
 * ponytail: in-memory, resets on restart; move to disk if abuse ever matters. */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}

/** One fetch to Resend — no SDK for a single POST. Throws on non-2xx. */
export async function sendInviteEmail(apiKey: string, to: string, code: string): Promise<void> {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Overround <invites@overround.xyz>",
      to: [to],
      subject: "Your Overround beta invite",
      text: [
        `Your invite code: ${code}`,
        "",
        "Paste it into the builder at https://overround.xyz/build and it rides along with every quote you request.",
        "",
        "Testnet funds: claim mock USDC at https://app.hyperliquid-testnet.xyz/drip, then transfer from Core to EVM for gas and stakes.",
      ].join("\n"),
    }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`);
}
