import { createHash } from "node:crypto";
import { readOptionalFile, replaceFile } from "../../services/files.mjs";

export interface WaitlistEntry {
  email: string;
  code: string | null;
  cohort?: string;
  admittedAt?: number;
  emailedAt?: number;
  privyUserId?: string;
  /** Destination URL acknowledged by the private Sheets integration. */
  sheetSyncedTo?: string;
  /** ms epoch of signup — the funding-metrics growth curve lives here. */
  ts: number;
}

export function validCohort(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
}

/** Pragmatic format check, not RFC 5321 — Resend bounces anything undeliverable. */
export function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** ponytail: one writer owns this file; atomic array rewrites suit thousands of
 * signups. Move to a shared database before running multiple writers. */
export class Waitlist {
  private entries: WaitlistEntry[];
  private failed = false;
  private admitting = false;
  private byEmail = new Map<string, WaitlistEntry>();

  constructor(
    private file: string,
    private now: () => number = Date.now,
  ) {
    const json = readOptionalFile(file);
    try {
      this.entries = json === undefined ? [] : JSON.parse(json);
      if (!Array.isArray(this.entries)) throw new Error();
      const codes = new Set<string>();
      const accounts = new Set<string>();
      for (const e of this.entries) {
        if (!e || typeof e.email !== "string" || !isValidEmail(e.email) || e.email !== e.email.trim().toLowerCase() ||
            !(e.code === null || (typeof e.code === "string" && e.code.trim())) ||
            !Number.isSafeInteger(e.ts) || e.ts < 0 || !Number.isFinite(new Date(e.ts).getTime()) ||
            this.byEmail.has(e.email) || (e.code !== null && codes.has(e.code)) ||
            (e.sheetSyncedTo !== undefined && typeof e.sheetSyncedTo !== "string")) throw new Error();
        if (e.cohort === undefined) {
          if (e.admittedAt !== undefined || e.emailedAt !== undefined) throw new Error();
        } else if (!validCohort(e.cohort) || !Number.isSafeInteger(e.admittedAt) || e.admittedAt! < e.ts ||
                   (e.emailedAt !== undefined && (!Number.isSafeInteger(e.emailedAt) || e.emailedAt < e.admittedAt!))) {
          throw new Error();
        }
        if (e.privyUserId !== undefined) {
          if (typeof e.privyUserId !== "string" || !/^did:privy:[a-zA-Z0-9_-]+$/.test(e.privyUserId) || !isAdmitted(e) || accounts.has(e.privyUserId)) throw new Error();
          accounts.add(e.privyUserId);
        }
        // Preserve legacy approvals, but their old bearer codes no longer authorize access.
        if (e.code !== null) codes.add(e.code);
        this.byEmail.set(e.email, e);
      }
    } catch { throw new Error("Invalid waitlist; preserve and repair it before restarting"); }
  }

  claim(userId: string, verifiedEmails: string[]): boolean {
    if (this.failed) throw new Error("Waitlist save failed; restart before claiming access");
    if (!/^did:privy:[a-zA-Z0-9_-]+$/.test(userId)) throw new Error("Invalid account");
    const bound = this.entries.find(e => e.privyUserId === userId);
    if (bound) return isAdmitted(bound);
    const entry = this.entries.find(e => isAdmitted(e) && !e.privyUserId && verifiedEmails.includes(e.email));
    if (!entry) return false;
    // One writer claims synchronously: two accounts cannot redeem the same approval.
    this.save(this.entries.map(e => e.email === entry.email ? { ...e, privyUserId: userId } : e));
    return true;
  }

  size(): number {
    return this.entries.length;
  }

  private save(entries: WaitlistEntry[]): void {
    if (this.failed) throw new Error("Waitlist save failed; inspect the file and restart before writing");
    try { replaceFile(this.file, JSON.stringify(entries, null, 2)); }
    catch (error) { this.failed = true; throw error; }
    this.entries = entries;
    this.byEmail = new Map(entries.map(e => [e.email, e]));
  }

