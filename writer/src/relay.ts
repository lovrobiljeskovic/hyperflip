import http from "node:http";
import { isAddress, keccak256, toBytes, type Address, type Hex } from "viem";
import type { MarketInfo } from "./markets.js";
import { validateIntent, type RfqBody } from "./maker.js";
import { recoverQuoteSigner, type ParlayQuote, type QuoteLeg } from "./quotes.js";
import { isValidEmail, type RateLimiter, type Waitlist } from "./waitlist.js";

export interface RelayConfig {
  chainId: number;
  rpcUrl: string;
  parlayVault: Address;
  deployBlock: bigint;
  /** Public port (WRITER_PORT); makers sit on loopback behind it. */
  port: number;
  makers: { maker: Address; url: string }[];
  makerToken: string;
  rfqWindowMs: number;
  rfqMinTtlMs: number;
  rfqJournalFile: string;
  maxStake: bigint;
  minLegs: number;
  lockoutMs: number;
  /** Overwritten from chain at boot: the vault, not env, decides what premium is too thin. */
  minPremiumBps: bigint;
  markets: Map<string, MarketInfo>;
  registryJson: string;
  inviteCodes: Set<string>;
  corsOrigins: string[];
  waitlistFile: string;
  resendApiKey?: string;
}

export interface RelayMetrics {
  quoted: number;
  noQuotes: number;
  rejected: Record<string, number>;
  makers: Record<Address, { asked: number; quoted: number; invalid: number; unreachable: number }>;
}

export function newRelayMetrics(): RelayMetrics {
  return { quoted: 0, noQuotes: 0, rejected: {}, makers: {} };
}

function reject(m: RelayMetrics, reason: string): void {
  m.rejected[reason] = (m.rejected[reason] ?? 0) + 1;
}

function makerStats(m: RelayMetrics, maker: Address) {
  return (m.makers[maker] ??= { asked: 0, quoted: 0, invalid: 0, unreachable: 0 });
}

type Maker = { maker: Address; url: string };

export interface RelayDeps {
  cfg: RelayConfig;
  askMaker(m: Maker, body: RfqBody, signal: AbortSignal): Promise<{ status: number; json: unknown }>;
  /** GET /health with a short timeout; null = unreachable. */
  makerHealth(m: Maker): Promise<unknown | null>;
  /** Registry signer for a maker, cached by relay-main; the relay never trusts a maker's own claim. */
  signerOf(maker: Address): Address;
  now(): number;
  randomId(): Hex;
  recordRfq(r: RfqRecord): Promise<void>;
  metrics: RelayMetrics;
  waitlist?: Waitlist;
  sendInvite?(email: string, code: string): Promise<void>;
  signupLimiter?: RateLimiter;
  badInviteLimiter?: RateLimiter;
  quoteLimiter?: RateLimiter;
}

export type RfqOutcome = "won" | "lost" | "rejected" | "invalid" | "unreachable";

/** Multi-maker RFQ spec §6. One line per RFQ, whatever the result. */
export interface RfqRecord {
  schemaVersion: 1;
  rfqId: string;
  recordedAtMs: number;
  taker: Address;
  legs: QuoteLeg[];
  stake: string;
  quotaKey: string;
  windowMs: number;
  responses: { maker: Address; latencyMs: number; outcome: RfqOutcome; reason?: string; quoteId?: Hex; maxPayout?: string; deadline?: string }[];
  winner?: { maker: Address; quoteId: Hex };
  result: "quoted" | string;
}

type Intent = { taker: Address; legs: QuoteLeg[]; stake: bigint };
type Accepted = { ok: true; quote: ParlayQuote; sig: Hex; breakdown: unknown };
type Filtered = Accepted | { ok: false; outcome: "rejected" | "invalid"; reason: string; maxStake?: string };

/** Index of the largest maxPayout; ties go to the lowest address so two relays
 * (or a replay) pick the same winner from the same answers. */
