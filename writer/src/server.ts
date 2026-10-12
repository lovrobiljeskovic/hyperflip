import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { isAddress, keccak256, type Address, type Hex } from "viem";
import type { WriterConfig } from "./config.js";
import { ExposureBook } from "./exposure.js";
import { dominatingLeg, edgeBreakdown, independentJointProbWad, priceParlay, totalEdgeBps } from "./pricing.js";
import { BPS, WAD } from "./units.js";
import { logError } from "../../services/log.mjs";
import { quoteDigest, type ParlayQuote, type QuoteLeg, type QuoteRecord } from "./quotes.js";
import type { LegPriceObservation } from "./infoApi.js";
import { isValidEmail, validCohort, type RateLimiter, type Waitlist } from "./waitlist.js";
import type { AuthenticatedAccount } from "./auth.js";

export interface Metrics {
  quoted: number;
  minted: number;
  rejected: Record<string, number>;
}

export function newMetrics(): Metrics {
  return { quoted: 0, minted: 0, rejected: {} };
}

function reject(m: Metrics, reason: string): void {
  m.rejected[reason] = (m.rejected[reason] ?? 0) + 1;
}

export interface QuoteDeps {
  cfg: WriterConfig;
  exposure: ExposureBook;
  chainId: number;
  fetchLegPrice(leg: QuoteLeg): Promise<LegPriceObservation>;
  readAllowance(): Promise<bigint>;

  readSettled(vaults: Address[]): Promise<Set<string>>;
  sign(q: ParlayQuote): Promise<Hex>;
  recordQuote(decision: QuoteRecord): Promise<void>;
  now(): number;
  randomId(): Hex;
  metrics: Metrics;

  waitlist: Waitlist;
  sendInvite?(email: string): Promise<void>;
  authenticate?(token: string): Promise<AuthenticatedAccount | null>;
  signupLimiter: RateLimiter;
  syncWaitlist?(): Promise<void>;
  badInviteLimiter: RateLimiter;
  quoteLimiter: RateLimiter;
  ready: () => boolean;
  /** P(YES) for a vault as the quote path would price it, overlaid on /markets so the
   * app shows what we quote: a number replaces the registry prior, `null` strips it
   * (in play with no fresh feed, or final - the leg is unquotable, so the app drops
   * the row), `undefined` leaves the row as written. */
  livePriorYes(vault: Address): number | null | undefined;
  /** Mint refs for a taker, from the poker's index (GET /parlays?taker=). */
  parlaysOf(taker: Address): { id: bigint; block: bigint }[];
}

type Validated =
  | { ok: true; taker: Address; legs: QuoteLeg[]; stake: bigint }
  | { ok: false; status: number; reason: string };

export function sameGameLeg(legs: QuoteLeg[], cfg: WriterConfig): Address | null {
  const seenGame = new Set<string>();
  const seenQuestion = new Set<number>();
  for (const leg of legs) {
    const market = cfg.markets.get(leg.vault.toLowerCase())!;
    if (seenGame.has(market.underlying)) return leg.vault;
    seenGame.add(market.underlying);
    if (market.question !== undefined) {
      if (seenQuestion.has(market.question)) return leg.vault;
      seenQuestion.add(market.question);
    }
  }
  return null;
}

