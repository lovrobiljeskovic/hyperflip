import type { MarketInfo } from "./markets.js";
import { WAD } from "./pure.js";

/** Live house prior for sports legs, polled off-chain so an in-play leg is priced from a
 * feed that moves with the score instead of an empty Core book or a frozen pregame line.
 *
 * Source order per market, every tick:
 *   1. Polymarket moneyline midpoint (real-money book, ticks in play; Gamma slug is
 *      `nfl-<away>-<home>-<UTC date>`, the YES token is the away team = `sideYes`).
 *   2. ESPN scoreboard `situation.lastPlay.probability` (model win probability, in play only).
 * Neither needs a key. Pregame, when no live sample is fresh, the caller falls back to
 * the registry `priorYes`; in play a missing sample leaves the leg `unpriced-leg`.
 *
 * Suspension: a jump of more than `jumpWad` between consecutive samples refuses the
 * leg for `suspendMs` — the sportsbook "market suspended after a score" rule. */

export interface LiveSample {
  yesWad: bigint;
  atMs: number;
  source: "polymarket" | "espn";
}

interface State {
  pmToken?: string | null; // undefined = unresolved, null = no Polymarket market (yet)
  pmRetryAt?: number; // when a null resolution is tried again — Polymarket lists games late
  espnDate: string; // YYYYMMDD in US/Eastern, the ESPN scoreboard day
  sample?: LiveSample;
  suspendedUntil: number;
  final: boolean;
}

export interface LivePriorOpts {
  markets: Iterable<MarketInfo>;
  fetchJson: (url: string) => Promise<unknown>;
  now: () => number;
  staleMs: number;
  jumpWad: bigint;
  suspendMs: number;
  log?: (msg: Record<string, unknown>) => void;
  gammaUrl?: string;
  clobUrl?: string;
  espnUrl?: string;
}

// Polymarket spells a few teams differently from ESPN.
const PM_RETRY_MS = 10 * 60_000;
const PM_ALIAS: Record<string, string> = { wsh: "was", lar: "la" };

export const toWad = (p: number): bigint => BigInt(Math.round(p * 1e6)) * 10n ** 12n;

/** YYYY-MM-DD in UTC — Polymarket's slug date. */
export function pmSlug(m: Pick<MarketInfo, "sideYes" | "sideNo" | "startMs">): string | null {
  if (!m.sideYes || !m.sideNo || m.startMs === undefined) return null;
  const abbr = (s: string) => PM_ALIAS[s.toLowerCase()] ?? s.toLowerCase();
  return `nfl-${abbr(m.sideYes)}-${abbr(m.sideNo)}-${new Date(m.startMs).toISOString().slice(0, 10)}`;
}

/** YYYYMMDD in US/Eastern — ESPN's scoreboard day for `dates=`. */
export function espnDate(startMs: number): string {
  return new Date(startMs).toLocaleDateString("en-CA", { timeZone: "America/New_York" }).replace(/-/g, "");
}

/** Index of the YES-side outcome in a Polymarket moneyline market: the outcome whose
 * nickname ends the away team's display name ("Carolina Panthers" ↔ "Panthers"). */
export function yesOutcomeIndex(outcomes: string[], title: string): number {
  const away = title.split(" vs ")[0]?.trim().toLowerCase() ?? "";
  return outcomes.findIndex((o) => away.endsWith(o.trim().toLowerCase()));
}

export function defaultFetchJson(url: string): Promise<unknown> {
  // ponytail: Node's default UA passes both CDNs; ESPN's Akamai 403s some custom strings.
  return fetch(url, { signal: AbortSignal.timeout(8_000) }).then((res) => {
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  });
}

export class LivePrior {
  private states = new Map<string, State>(); // by lowercase vault
  private byCoin = new Map<string, { vault: string; isYes: boolean }>();
  private markets: MarketInfo[] = [];
  private gamma: string;
  private clob: string;
  private espn: string;