export function pickBest(candidates: { maker: Address; maxPayout: bigint }[]): number {
  let best = 0;
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const b = candidates[best];
    if (c.maxPayout > b.maxPayout || (c.maxPayout === b.maxPayout && c.maker.toLowerCase() < b.maker.toLowerCase())) best = i;
  }
  return best;
}

function parseQuote(json: unknown): Accepted | null {
  const j = json as { quote?: Record<string, unknown>; sig?: unknown; breakdown?: unknown } | null;
  const q = j?.quote;
  if (!q || typeof j.sig !== "string" || !/^0x[0-9a-fA-F]+$/.test(j.sig)) return null;
  if (typeof q.taker !== "string" || !isAddress(q.taker) || typeof q.maker !== "string" || !isAddress(q.maker)) return null;
  if (typeof q.quoteId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(q.quoteId) || !Array.isArray(q.legs)) return null;
  if (typeof q.premium !== "string" || typeof q.maxPayout !== "string" || typeof q.deadline !== "string") return null;
  const legs: QuoteLeg[] = [];
  for (const l of q.legs as { vault?: unknown; isYes?: unknown }[]) {
    if (typeof l?.vault !== "string" || !isAddress(l.vault) || typeof l.isYes !== "boolean") return null;
    legs.push({ vault: l.vault as Address, isYes: l.isYes });
  }
  try {
    const quote: ParlayQuote = {
      taker: q.taker as Address, maker: q.maker as Address, legs,
      premium: BigInt(q.premium), maxPayout: BigInt(q.maxPayout), deadline: BigInt(q.deadline), quoteId: q.quoteId as Hex,
    };
    return { ok: true, quote, sig: j.sig as Hex, breakdown: j.breakdown };
  } catch {
    return null;
  }
}

const sameAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A 200 from a maker is not yet a quote: every field the taker will sign against is
 * re-checked here so a buggy or hostile maker can only waste its own reservation. */
export async function filterResponse(
  cfg: RelayConfig,
  deps: Pick<RelayDeps, "signerOf" | "now">,
  intent: Intent,
  maker: Address,
  json: unknown,
  seenQuoteIds: Set<string>,
): Promise<Filtered> {
  const invalid = (reason: string): Filtered => ({ ok: false, outcome: "invalid", reason });
  const parsed = parseQuote(json);
  if (!parsed) return invalid("bad-shape");
  const { quote } = parsed;
  let signer: Address;
  try {
    signer = await recoverQuoteSigner(cfg.chainId, cfg.parlayVault, quote, parsed.sig);
  } catch {
    return invalid("bad-sig");
  }
  if (!sameAddr(signer, deps.signerOf(maker))) return invalid("bad-sig");
  if (!sameAddr(quote.maker, maker)) return invalid("wrong-maker");
  const legsMatch =
    quote.legs.length === intent.legs.length &&
    quote.legs.every((l, i) => sameAddr(l.vault, intent.legs[i].vault) && l.isYes === intent.legs[i].isYes);
  if (!sameAddr(quote.taker, intent.taker) || !legsMatch || quote.premium !== intent.stake) return invalid("mismatch");
  if (Number(quote.deadline) * 1000 - deps.now() < cfg.rfqMinTtlMs) return invalid("short-ttl");
  if (quote.premium >= quote.maxPayout || quote.premium * 10_000n < quote.maxPayout * cfg.minPremiumBps) return invalid("bad-premium");
  if (seenQuoteIds.has(quote.quoteId.toLowerCase())) return invalid("dup-quote-id");
  seenQuoteIds.add(quote.quoteId.toLowerCase());
  return parsed;
}

type Answer = {
  maker: Address;
  latencyMs: number;
  outcome: RfqOutcome;
  reason?: string;
  status?: number;
  maxStake?: string;
  accepted?: Accepted;
};