export function validateQuoteRequest(
  body: unknown,
  cfg: WriterConfig,
  now: number,
): Validated {
  const b = body as { taker?: unknown; legs?: unknown; stake?: unknown } | null;
  if (typeof b?.taker !== "string" || !isAddress(b.taker)) {
    return { ok: false, status: 400, reason: "bad-taker" };
  }
  if (!Array.isArray(b.legs)) return { ok: false, status: 400, reason: "bad-legs" };
  if (b.legs.length < cfg.minLegs || b.legs.length > 10) {
    return { ok: false, status: 400, reason: "bad-leg-count" };
  }
  const legs: QuoteLeg[] = [];
  for (const l of b.legs as { vault?: unknown; isYes?: unknown }[]) {
    if (typeof l?.vault !== "string" || !isAddress(l.vault) || typeof l.isYes !== "boolean") {
      return { ok: false, status: 400, reason: "bad-leg" };
    }
    const key = l.vault.toLowerCase();
    const market = cfg.markets.get(key);
    if (!market) return { ok: false, status: 400, reason: "unknown-vault" };
    // ponytail: in-play prices can lag the score; add a live-feed guard before real money.
    const lockAtMs = market.expiryMs;
    if (lockAtMs !== undefined && now >= lockAtMs - cfg.lockoutMs) {
      return { ok: false, status: 400, reason: "expiry-lockout" };
    }
    legs.push({ vault: l.vault as Address, isYes: l.isYes });
  }
  if (sameGameLeg(legs, cfg)) return { ok: false, status: 400, reason: "same-game" };
  let stake: bigint;
  try {
    stake = BigInt(b.stake as string);
  } catch {
    return { ok: false, status: 400, reason: "bad-stake" };
  }
  if (stake <= 0n) return { ok: false, status: 400, reason: "bad-stake" };
  if (stake > cfg.maxStake) return { ok: false, status: 400, reason: "stake-too-big" };
  return { ok: true, taker: b.taker as Address, legs, stake };
}

type Res = { status: number; json: unknown; headers?: Record<string, string> };
type ValidQuote = Extract<Validated, { ok: true }>;

interface Priced {
  vaults: Address[];
  priceObservations: LegPriceObservation[];
  allowance: bigint;
  joint: bigint;
  edge: ReturnType<typeof edgeBreakdown>;
  premium: bigint;
  maxPayout: bigint;
}

function fail(metrics: Metrics, reason: string, err: unknown, extra?: object): Res {
  logError(reason, err, extra);
  reject(metrics, reason);
  return { status: 503, json: { error: reason } };
}

async function price(deps: QuoteDeps, v: ValidQuote): Promise<Priced | Res> {
  const { cfg, metrics } = deps;
  const vaults = [...new Set(v.legs.map((l) => l.vault.toLowerCase()))].map((addr) => addr as Address);

  let settled: Set<string>;
  let priceObservations: LegPriceObservation[];
  let allowance: bigint;
  try {
    settled = await deps.readSettled(vaults);
  } catch (err) {
    return fail(metrics, "rpc-down", err, { step: "readSettled" });
  }
  const settledLeg = v.legs.find((l) => settled.has(l.vault.toLowerCase()));
  if (settledLeg) {
    reject(metrics, "leg-settled");
    return { status: 409, json: { error: "leg-settled", vault: settledLeg.vault } };
  }
  try {
    priceObservations = await Promise.all(v.legs.map((l) => deps.fetchLegPrice(l)));
  } catch (err) {
    return fail(metrics, "stale-book", err);
  }
  // Core uses 0.5 as an empty-book placeholder.
  const unpriced = v.legs.findIndex((_, i) => priceObservations[i].source === "spotPx" && priceObservations[i].priceWad === WAD / 2n);
  if (unpriced !== -1) {
    reject(metrics, "unpriced-leg");
    return { status: 503, json: { error: "unpriced-leg", vault: v.legs[unpriced].vault } };
  }
  try {
    allowance = await deps.readAllowance();
  } catch (err) {
    return fail(metrics, "rpc-down", err, { step: "readAllowance" });
  }

  const joint = independentJointProbWad(priceObservations.map((p) => p.priceWad));
  const edge = edgeBreakdown(v.legs.length, cfg.edgeBps, cfg.legEdgeBps);
  const priced = priceParlay(joint, v.stake, totalEdgeBps(edge), cfg.minPremiumBps);
  if (!priced.ok) {
    reject(metrics, priced.reason);
    return { status: 400, json: { error: priced.reason } };
  }

  const dom = dominatingLeg(priceObservations.map((p) => p.priceWad), v.stake, priced.maxPayout);
  if (dom !== -1) {
    reject(metrics, "dominated");
    return { status: 400, json: { error: "dominated", vault: v.legs[dom].vault } };
  }
  return { vaults, priceObservations, allowance, joint, edge, premium: priced.premium, maxPayout: priced.maxPayout };
}

