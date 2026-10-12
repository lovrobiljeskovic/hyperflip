import type { MarketInfo } from "./markets.js";
import { fromWad, toWad, WAD } from "./units.js";

/** Live house prior for sports legs, polled off-chain so an in-play leg follows the score.
 *
 * Source order per market, every tick:
 *   1. Mainnet HIP-4 book midpoint (read-only info API, D41/D43), matched by both team names
 *      + UTC kickoff date; a book wider than 3c is skipped. Unset `MAINNET_INFO_URL` skips it.
 *   2. Polymarket moneyline midpoint (YES token = away team = `sideYes`).
 *   3. ESPN `situation.lastPlay.probability` (in play only).
 * Soccer 3-way members use Polymarket only; all three mids are normalised to sum to 1.
 * Pregame with no fresh sample `prior()` falls back to the registry `priorYes`; in play a
 * missing sample leaves the leg `unpriced-leg`.
 *
 * Suspension: a jump of more than `jumpWad` between consecutive samples refuses the leg for
 * `suspendMs` (sportsbook "suspended after a score" rule). */

export interface LiveSample {
  yesWad: bigint;
  atMs: number;
  source: "polymarket" | "mainnet" | "espn";
}

/** undefined = unresolved, null = not listed (yet) or gone; `retryAt` re-arms a null —
 * Polymarket and mainnet both list games late. */
interface Resolved<T> {
  value?: T | null;
  retryAt?: number;
}

interface State {
  pm: Resolved<string>; // Polymarket YES CLOB token
  mn: Resolved<string>; // mainnet YES coin
  espnDate: string; // YYYYMMDD in US/Eastern, the ESPN scoreboard day
  sample?: LiveSample;
  suspendedUntil: number;
  final: boolean;
}

export interface LivePriorOpts {
  markets: Iterable<MarketInfo>;
  /** GET, or POST `body` as JSON when given (the info API is POST-only). */
  fetchJson: (url: string, body?: unknown) => Promise<unknown>;
  now: () => number;
  staleMs: number;
  jumpWad: bigint;
  suspendMs: number;
  log?: (msg: Record<string, unknown>) => void;
  /** Mainnet info API; unset disables the mainnet source. */
  mainnetInfoUrl?: string;
}

const PM_RETRY_MS = 10 * 60_000;
// A listing / search / outcomeMeta fetch that throws is retried this soon, not every tick.
const FAIL_RETRY_MS = 60_000;
// A mid across a wider book than this is nobody's price (D41 sample: NFL spreads 0.00001–0.024).
const MAINNET_MAX_SPREAD = 0.03;
// Polymarket spells a few teams differently from ESPN.
const PM_ALIAS: Record<string, string> = { wsh: "was", lar: "la" };

/** Resolve once, cache, and retry a null after PM_RETRY_MS. */
async function resolveCached<T>(r: Resolved<T>, now: () => number, resolve: () => Promise<T | null>): Promise<T | null> {
  if (r.value === null && r.retryAt !== undefined && now() >= r.retryAt) r.value = undefined;
  if (r.value === undefined) {
    // Held until the lookup lands, so a throwing fetch waits FAIL_RETRY_MS instead of every tick.
    r.value = null;
    r.retryAt = now() + FAIL_RETRY_MS;
    r.value = await resolve();
    r.retryAt = now() + PM_RETRY_MS;
  }
  return r.value;
}