function serialise(q: ParlayQuote) {
  return {
    taker: q.taker, maker: q.maker, legs: q.legs,
    premium: q.premium.toString(), maxPayout: q.maxPayout.toString(), deadline: q.deadline.toString(), quoteId: q.quoteId,
  };
}

export async function handleIntent(deps: RelayDeps, body: unknown, ip = "unknown"): Promise<{ status: number; json: unknown }> {
  const { cfg, metrics } = deps;
  if (deps.quoteLimiter && !deps.quoteLimiter.allow(ip)) {
    reject(metrics, "rate-limited");
    return { status: 429, json: { error: "rate-limited" } };
  }
  const inviteCode = (body as { inviteCode?: unknown } | null)?.inviteCode;
  if (typeof inviteCode !== "string" || !(cfg.inviteCodes.has(inviteCode) || deps.waitlist?.has(inviteCode))) {
    if (deps.badInviteLimiter && !deps.badInviteLimiter.allow(ip)) {
      reject(metrics, "rate-limited");
      return { status: 429, json: { error: "rate-limited" } };
    }
    reject(metrics, "bad-invite");
    return { status: 403, json: { error: "bad-invite" } };
  }
  const v = validateIntent(body, cfg, deps.now());
  if (!v.ok) {
    reject(metrics, v.reason);
    return { status: v.status, json: { error: v.reason } };
  }

  const rfqId = deps.randomId();
  const startMs = deps.now();
  // Budgets are keyed on the invite code's hash so makers never learn the code itself.
  const rfq: RfqBody = {
    rfqId, taker: v.taker, legs: v.legs, stake: v.stake.toString(),
    quotaKey: keccak256(toBytes(inviteCode)), respondByMs: startMs + cfg.rfqWindowMs,
  };
  // One shared timeout: allSettled returns as soon as everyone has answered, the abort
  // only trims stragglers past the window.
  const signal = AbortSignal.timeout(cfg.rfqWindowMs);
  const raw = await Promise.allSettled(
    cfg.makers.map(async (m) => {
      makerStats(metrics, m.maker).asked++;
      const t0 = deps.now();
      const r = await deps.askMaker(m, rfq, signal);
      return { r, latencyMs: deps.now() - t0 };
    }),
  );

  const seenQuoteIds = new Set<string>();
  const answers: Answer[] = [];
  for (const [i, res] of raw.entries()) {
    const maker = cfg.makers[i].maker;
    const stats = makerStats(metrics, maker);
    if (res.status === "rejected") {
      stats.unreachable++;
      answers.push({ maker, latencyMs: deps.now() - startMs, outcome: "unreachable" });
      continue;
    }
    const { r, latencyMs } = res.value;
    if (r.status !== 200) {
      const j = r.json as { error?: unknown; maxStake?: unknown } | null;
      const reason = typeof j?.error === "string" ? j.error : `http-${r.status}`;
      answers.push({ maker, latencyMs, outcome: "rejected", reason, status: r.status, maxStake: typeof j?.maxStake === "string" ? j.maxStake : undefined });
      continue;
    }
    const f = await filterResponse(cfg, deps, v, maker, r.json, seenQuoteIds);
    if (!f.ok) {
      stats.invalid++;
      answers.push({ maker, latencyMs, outcome: f.outcome, reason: f.reason });
      continue;
    }
    stats.quoted++;
    answers.push({ maker, latencyMs, outcome: "lost", accepted: f });
  }

  const candidates = answers.filter((a) => a.accepted);
  let result: string;
  let response: { status: number; json: unknown };
  let winner: Answer | undefined;
  if (candidates.length) {
    winner = candidates[pickBest(candidates.map((a) => ({ maker: a.maker, maxPayout: a.accepted!.quote.maxPayout })))];
    winner.outcome = "won";
    result = "quoted";
    const w = winner.accepted!;
    // Re-serialised from the verified struct, never the maker's raw JSON.
    response = { status: 200, json: { quote: serialise(w.quote), sig: w.sig, breakdown: w.breakdown, makers: { asked: cfg.makers.length, quoted: candidates.length } } };
  } else {
    const answered = answers.filter((a) => a.outcome !== "unreachable");
    const reasons = new Set(answered.map((a) => (a.outcome === "rejected" ? a.reason : undefined)));
    const shared = reasons.size === 1 ? [...reasons][0] : undefined;
    if (answered.length && shared) {
      // Unanimous refusal is the house's answer (at-capacity etc.); the taker gets the
      // most generous maxStake any maker offered.
      const maxStake = answered.map((a) => a.maxStake).filter((s): s is string => s !== undefined).reduce<string | undefined>(
        (m, s) => (m === undefined || BigInt(s) > BigInt(m) ? s : m), undefined);
      result = shared;
      reject(metrics, shared);
      response = { status: answered[0].status!, json: { error: shared, ...(maxStake !== undefined ? { maxStake } : {}) } };
    } else {
      result = "no-quotes";
      metrics.noQuotes++;
      response = { status: 503, json: { error: "no-quotes", asked: cfg.makers.length, answered: answered.length } };
    }
  }

  const record: RfqRecord = {
    schemaVersion: 1, rfqId, recordedAtMs: deps.now(), taker: v.taker, legs: v.legs, stake: rfq.stake, quotaKey: rfq.quotaKey, windowMs: cfg.rfqWindowMs,
    responses: answers.map((a) => ({
      maker: a.maker, latencyMs: a.latencyMs, outcome: a.outcome,
      ...(a.reason !== undefined ? { reason: a.reason } : {}),
      ...(a.accepted ? { quoteId: a.accepted.quote.quoteId, maxPayout: a.accepted.quote.maxPayout.toString(), deadline: a.accepted.quote.deadline.toString() } : {}),
    })),
    ...(winner ? { winner: { maker: winner.maker, quoteId: winner.accepted!.quote.quoteId } } : {}),
    result,
  };
  try {
    await deps.recordRfq(record);
  } catch (err) {
    // No signature leaves without a journal line: the losers' reservations expire on their own.
    console.error(new Date().toISOString(), "rfq journal append failed", (err as Error).message);
    reject(metrics, "journal-failed");
    return { status: 503, json: { error: "journal-failed" } };
  }
  if (winner) metrics.quoted++;
  return response;
}

