import type { Waitlist } from "./waitlist.js";

export interface GoogleSheetsConfig { url: string; secret: string }

export function googleSheetsConfig(env: NodeJS.ProcessEnv): GoogleSheetsConfig | undefined {
  const url = env.GOOGLE_SHEETS_WEB_APP_URL?.trim();
  const secret = env.GOOGLE_SHEETS_SYNC_SECRET?.trim();
  if (!url && !secret) return undefined;
  if (!url || !/^https:\/\/script\.google\.com\/macros\/s\/[a-zA-Z0-9_-]+\/exec$/.test(url) || !secret || secret.length < 32) {
    throw new Error("Set GOOGLE_SHEETS_WEB_APP_URL to the deployed /exec URL and GOOGLE_SHEETS_SYNC_SECRET to at least 32 characters");
  }
  return { url, secret };
}

export class GoogleSheetsWaitlist {
  private running?: Promise<void>;

  constructor(private cfg: GoogleSheetsConfig, private waitlist: Waitlist, private fetcher: typeof fetch = fetch) {}

  sync(): Promise<void> {
    // ponytail: one writer serializes exports. Share a durable queue before adding replicas.
    return this.running ??= this.flush().finally(() => { this.running = undefined; });
  }

  private async flush(): Promise<void> {
    for (;;) {
      const batch = this.waitlist.review().filter(e => e.sheetSyncedTo !== this.cfg.url).slice(0, 100);
      if (!batch.length) return;
      try {
        const response = await this.fetcher(this.cfg.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Google ContentService redirects its JSON response to googleusercontent.com.
          redirect: "follow",
          signal: AbortSignal.timeout(20_000),
          body: JSON.stringify({ secret: this.cfg.secret, entries: batch.map(e => ({
            email: e.email, ts: e.ts, cohort: e.cohort, admitted: e.admitted, emailedAt: e.emailedAt,
          })) }),
        });
        if (!response.ok || (await response.json() as { ok?: unknown } | null)?.ok !== true) throw new Error();
      } catch { throw new Error("Google Sheets export failed; signups remain queued locally"); }
      this.waitlist.markSheetSynced(batch.map(e => e.email), this.cfg.url);
    }
  }
}