/** YYYY-MM-DD in UTC — Polymarket's slug date. */
export function pmSlug(m: Pick<MarketInfo, "sideYes" | "sideNo" | "startMs">): string | null {
  if (!m.sideYes || !m.sideNo || m.startMs === undefined) return null;
  const abbr = (s: string) => PM_ALIAS[s.toLowerCase()] ?? s.toLowerCase();
  return `nfl-${abbr(m.sideYes)}-${abbr(m.sideNo)}-${new Date(m.startMs).toISOString().slice(0, 10)}`;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
const metaField = (desc: string | undefined, key: string) => new RegExp(`(?:^|\\|)${key}:([^|]*)`, "i").exec(desc ?? "")?.[1]?.trim().toLowerCase();

/** Mainnet HIP-4 YES coin for a game: a `sportsContestWinner` outcome naming both teams from
 * our title on the same UTC kickoff day. Deployers order participants differently, so the
 * YES coin (`#<id*10>` = participant A, `+1` = B) follows whichever is our away team. */
export function mainnetYesCoin(outcomes: { outcome: number; name?: string; description?: string }[], m: Pick<MarketInfo, "title" | "startMs">): string | null {
  const [away, home] = m.title.split(" vs ").map((t) => t.trim().toLowerCase());
  if (!away || !home || m.startMs === undefined) return null;
  const day = utcDay(m.startMs);
  for (const o of outcomes) {
    if (!o.name?.startsWith("template:sportsContestWinner") || metaField(o.description, "competition") !== "nfl") continue;
    if (metaField(o.description, "scheduledStart")?.slice(0, 8) !== day) continue;
    const a = metaField(o.description, "participantA");
    const b = metaField(o.description, "participantB");
    if (a === away && b === home) return `#${o.outcome * 10}`;
    if (a === home && b === away) return `#${o.outcome * 10 + 1}`;
  }
  return null;
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

export interface PmSearchEvent { slug?: string; markets?: Record<string, unknown>[] }

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Yes CLOB token of the Polymarket moneyline market for one soccer question member (Home / Draw /
 * Away). Candidates from `public-search`: slug ends with the UTC kickoff date and carries three
 * open moneyline markets. The market is matched by question text; market order (home, draw, away)
 * is the tiebreak when the text match is not unique and the draw sits at index 1. */
export function pmQuestionToken(events: PmSearchEvent[], m: Pick<MarketInfo, "title" | "groupTitle" | "startMs">): { token: string; slug: string; question: string } | null {
  const [home, away] = (m.groupTitle ?? "").split(" vs ").map((t) => t.trim());
  if (!home || !away || m.startMs === undefined) return null;
  const date = new Date(m.startMs).toISOString().slice(0, 10);
  for (const ev of events) {
    if (!ev.slug?.endsWith(date)) continue;
    const ml = (ev.markets ?? []).filter((x) => x.sportsMarketType === "moneyline" && x.closed !== true && x.acceptingOrders !== false);
    if (ml.length !== 3) continue;
    const q = (x: Record<string, unknown>) => (typeof x.question === "string" ? x.question : "");
    const isDraw = (x: Record<string, unknown>) => /end in a draw/i.test(q(x));
    let pick: Record<string, unknown> | undefined;
    if (m.title === "Draw") pick = ml.find(isDraw);
    else {
      const label = fold(m.title);
      // A unique text hit only: "Barcelona" sits inside "RCD Espanyol de Barcelona" too.
      const hits = ml.filter((x) => !isDraw(x) && fold(q(x)).includes(label));
      pick = hits.length === 1 ? hits[0] : undefined;
      if (!pick && isDraw(ml[1])) pick = ml[m.title === home ? 0 : m.title === away ? 2 : -1];
    }
    if (!pick) continue;
    const outcomes = typeof pick.outcomes === "string" ? (JSON.parse(pick.outcomes) as string[]) : [];
    const tokens = typeof pick.clobTokenIds === "string" ? (JSON.parse(pick.clobTokenIds) as string[]) : [];
    const token = tokens[outcomes.indexOf("Yes")];
    return token ? { token, slug: ev.slug, question: q(pick) } : null;
  }
  return null;
}

/** Soccer 3-way question member (Home / Draw / Away): Polymarket-only, matched by public-search. */
const isSoccerQuestion = (m: MarketInfo) => m.question !== undefined && m.sport?.toLowerCase() === "soccer" && !!m.groupTitle && m.startMs !== undefined;

export function defaultFetchJson(url: string, body?: unknown): Promise<unknown> {
  // ponytail: Node's default UA passes both CDNs; ESPN's Akamai 403s some custom strings.
  const init: RequestInit = { signal: AbortSignal.timeout(8_000) };
  if (body !== undefined) Object.assign(init, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return fetch(url, init).then((res) => {
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  });
}

type Get = (url: string, body?: unknown) => Promise<unknown>;

export class LivePrior {
  private states = new Map<string, State>(); // by lowercase vault
  private byCoin = new Map<string, { vault: string; isYes: boolean }>();
  private markets: MarketInfo[] = [];
  private registry = new Map<string, { wad: bigint; startMs?: number }>(); // by coin
  private yesCoin = new Map<string, string>(); // lowercase vault -> coinYes, every market
  private gamma = "https://gamma-api.polymarket.com";
  private clob = "https://clob.polymarket.com";
  private espn = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

  constructor(private opts: LivePriorOpts) {
    for (const m of opts.markets) {
      this.yesCoin.set(m.vault.toLowerCase(), m.coinYes);
      if (m.priorYes !== undefined) {
        const yes = toWad(m.priorYes);
        this.registry.set(m.coinYes, { wad: yes, startMs: m.startMs });
        this.registry.set(m.coinNo, { wad: WAD - yes, startMs: m.startMs });
      }
      // ponytail: NFL game winners (all three feeds) and soccer 3-way question members
      // (Polymarket only). Other question members (tournament winners) are not games.
      const nfl = m.question === undefined && !!m.sideYes && !!m.sideNo && m.sport?.toLowerCase() === "american football";
      if (m.startMs === undefined || !(nfl || isSoccerQuestion(m))) continue;
      this.markets.push(m);
      const key = m.vault.toLowerCase();
      this.states.set(key, { pm: {}, mn: {}, espnDate: espnDate(m.startMs), suspendedUntil: 0, final: false });
      this.byCoin.set(m.coinYes, { vault: key, isYes: true });
      this.byCoin.set(m.coinNo, { vault: key, isYes: false });
    }
  }

  /** Fresh, unsuspended live P(coin); else the registry prior, pregame only. In play with no
   * fresh sample (or final) the leg is unpriced, and /markets says so, or the app keeps
   * showing a settled game at its pregame line. */
  prior(coin: string): bigint | undefined {
    const ref = this.byCoin.get(coin);
    if (ref) {
      const s = this.states.get(ref.vault)!;
      const now = this.opts.now();
      if (s.sample && !s.final && now >= s.suspendedUntil && now - s.sample.atMs <= this.opts.staleMs) {
        return ref.isYes ? s.sample.yesWad : WAD - s.sample.yesWad;
      }
    }
    const r = this.registry.get(coin);
    return r && (r.startMs === undefined || this.opts.now() < r.startMs) ? r.wad : undefined;
  }

  /** P(YES) as a number for the /markets overlay; null = no price, undefined = unknown vault. */
  priorYes(vault: string): number | null | undefined {
    const coin = this.yesCoin.get(vault.toLowerCase());
    if (coin === undefined) return undefined;
    const wad = this.prior(coin);
    return wad === undefined ? null : fromWad(wad);
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
    // One fetch per URL per tick: outcomeMeta, an ESPN board day, a soccer question's search.
    const memo = new Map<string, Promise<unknown>>();
    const get: Get = (url, body) => {
      const key = body === undefined ? url : `${url} ${JSON.stringify(body)}`;
      let p = memo.get(key);
      if (!p) memo.set(key, (p = this.opts.fetchJson(url, body)));
      return p;
    };
    const raw = new Map<number, { m: MarketInfo; s: State; sample: LiveSample }[]>(); // soccer, by question
    await Promise.all(
      this.markets.map(async (m) => {
        const s = this.states.get(m.vault.toLowerCase())!;
        if (s.final || (m.expiryMs !== undefined && now >= m.expiryMs)) return;
        try {
          if (isSoccerQuestion(m)) {
            const sample = await this.polymarket(m, s, get);
            if (sample) raw.set(m.question!, [...(raw.get(m.question!) ?? []), { m, s, sample }]);
            return;
          }
          const sample = (await this.mainnet(m, s, get)) ?? (await this.polymarket(m, s, get)) ?? (await this.espnSample(m, s, get));
          if (sample) this.record(m, s, sample);
        } catch (err) {
          this.opts.log?.({ event: "live-prior-failed", vault: m.vault, error: (err as Error).message.slice(0, 200) });
        }
      }),
    );
    for (const [question, members] of raw) {
      const sum = members.reduce((t, x) => t + x.sample.yesWad, 0n);
      // A partial question (one member unpriced) keeps its raw mids: nothing to scale against.
      const whole = members.length === this.markets.filter((x) => x.question === question).length;
      for (const { m, s, sample } of members) this.record(m, s, whole ? { ...sample, yesWad: (sample.yesWad * WAD) / sum } : sample);
    }
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

  private async polymarket(m: MarketInfo, s: State, get: Get): Promise<LiveSample | null> {
    const token = await this.resolveToken(m, s, get);
    return token === null ? null : this.midpoint(s, token);
  }

  private async resolveToken(m: MarketInfo, s: State, get: Get): Promise<string | null> {
    const now = () => this.opts.now();
    if (isSoccerQuestion(m)) {
      return resolveCached(s.pm, now, async () => {
        const [home, away] = m.groupTitle!.split(" vs ").map((t) => t.trim());
        let hit: ReturnType<typeof pmQuestionToken> = null;
        if (home && away) {
          const res = (await get(`${this.gamma}/public-search?q=${encodeURIComponent(`${home} ${away}`)}&limit_per_type=6`)) as { events?: PmSearchEvent[] };
          hit = pmQuestionToken(res?.events ?? [], m);
        }
        this.opts.log?.({ event: "live-prior-resolved", vault: m.vault, slug: hit?.slug ?? null, question: hit?.question ?? null, polymarket: hit !== null });
        return hit?.token ?? null;
      });
    }
    const slug = pmSlug(m);
    if (!slug) return null;
    return resolveCached(s.pm, now, async () => {
      const events = (await get(`${this.gamma}/events?slug=${slug}`)) as { markets?: Record<string, unknown>[] }[];
      const ml = events?.[0]?.markets?.find((x) => x.sportsMarketType === "moneyline" && x.closed !== true && x.acceptingOrders !== false);
      const outcomes = typeof ml?.outcomes === "string" ? (JSON.parse(ml.outcomes) as string[]) : null;
      const tokens = typeof ml?.clobTokenIds === "string" ? (JSON.parse(ml.clobTokenIds) as string[]) : null;
      const idx = outcomes ? yesOutcomeIndex(outcomes, m.title) : -1;
      const token = idx >= 0 && tokens?.[idx] ? tokens[idx] : null;
      this.opts.log?.({ event: "live-prior-resolved", vault: m.vault, slug, polymarket: token !== null });
      return token;
    });
  }

  private async midpoint(s: State, token: string): Promise<LiveSample | null> {
    let mid: string | undefined;
    try {
      ({ mid } = (await this.opts.fetchJson(`${this.clob}/midpoint?token_id=${token}`)) as { mid?: string });
    } catch (err) {
      // A settled market loses its book (404): drop the token, retry the listing later.
      if (!/HTTP 404/.test((err as Error).message)) throw err;
      s.pm = { value: null, retryAt: this.opts.now() + PM_RETRY_MS };
      return null;
    }
    const p = Number(mid);
    if (!(p > 0 && p < 1)) return null;
    return { yesWad: toWad(p), atMs: this.opts.now(), source: "polymarket" };
  }

  private async mainnet(m: MarketInfo, s: State, get: Get): Promise<LiveSample | null> {
    const url = this.opts.mainnetInfoUrl;
    if (!url) return null;
    const now = this.opts.now();
    const coin = await resolveCached(s.mn, () => now, async () => {
      const { outcomes } = (await get(url, { type: "outcomeMeta" })) as { outcomes?: { outcome: number; name?: string; description?: string }[] };
      const c = mainnetYesCoin(outcomes ?? [], m);
      this.opts.log?.({ event: "live-prior-resolved", vault: m.vault, mainnet: c });
      return c;
    });
    if (coin === null) return null;
    let book: { levels?: { px: string }[][] };
    try {
      book = (await this.opts.fetchJson(url, { type: "l2Book", coin })) as typeof book;
    } catch {
      // Settled outcomes are pruned from Core; drop the coin, re-resolve later.
      s.mn = { value: null, retryAt: now + PM_RETRY_MS };
      return null;
    }
    const bid = Number(book.levels?.[0]?.[0]?.px);
    const ask = Number(book.levels?.[1]?.[0]?.px);
    if (!(bid > 0 && ask < 1 && ask - bid <= MAINNET_MAX_SPREAD)) return null;
    return { yesWad: toWad((bid + ask) / 2), atMs: now, source: "mainnet" };
  }

  private async espnSample(m: MarketInfo, s: State, get: Get): Promise<LiveSample | null> {
    const data = (await get(`${this.espn}?dates=${s.espnDate}`)) as { events?: EspnEvent[] };
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