export async function handleWaitlist(
  deps: RelayDeps,
  body: unknown,
  ip: string,
): Promise<{ status: number; json: unknown }> {
  const { waitlist, sendInvite, signupLimiter } = deps;
  if (!waitlist || !sendInvite) return { status: 503, json: { error: "waitlist-unavailable" } };
  const raw = (body as { email?: unknown })?.email;
  if (typeof raw !== "string" || !isValidEmail(raw.trim())) {
    return { status: 400, json: { error: "bad-email" } };
  }
  if (signupLimiter && !signupLimiter.allow(ip)) return { status: 429, json: { error: "rate-limited" } };
  const email = raw.trim().toLowerCase();
  const { code, isNew } = waitlist.signup(email);
  try {
    await sendInvite(email, code);
  } catch (err) {
    console.error(new Date().toISOString(), "invite email failed", err);
    return { status: 502, json: { error: "email-failed" } };
  }
  console.log(
    JSON.stringify({ at: new Date(deps.now()).toISOString(), event: "waitlist-signup", isNew, total: waitlist.size() }),
  );
  return { status: 200, json: { ok: true } };
}

const MAX_BODY = 64 * 1024;

// CORS controls browser access; invite codes and exposure caps enforce access limits.
function corsAllowedOrigin(req: http.IncomingMessage, allowlist: string[]): string | undefined {
  const raw = req.headers.origin;
  const origin = Array.isArray(raw) ? raw[0] : raw;
  return origin && allowlist.includes(origin) ? origin : undefined;
}