async function reserveAndSign(
  deps: QuoteDeps,
  v: ValidQuote,
  p: Priced,
  userId: string,
): Promise<{ quote: ParlayQuote; sig: Hex } | Res> {
  const { cfg, exposure, metrics } = deps;
  const now = deps.now();
  const risk = p.maxPayout - p.premium;
  // Keep check and reserve synchronous to prevent overlapping quotes exceeding caps.
  // ponytail: one cap for the whole ticket; any in-play leg shrinks it to the in-play cap.
  const inPlay = v.legs.some((l) => { const s = cfg.markets.get(l.vault.toLowerCase())?.startMs; return s !== undefined && now >= s; });
  const marketCap = inPlay ? (cfg.perMarketCap * cfg.inPlayCapBps) / BPS : cfg.perMarketCap;
  const check = exposure.check({
    risk, vaults: p.vaults, allowance: p.allowance, perMarketCap: marketCap, now,
    perClusterCap: cfg.perClusterCap, quotaKey: userId, perKeyCap: cfg.perCodeReservedCap,
  });
  if (!check.ok) {
    reject(metrics, check.reason);
    console.log(JSON.stringify({ at: new Date(now).toISOString(), event: "quote-rejected", reason: check.reason, risk: risk.toString() }));
    const fitStake = risk > 0n ? (v.stake * check.headroom) / risk : 0n;
    return { status: 409, json: { error: check.reason, maxStake: fitStake.toString() } };
  }
  const quoteId = deps.randomId();
  exposure.reserve(quoteId, risk, p.vaults, now + cfg.quoteTtlMs, userId);

  const quote: ParlayQuote = {
    taker: v.taker,
    legs: v.legs,
    premium: p.premium,
    maxPayout: p.maxPayout,
    deadline: BigInt(Math.floor((now + cfg.quoteTtlMs) / 1000)),
    quoteId,
  };
  try {
    return { quote, sig: await deps.sign(quote) };
  } catch (err) {
    exposure.release(quoteId);
    return fail(metrics, "sign-failed", err);
  }
}

function toQuoteRecord(deps: QuoteDeps, p: Priced, quote: ParlayQuote, sig: Hex): QuoteRecord {
  const { cfg } = deps;
  return {
    schemaVersion: 1,
    recordedAtMs: deps.now(),
    quoteId: quote.quoteId,
    quoteDigest: quoteDigest(deps.chainId, cfg.parlayVault, quote),
    chainId: deps.chainId,
    parlayVault: cfg.parlayVault,
    taker: quote.taker,
    legs: quote.legs.map((leg) => {
      const market = cfg.markets.get(leg.vault.toLowerCase())!;
      return { vault: leg.vault, isYes: leg.isYes, underlying: market.underlying, cluster: market.cluster, outcomeCoin: leg.isYes ? market.coinYes : market.coinNo };
    }),
    bookInputs: p.priceObservations.map((price) => ({
      priceWad: price.priceWad.toString(), source: price.source, observedAtMs: price.observedAtMs,
      depthWad: price.depthWad?.toString() ?? null, vwapWad: price.vwapWad?.toString() ?? null, freshnessMs: price.freshnessMs,
    })),
    jointProbWad: p.joint.toString(),
    edge: { baseBps: p.edge.baseBps.toString(), legBps: p.edge.legBps.toString(), totalBps: totalEdgeBps(p.edge).toString() },
    premium: quote.premium.toString(),
    maxPayout: quote.maxPayout.toString(),
    deadline: quote.deadline.toString(),
    signatureHash: keccak256(sig).slice(2),
  };
}