  constructor(private opts: LivePriorOpts) {
    this.gamma = opts.gammaUrl ?? "https://gamma-api.polymarket.com";
    this.clob = opts.clobUrl ?? "https://clob.polymarket.com";
    this.espn = opts.espnUrl ?? "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
    for (const m of opts.markets) {
      // ponytail: NFL game winners only — both feeds are NFL-shaped; a second league is a second
      // slug prefix + ESPN path. Question members (tournament winners) are not games.
      if (m.startMs === undefined || !m.sideYes || !m.sideNo || m.question !== undefined || m.sport?.toLowerCase() !== "american football") continue;
      this.markets.push(m);
      const key = m.vault.toLowerCase();
      this.states.set(key, { espnDate: espnDate(m.startMs), suspendedUntil: 0, final: false });
      this.byCoin.set(m.coinYes, { vault: key, isYes: true });
      this.byCoin.set(m.coinNo, { vault: key, isYes: false });
    }
  }

  /** Fresh, unsuspended live P(coin) or undefined. */
  prior(coin: string): bigint | undefined {
    const ref = this.byCoin.get(coin);
    if (!ref) return undefined;
    const s = this.states.get(ref.vault)!;
    const now = this.opts.now();
    if (!s.sample || s.final || now < s.suspendedUntil || now - s.sample.atMs > this.opts.staleMs) return undefined;
    return ref.isYes ? s.sample.yesWad : WAD - s.sample.yesWad;
  }

  /** P(YES) as a number for the /markets overlay, or undefined. */
  priorYes(vault: string): number | undefined {
    const s = this.states.get(vault.toLowerCase());
    const m = this.markets.find((x) => x.vault.toLowerCase() === vault.toLowerCase());
    if (!s || !m) return undefined;
    const wad = this.prior(m.coinYes);
    return wad === undefined ? undefined : Number(wad / 10n ** 12n) / 1e6;
  }

  /** /health view: one row per live-tracked market. */
  status(): Record<string, { source: string | null; ageMs: number | null; suspended: boolean; final: boolean }> {
    const now = this.opts.now();
    const out: Record<string, { source: string | null; ageMs: number | null; suspended: boolean; final: boolean }> = {};
    for (const m of this.markets) {
      const s = this.states.get(m.vault.toLowerCase())!;
      out[m.coinYes] = { source: s.sample?.source ?? null, ageMs: s.sample ? now - s.sample.atMs : null, suspended: now < s.suspendedUntil, final: s.final };
    }
    return out;
  }

  async tick(): Promise<void> {
    const now = this.opts.now();
    const boards = new Map<string, Promise<unknown>>();
    const board = (date: string) => {
      let p = boards.get(date);
      if (!p) {
        p = this.opts.fetchJson(`${this.espn}?dates=${date}`);
        boards.set(date, p);
      }
      return p;
    };
    await Promise.all(
      this.markets.map(async (m) => {
        const s = this.states.get(m.vault.toLowerCase())!;
        if (s.final || (m.expiryMs !== undefined && now >= m.expiryMs)) return;
        try {
          const sample = (await this.polymarket(m, s)) ?? (await this.espnSample(m, s, board));
          if (sample) this.record(m, s, sample);
        } catch (err) {
          this.opts.log?.({ event: "live-prior-failed", vault: m.vault, error: (err as Error).message.slice(0, 200) });
        }
      }),
    );
  }

  private record(m: MarketInfo, s: State, sample: LiveSample): void {
    const prev = s.sample;
    if (prev) {
      const diff = sample.yesWad > prev.yesWad ? sample.yesWad - prev.yesWad : prev.yesWad - sample.yesWad;
      if (diff > this.opts.jumpWad) {
        s.suspendedUntil = sample.atMs + this.opts.suspendMs;
        this.opts.log?.({ event: "live-prior-jump", vault: m.vault, from: prev.yesWad.toString(), to: sample.yesWad.toString(), suspendedUntil: s.suspendedUntil });
      }
    }
    s.sample = sample;
  }