function lockedCors(req: http.IncomingMessage, allowlist: string[]): Record<string, string> {
  const origin = corsAllowedOrigin(req, allowlist);
  // Responses vary even when the origin is rejected.
  return { Vary: "Origin", ...(origin ? { "Access-Control-Allow-Origin": origin } : {}) };
}

/** Maker health fields safe to show the world; caps and per-market exposure stay private. */
function pickPublic(h: unknown): Record<string, unknown> {
  const src = (h ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["seeded", "openParlays", "bankroll", "priceFreshnessMs"]) if (k in src) out[k] = src[k];
  return out;
}

export function startRelay(deps: RelayDeps, port: number, health: () => unknown): http.Server {
  const { cfg } = deps;
  // ponytail: makers[0] stands in for "the house" on /limits and /parlays (every maker's
  // index is unfiltered); per-maker proxying when a second pricing policy exists.
  const proxy = async (path: string): Promise<{ status: number; json: unknown }> => {
    try {
      const r = await fetch(cfg.makers[0].url + path, { signal: AbortSignal.timeout(2000) });
      return { status: r.status, json: await r.json() };
    } catch {
      return { status: 503, json: { error: "maker-unreachable" } };
    }
  };
  const server = http.createServer((req, res) => {
    req.on("error", (err) => {
      console.error(new Date().toISOString(), "request stream error", err);
      req.destroy();
    });
    res.on("error", (err) => {
      console.error(new Date().toISOString(), "response stream error", err);
    });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", ...lockedCors(req, cfg.corsOrigins) });
      res.end(JSON.stringify(json));
    };
    if (req.method === "OPTIONS") {
      const cors = req.url === "/markets" ? { "Access-Control-Allow-Origin": "*" } : lockedCors(req, cfg.corsOrigins);
      res.writeHead(204, {
        ...cors,
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Max-Age": "86400",
      });
      return res.end();
    }
    if (req.method === "GET" && req.url === "/markets") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      return res.end(cfg.registryJson);
    }
    if (req.method === "GET" && req.url === "/health") {
      void Promise.all(cfg.makers.map(async (m) => {
        const h = await deps.makerHealth(m);
        return { maker: m.maker, ok: !!(h as { ok?: unknown } | null)?.ok, ...pickPublic(h) };
      })).then((makers) => send(200, { ...(health() as object), makers }));
      return;
    }
    if (req.method === "GET" && req.url === "/metrics") return send(200, deps.metrics);
    if (req.method === "GET" && req.url === "/limits") {
      void proxy("/limits").then((r) => send(r.status, r.status === 200 ? { ...(r.json as object), makers: cfg.makers.length } : r.json));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/parlays?")) {
      void proxy(req.url).then((r) => send(r.status, r.json));
      return;
    }
    if (req.method === "POST" && (req.url === "/quote" || req.url === "/waitlist")) {
      const url = req.url;
      let raw = "";
      let tooLarge = false;
      req.on("data", (c) => {
        if (tooLarge) return;
        raw += c;
        if (raw.length > MAX_BODY) {
          tooLarge = true;
          send(413, { error: "body-too-large" });
          req.destroy();
        }
      });
      req.on("end", async () => {
        if (tooLarge) return;
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return send(400, { error: "bad-json" });
        }
        try {
          const fwd = req.headers["x-forwarded-for"];
          const ip =
            (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
          if (url === "/quote") {
            const r = await handleIntent(deps, body, ip);
            return send(r.status, r.json);
          }
          const r = await handleWaitlist(deps, body, ip);
          send(r.status, r.json);
        } catch (err) {
          console.error(new Date().toISOString(), `${url} handler error`, err);
          send(500, { error: "internal" });
        }
      });
      return;
    }
    send(404, { error: "not-found" });
  });
  server.listen(port);
  return server;
}