export async function handleQuote(
  deps: QuoteDeps,
  body: unknown,
  ip = "unknown",
  authorization?: string,
): Promise<Res> {
  const { cfg, exposure, metrics } = deps;
  if (!deps.ready()) {
    reject(metrics, "warming-up");
    return { status: 503, json: { error: "warming-up" } };
  }
  if (!deps.quoteLimiter.allow(ip)) {
    reject(metrics, "rate-limited");
    return { status: 429, json: { error: "rate-limited" } };
  }
  const admission = await authenticateAdmission(deps, authorization, ip);
  if ("status" in admission) return admission;
  const v = validateQuoteRequest(body, cfg, deps.now());
  if (!v.ok) {
    reject(metrics, v.reason);
    return { status: v.status, json: { error: v.reason } };
  }
  if (!admission.account.wallets.includes(v.taker.toLowerCase())) {
    return { status: 403, json: { error: "wallet-not-linked" } };
  }
  const p = await price(deps, v);
  if ("status" in p) return p;
  const signed = await reserveAndSign(deps, v, p, admission.account.userId);
  if ("status" in signed) return signed;
  const { quote, sig } = signed;
  const record = toQuoteRecord(deps, p, quote, sig);
  try {
    await deps.recordQuote(record);
  } catch (err) {
    console.error(new Date().toISOString(), "quote journal append failed", (err as Error).message);
    exposure.release(quote.quoteId);
    reject(metrics, "journal-failed");
    return { status: 503, json: { error: "journal-failed" } };
  }
  metrics.quoted++;
  return {
    status: 200,
    json: {
      quote: {
        taker: quote.taker,
        legs: quote.legs,
        premium: quote.premium.toString(),
        maxPayout: quote.maxPayout.toString(),
        deadline: quote.deadline.toString(),
        quoteId: quote.quoteId,
      },
      sig,
      // Display inputs are not covered by the signature.
      breakdown: {
        legPricesWad: p.priceObservations.map((price) => price.priceWad.toString()),
        jointProbWad: p.joint.toString(),
        edgeBps: p.edge.baseBps.toString(),
        legBps: p.edge.legBps.toString(),
      },
    },
  };
}

export async function handleWaitlist(
  deps: QuoteDeps,
  body: unknown,
  ip: string,
): Promise<Res> {
  const { waitlist, signupLimiter } = deps;
  const raw = (body as { email?: unknown })?.email;
  if (typeof raw !== "string" || !isValidEmail(raw.trim())) {
    return { status: 400, json: { error: "bad-email" } };
  }
  if (!signupLimiter.allow(ip)) return { status: 429, json: { error: "rate-limited" } };
  const email = raw.trim().toLowerCase();
  const { isNew } = waitlist.signup(email);
  // The signup is already durable. A Google outage must not lose it or grant access.
  if (deps.syncWaitlist) void deps.syncWaitlist().catch((err) => {
    logError("google-sheets-sync-failed", err, { reason: "Signup queued for retry" });
  });
  console.log(
    JSON.stringify({ at: new Date(deps.now()).toISOString(), event: "waitlist-signup", isNew, total: waitlist.size() }),
  );
  return { status: 200, json: { ok: true } };
}

async function authenticateAdmission(deps: QuoteDeps, authorization: string | undefined, ip: string): Promise<{ account: AuthenticatedAccount } | Res> {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  let account: AuthenticatedAccount | null = null;
  if (!deps.authenticate) return { status: 503, json: { error: "access-unavailable" } };
  if (token && token.length <= 8192) {
    try { account = await deps.authenticate(token); }
    catch { return { status: 503, json: { error: "access-unavailable" } }; }
  }
  if (!account) {
    if (!deps.badInviteLimiter.allow(ip)) {
      return { status: 429, json: { error: "rate-limited" } };
    }
    return { status: 401, json: { error: "unauthenticated" } };
  }
  if (!deps.cfg.openAccess && !deps.waitlist.claim(account.userId, account.emails)) return { status: 403, json: { error: "not-admitted" } };
  return { account };
}

export async function handleAccess(deps: QuoteDeps, authorization: string | undefined, ip: string) {
  const admission = await authenticateAdmission(deps, authorization, ip);
  if ("status" in admission) return admission;
  return { status: 200, json: { ok: true } };
}