  private async polymarket(m: MarketInfo, s: State): Promise<LiveSample | null> {
    if (s.pmToken === null && s.pmRetryAt !== undefined && this.opts.now() >= s.pmRetryAt) s.pmToken = undefined;
    if (s.pmToken === undefined) {
      const slug = pmSlug(m);
      if (!slug) {
        s.pmToken = null;
        return null;
      }
      const events = (await this.opts.fetchJson(`${this.gamma}/events?slug=${slug}`)) as { markets?: Record<string, unknown>[] }[];
      const ml = events?.[0]?.markets?.find((x) => x.sportsMarketType === "moneyline" && x.closed !== true && x.acceptingOrders !== false);
      const outcomes = typeof ml?.outcomes === "string" ? (JSON.parse(ml.outcomes) as string[]) : null;
      const tokens = typeof ml?.clobTokenIds === "string" ? (JSON.parse(ml.clobTokenIds) as string[]) : null;
      const idx = outcomes ? yesOutcomeIndex(outcomes, m.title) : -1;
      s.pmToken = idx >= 0 && tokens?.[idx] ? tokens[idx] : null;
      s.pmRetryAt = this.opts.now() + PM_RETRY_MS;
      this.opts.log?.({ event: "live-prior-resolved", vault: m.vault, slug, polymarket: s.pmToken !== null });
    }
    if (s.pmToken === null) return null;
    let mid: string | undefined;
    try {
      ({ mid } = (await this.opts.fetchJson(`${this.clob}/midpoint?token_id=${s.pmToken}`)) as { mid?: string });
    } catch (err) {
      // A settled market loses its book (404): drop the token, retry the listing later.
      if (!/HTTP 404/.test((err as Error).message)) throw err;
      s.pmToken = null;
      s.pmRetryAt = this.opts.now() + PM_RETRY_MS;
      return null;
    }
    const p = Number(mid);
    if (!(p > 0 && p < 1)) return null;
    return { yesWad: toWad(p), atMs: this.opts.now(), source: "polymarket" };
  }

  private async espnSample(m: MarketInfo, s: State, board: (date: string) => Promise<unknown>): Promise<LiveSample | null> {
    const data = (await board(s.espnDate)) as { events?: EspnEvent[] };
    const ev = data.events?.find((e) => {
      const teams = e.competitions?.[0]?.competitors ?? [];
      const abbr = (ha: string) => teams.find((t) => t.homeAway === ha)?.team?.abbreviation?.toUpperCase();
      return abbr("away") === m.sideYes?.toUpperCase() && abbr("home") === m.sideNo?.toUpperCase();
    });
    if (!ev) return null;
    const c = ev.competitions![0];
    if (c.status?.type?.completed) {
      s.final = true;
      return null;
    }
    const prob = c.situation?.lastPlay?.probability;
    if (!prob || c.status?.type?.state !== "in") return null;
    const tie = Number(prob.tiePercentage ?? 0);
    const away = prob.awayWinPercentage !== undefined ? Number(prob.awayWinPercentage) : 1 - Number(prob.homeWinPercentage) - (Number.isFinite(tie) ? tie : 0);
    if (!Number.isFinite(away)) return null;
    // Our outcome settles 0.5 on a tie.
    const p = Math.min(0.999, Math.max(0.001, away + 0.5 * (Number.isFinite(tie) ? tie : 0)));
    return { yesWad: toWad(p), atMs: this.opts.now(), source: "espn" };
  }
}

interface EspnEvent {
  competitions?: {
    competitors?: { homeAway?: string; team?: { abbreviation?: string } }[];
    status?: { type?: { state?: string; completed?: boolean } };
    situation?: { lastPlay?: { probability?: { homeWinPercentage?: number; awayWinPercentage?: number; tiePercentage?: number } } };
  }[];
}