  /** Signup never creates or returns an access code, including for existing users. */
  signup(rawEmail: string): { isNew: boolean } {
    if (this.failed) throw new Error("Waitlist save failed; inspect the file and restart before signup");
    const email = rawEmail.trim().toLowerCase();
    if (!isValidEmail(email)) throw new Error("Invalid email");
    const existing = this.byEmail.get(email);
    if (existing) {
      // Re-export on repeat signup in case its row was deleted from the sheet.
      if (existing.sheetSyncedTo !== undefined) this.save(this.entries.map(e => {
        if (e.email !== email) return e;
        const { sheetSyncedTo, ...pending } = e;
        return pending;
      }));
      return { isNew: false };
    }
    this.save([...this.entries, { email, code: null, ts: this.now() }]);
    return { isNew: true };
  }

  review() {
    return [...this.entries].sort((a, b) => a.ts - b.ts).map(({ code, privyUserId, ...e }) => ({
      ...e, admitted: isAdmitted({ ...e, code }),
    }));
  }

  markSheetSynced(emails: string[], destination: string): void {
    if (!destination || emails.some(email => !this.byEmail.has(email))) throw new Error("Invalid sheet signup mapping");
    const synced = new Set(emails);
    this.save(this.entries.map(e => synced.has(e.email) ? { ...e, sheetSyncedTo: destination } : e));
  }

  async admit(cohort: string, count: number, send: (email: string) => Promise<void>, emails: string[]) {
    if (!validCohort(cohort) || !Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error("bad-cohort");
    if (!Array.isArray(emails) || emails.length !== count || new Set(emails).size !== count ||
        emails.some(e => typeof e !== "string" || !isValidEmail(e) || e !== e.trim().toLowerCase())) throw new Error("bad-selection");
    if (this.failed) throw new Error("Waitlist save failed; inspect the file and restart before admission");
    if (this.admitting) throw new Error("admission-in-progress");
    this.admitting = true;
    try {
      const requested = new Set(emails);
      let members = this.entries.filter(e => requested.has(e.email));
      if (members.length !== count || members.some(e => isAdmitted(e) && e.cohort !== cohort)) throw new Error("not-enough-pending");
      const pending = members.filter(e => !isAdmitted(e));
      if (pending.length) {
        const selected = new Set(pending.map(e => e.email));
        const admittedAt = this.now();
        this.save(this.entries.map(e => {
          if (!selected.has(e.email)) return e;
          return { ...e, cohort, admittedAt };
        }));
        members = this.entries.filter(e => requested.has(e.email));
      }
      let sent = 0;
      let failed = 0;
      for (const e of members) {
        if (e.emailedAt !== undefined) continue;
        try { await send(e.email); }
        catch { failed++; continue; }
        this.save(this.entries.map(row => row.email === e.email ? { ...row, emailedAt: this.now() } : row));
        sent++;
      }
      return { cohort, admitted: members.length, sent, failed };
    } finally { this.admitting = false; }
  }
}

function isAdmitted(entry: Pick<WaitlistEntry, "code" | "admittedAt">): boolean {
  return entry.admittedAt !== undefined || entry.code !== null;
}

/** Sliding-window per-IP limiter for the public signup endpoint — guards the
 * disk file from repeated writes.
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
    // ponytail: O(keys) sweep per check; fine at signup/quote volumes, move to a timer if keys explode.
    for (const [k, hs] of this.hits) if (t - hs[hs.length - 1] >= this.windowMs) this.hits.delete(k);
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
export async function sendInviteEmail(apiKey: string, to: string): Promise<void> {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": `admission-${createHash("sha256").update(to).digest("hex")}` },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      from: "Hyperflip <invites@hyperflip.xyz>",
      to: [to],
      reply_to: "contact@hyperflip.xyz",
      subject: "Your Hyperflip access is approved",
      // Deliberately plain: one link, one domain, no money words. Gmail placed the
      // earlier wording (invite code, mock USDC, stakes) in spam with SPF/DKIM/DMARC
      // all passing. Testnet setup lives on the /access page instead.
      text: [
        "Hi,",
        "",
        "Your spot on the Hyperflip waitlist has come up and your account is now approved.",
        "",
        "Sign in with this email address at https://app.hyperflip.xyz/access and follow the steps on that page.",
        "",
        "If anything does not work, contact contact@hyperflip.xyz.",
        "",
        "Hyperflip",
      ].join("\n"),
    }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}`);
}