export async function handleAdmission(deps: QuoteDeps, body: unknown) {
  if (!deps.sendInvite) return { status: 503, json: { error: "admission-unavailable" } };
  const b = body as { cohort?: unknown; count?: unknown; emails?: unknown } | null;
  if (!validCohort(b?.cohort) || typeof b?.count !== "number" || !Number.isSafeInteger(b.count) || b.count < 1 || b.count > 100) {
    return { status: 400, json: { error: "bad-cohort" } };
  }
  try {
    const result = await deps.waitlist.admit(b.cohort, b.count, deps.sendInvite, b.emails as string[]);
    const entries = deps.waitlist.review().filter(e => (b.emails as string[]).includes(e.email))
      .map(({ email, admitted, cohort, emailedAt }) => ({ email, admitted, cohort, emailedAt }));
    return { status: result.failed ? 502 : 200, json: { ...result, entries } };
  } catch (error) {
    const reason = (error as Error).message;
    if (reason === "bad-selection") return { status: 400, json: { error: reason } };
    if (["admission-in-progress", "not-enough-pending"].includes(reason)) {
      return { status: 409, json: { error: reason } };
    }
    throw error;
  }
}

const MAX_BODY = 64 * 1024;

// CORS controls browser access; authenticated admission and exposure caps enforce access limits.
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

/** Registry JSON with live priors overlaid on `priorYes`, so the board mirrors the quote. */
export function marketsJson(deps: Pick<QuoteDeps, "cfg" | "livePriorYes">): string {
  const registry = JSON.parse(deps.cfg.registryJson);
  const list: Record<string, unknown>[] | undefined = Array.isArray(registry) ? registry : registry?.markets;
  if (!Array.isArray(list)) return deps.cfg.registryJson;
  let changed = false;
  const markets = list.map((m) => {
    const live = typeof m.vault === "string" ? deps.livePriorYes(m.vault as Address) : undefined;
    if (live === undefined || (live === null && m.priorYes === undefined)) return m;
    changed = true;
    if (live === null) {
      const { priorYes: _stale, ...rest } = m;
      return rest;
    }
    return { ...m, priorYes: live };
  });
  if (!changed) return deps.cfg.registryJson;
  return JSON.stringify(Array.isArray(registry) ? markets : { ...registry, markets });
}

type Route = (req: http.IncomingMessage, body: unknown) => Res | Promise<Res>;

function readJson(req: http.IncomingMessage): Promise<{ body: unknown } | Res> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      if (raw.length > MAX_BODY) return;
      raw += c;
      if (raw.length > MAX_BODY) {
        resolve({ status: 413, json: { error: "body-too-large" } });
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve({ body: JSON.parse(raw) });
      } catch {
        resolve({ status: 400, json: { error: "bad-json" } });
      }
    });
  });
}

export function startServer(deps: QuoteDeps, port: number, health: () => unknown): http.Server {
  const ip = (req: http.IncomingMessage) => clientIp(req.headers["x-forwarded-for"], req.socket.remoteAddress);
  const routes: Record<string, Route> = {
    "GET /health": () => ({ status: 200, json: health() }),
    "GET /metrics": () => ({ status: 200, json: deps.metrics }),
    "GET /parlays?": (req) => {
      const taker = new URL(req.url!, "http://writer").searchParams.get("taker");
      if (!taker || !isAddress(taker)) return { status: 400, json: { error: "taker must be an address" } };
      return { status: 200, json: deps.parlaysOf(taker).map((p) => ({ id: p.id.toString(), block: p.block.toString() })) };
    },
    "GET /markets": () => ({ status: 200, json: marketsJson(deps), headers: { "Access-Control-Allow-Origin": "*" } }),
    "GET /limits": () => {
      // Caps are on house risk (maxPayout - premium). bankroll is the cached
      // allowance/balance room from the last quote, null before the first one;
      // reserved is live quote reservations not yet minted.
      const h = health() as { bankroll?: string | null };
      return {
        status: 200,
        json: {
          maxStake: deps.cfg.maxStake.toString(),
          edgeBps: deps.cfg.edgeBps.toString(),
          legEdgeBps: deps.cfg.legEdgeBps.toString(),
          quoteTtlMs: deps.cfg.quoteTtlMs,
          perMarketCap: deps.cfg.perMarketCap.toString(),
          perClusterCap: deps.cfg.perClusterCap.toString(),
          perCodeReservedCap: deps.cfg.perCodeReservedCap.toString(),
          bankroll: h.bankroll ?? null,
          reserved: deps.exposure.reservedGlobal(deps.now()).toString(),
        },
      };
    },
    "POST /quote": (req, body) => handleQuote(deps, body, ip(req), req.headers.authorization),
    "POST /waitlist": (req, body) => handleWaitlist(deps, body, ip(req)),
    "POST /access": (req) => handleAccess(deps, req.headers.authorization, ip(req)),
    "POST /integrations/google-sheets/admit": (_req, body) => handleAdmission(deps, body),
  };

  const server = http.createServer(async (req, res) => {
    req.on("error", (err) => {
      console.error(new Date().toISOString(), "request stream error", err);
      req.destroy();
    });
    res.on("error", (err) => {
      console.error(new Date().toISOString(), "response stream error", err);
    });
    // `headers` replaces the locked CORS headers; a string body is already JSON.
    const send = (status: number, json: unknown, headers: Record<string, string> = lockedCors(req, deps.cfg.corsOrigins)) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(typeof json === "string" ? json : JSON.stringify(json));
    };
    if (req.url === "/integrations/google-sheets/admit" && req.method !== "OPTIONS") {
      res.setHeader("Cache-Control", "no-store");
      const token = deps.cfg.waitlistAdminToken;
      const expected = Buffer.from(`Bearer ${token ?? ""}`);
      const provided = Buffer.from(req.headers.authorization ?? "");
      if (!token || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        return send(401, { error: "unauthorized" });
      }
    }
    if (req.method === "OPTIONS") {
      const cors = req.url === "/markets" ? { "Access-Control-Allow-Origin": "*" } : lockedCors(req, deps.cfg.corsOrigins);
      res.writeHead(204, {
        ...cors,
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": "content-type, authorization",
        "Access-Control-Max-Age": "86400",
      });
      return res.end();
    }
    // Routes match the exact URL; only /parlays? takes (and requires) a query string.
    const path = req.url?.startsWith("/parlays?") ? "/parlays?" : req.url;
    const route = routes[`${req.method} ${path}`];
    if (!route) return send(404, { error: "not-found" });
    if (path === "/access") res.setHeader("Cache-Control", "no-store");
    let body: unknown;
    if (req.method === "POST") {
      const read = await readJson(req);
      if ("status" in read) return send(read.status, read.json);
      body = read.body;
    }
    try {
      const r = await route(req, body);
      send(r.status, r.json, r.headers);
    } catch (err) {
      console.error(new Date().toISOString(), `${req.url} handler error`, err);
      send(500, { error: "internal" });
    }
  });
  server.listen(port);
  return server;
}

/** Rate-limiter key for a request. Caddy APPENDS the real peer to whatever
 * `X-Forwarded-For` the client sent, so the leftmost entry is attacker-controlled
 * — reading it let a client rotate the key per request and defeat both the quote
 * and bad-invite limiters. The rightmost entry is the hop our proxy observed.
 * ponytail: assumes exactly one trusted proxy (Caddy on loopback); with a second
 * one in front, drop a fixed count of trailing hops instead. */
export function clientIp(forwarded: string | string[] | undefined, socketAddress?: string): string {
  const header = Array.isArray(forwarded) ? forwarded[forwarded.length - 1] : forwarded;
  const hops = (header ?? "").split(",").map((hop) => hop.trim()).filter(Boolean);
  return hops[hops.length - 1] ?? socketAddress ?? "unknown";
}
