import http from "node:http";
import { isAddress, keccak256, type Address, type Hex } from "viem";
import type { WriterConfig } from "./config.js";
import { ExposureBook } from "./exposure.js";
import { dominatingLeg, edgeBreakdown, independentJointProbWad, priceParlay, totalEdgeBps } from "./pricing.js";
import { WAD } from "./pure.js";
import { quoteDigest, type ParlayQuote, type QuoteLeg, type QuoteRecord } from "./quotes.js";
import type { LegPriceObservation } from "./infoApi.js";
import { isValidEmail, type RateLimiter, type Waitlist } from "./waitlist.js";

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

  waitlist?: Waitlist;
  sendInvite?(email: string, code: string): Promise<void>;
  signupLimiter?: RateLimiter;

  badInviteLimiter?: RateLimiter;

  quoteLimiter?: RateLimiter;

  ready?: () => boolean;
  /** Mint refs for a taker, from the poker's index (GET /parlays?taker=). */
  parlaysOf?(taker: Address): { id: bigint; block: bigint }[];
}

type Validated =
  | { ok: true; taker: Address; legs: QuoteLeg[]; stake: bigint; inviteCode: string }
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
  waitlist?: { has(code: string): boolean },
): Validated {
  const b = body as { taker?: unknown; legs?: unknown; stake?: unknown; inviteCode?: unknown };
  if (
    !b ||
    typeof b.inviteCode !== "string" ||
    !(cfg.inviteCodes.has(b.inviteCode) || waitlist?.has(b.inviteCode))
  ) {
    return { ok: false, status: 403, reason: "bad-invite" };
  }
  if (typeof b.taker !== "string" || !isAddress(b.taker)) {
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
  return { ok: true, taker: b.taker as Address, legs, stake, inviteCode: b.inviteCode };
}

export async function handleQuote(
  deps: QuoteDeps,
  body: unknown,
  ip = "unknown",
): Promise<{ status: number; json: unknown }> {
  const { cfg, exposure, metrics } = deps;
  if (deps.ready && !deps.ready()) {
    reject(metrics, "warming-up");
    return { status: 503, json: { error: "warming-up" } };
  }
  if (deps.quoteLimiter && !deps.quoteLimiter.allow(ip)) {
    reject(metrics, "rate-limited");
    return { status: 429, json: { error: "rate-limited" } };
  }
  const v = validateQuoteRequest(body, cfg, deps.now(), deps.waitlist);
  if (!v.ok) {
    if (v.reason === "bad-invite" && deps.badInviteLimiter && !deps.badInviteLimiter.allow(ip)) {
      reject(metrics, "rate-limited");
      return { status: 429, json: { error: "rate-limited" } };
    }
    reject(metrics, v.reason);
    return { status: v.status, json: { error: v.reason } };
  }
  const vaults = [...new Set(v.legs.map((l) => l.vault.toLowerCase()))].map((addr) => addr as Address);

  let settled: Set<string>;
  let priceObservations: LegPriceObservation[];
  let allowance: bigint;
  try {
    settled = await deps.readSettled(vaults);
  } catch (err) {
    console.error(JSON.stringify({ at: new Date().toISOString(), event: "rpc-down", step: "readSettled", error: String((err as Error).message).slice(0, 300) }));
    reject(metrics, "rpc-down");
    return { status: 503, json: { error: "rpc-down" } };
  }
  const settledLeg = v.legs.find((l) => settled.has(l.vault.toLowerCase()));
  if (settledLeg) {
    reject(metrics, "leg-settled");
    return { status: 409, json: { error: "leg-settled", vault: settledLeg.vault } };
  }
  try {
    priceObservations = await Promise.all(v.legs.map((l) => deps.fetchLegPrice(l)));
  } catch {
    reject(metrics, "stale-book");
    return { status: 503, json: { error: "stale-book" } };
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
    console.error(JSON.stringify({ at: new Date().toISOString(), event: "rpc-down", step: "readAllowance", error: String((err as Error).message).slice(0, 300) }));
    reject(metrics, "rpc-down");
    return { status: 503, json: { error: "rpc-down" } };
  }

  const joint = independentJointProbWad(priceObservations.map((price) => price.priceWad));
  const edge = edgeBreakdown(v.legs.length, cfg.edgeBps, cfg.legEdgeBps);
  const priced = priceParlay(joint, v.stake, totalEdgeBps(edge), cfg.minPremiumBps);
  if (!priced.ok) {
    reject(metrics, priced.reason);
    return { status: 400, json: { error: priced.reason } };
  }

  const dom = dominatingLeg(priceObservations.map((price) => price.priceWad), v.stake, priced.maxPayout);
  if (dom !== -1) {
    reject(metrics, "dominated");
    return { status: 400, json: { error: "dominated", vault: v.legs[dom].vault } };
  }

  const now = deps.now();
  const risk = priced.maxPayout - priced.premium;
  // Keep check and reserve synchronous to prevent overlapping quotes exceeding caps.
  const check = exposure.check(risk, vaults, allowance, cfg.perMarketCap, now, cfg.perClusterCap, v.inviteCode, cfg.perCodeReservedCap);
  if (!check.ok) {
    reject(metrics, check.reason);
    console.log(JSON.stringify({ at: new Date(now).toISOString(), event: "quote-rejected", reason: check.reason, risk: risk.toString() }));
    const fitStake = risk > 0n ? (v.stake * check.headroom) / risk : 0n;
    return { status: 409, json: { error: check.reason, maxStake: fitStake.toString() } };
  }
  const quoteId = deps.randomId();
  exposure.reserve(quoteId, risk, vaults, now + cfg.quoteTtlMs, v.inviteCode);

  const quote: ParlayQuote = {
    taker: v.taker,
    maker: cfg.writerAddress,
    legs: v.legs,
    premium: priced.premium,
    maxPayout: priced.maxPayout,
    deadline: BigInt(Math.floor((now + cfg.quoteTtlMs) / 1000)),
    quoteId,
  };
  let sig: Hex;
  try {
    sig = await deps.sign(quote);
  } catch {
    exposure.release(quoteId);
    reject(metrics, "sign-failed");
    return { status: 503, json: { error: "sign-failed" } };
  }
  const decision: QuoteRecord = {
    schemaVersion: 1,
    recordedAtMs: deps.now(),
    quoteId,
    maker: quote.maker,
    rfqId: "", // no RFQ flow yet — Task 2 threads the relay's id through
    quoteDigest: quoteDigest(deps.chainId, cfg.parlayVault, quote),
    chainId: deps.chainId,
    parlayVault: cfg.parlayVault,
    taker: quote.taker,
    legs: v.legs.map((leg) => {
      const market = cfg.markets.get(leg.vault.toLowerCase())!;
      return { vault: leg.vault, isYes: leg.isYes, underlying: market.underlying, cluster: market.cluster, outcomeCoin: leg.isYes ? market.coinYes : market.coinNo };
    }),
    bookInputs: priceObservations.map((price) => ({
      priceWad: price.priceWad.toString(), source: price.source, observedAtMs: price.observedAtMs,
      depthWad: price.depthWad?.toString() ?? null, vwapWad: price.vwapWad?.toString() ?? null, freshnessMs: price.freshnessMs,
    })),
    jointProbWad: joint.toString(),
    edge: { baseBps: edge.baseBps.toString(), legBps: edge.legBps.toString(), totalBps: totalEdgeBps(edge).toString() },
    premium: quote.premium.toString(),
    maxPayout: quote.maxPayout.toString(),
    deadline: quote.deadline.toString(),
    signatureHash: keccak256(sig).slice(2),
  };
  try {
    await deps.recordQuote(decision);
  } catch (err) {
    console.error(new Date().toISOString(), "quote journal append failed", (err as Error).message);
    exposure.release(quoteId);
    reject(metrics, "journal-failed");
    return { status: 503, json: { error: "journal-failed" } };
  }
  metrics.quoted++;
  return {
    status: 200,
    json: {
      quote: {
        taker: quote.taker,
        maker: quote.maker,
        legs: quote.legs,
        premium: quote.premium.toString(),
        maxPayout: quote.maxPayout.toString(),
        deadline: quote.deadline.toString(),
        quoteId: quote.quoteId,
      },
      sig,
      // Display inputs are not covered by the signature.
      breakdown: {
        legPricesWad: priceObservations.map((price) => price.priceWad.toString()),
        jointProbWad: joint.toString(),
        edgeBps: edge.baseBps.toString(),
        legBps: edge.legBps.toString(),
      },
    },
  };
}

export async function handleWaitlist(
  deps: QuoteDeps,
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

export function startServer(deps: QuoteDeps, port: number, health: () => unknown): http.Server {
  const server = http.createServer((req, res) => {
    req.on("error", (err) => {
      console.error(new Date().toISOString(), "request stream error", err);
      req.destroy();
    });
    res.on("error", (err) => {
      console.error(new Date().toISOString(), "response stream error", err);
    });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", ...lockedCors(req, deps.cfg.corsOrigins) });
      res.end(JSON.stringify(json));
    };
    if (req.method === "OPTIONS") {
      const cors = req.url === "/markets" ? { "Access-Control-Allow-Origin": "*" } : lockedCors(req, deps.cfg.corsOrigins);
      res.writeHead(204, {
        ...cors,
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Max-Age": "86400",
      });
      return res.end();
    }
    if (req.method === "GET" && req.url === "/health") return send(200, health());
    if (req.method === "GET" && req.url === "/metrics") return send(200, deps.metrics);
    if (req.method === "GET" && req.url?.startsWith("/parlays?") && deps.parlaysOf) {
      const taker = new URL(req.url, "http://writer").searchParams.get("taker");
      if (!taker || !isAddress(taker)) return send(400, { error: "taker must be an address" });
      return send(200, deps.parlaysOf(taker).map((p) => ({ id: p.id.toString(), block: p.block.toString() })));
    }
    if (req.method === "GET" && req.url === "/markets") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      return res.end(deps.cfg.registryJson);
    }
    if (req.method === "GET" && req.url === "/limits") {
      res.writeHead(200, { "Content-Type": "application/json", ...lockedCors(req, deps.cfg.corsOrigins) });
      return res.end(
        JSON.stringify({
          maxStake: deps.cfg.maxStake.toString(),
          edgeBps: deps.cfg.edgeBps.toString(),
          legEdgeBps: deps.cfg.legEdgeBps.toString(),
          quoteTtlMs: deps.cfg.quoteTtlMs,
        }),
      );
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
            const r = await handleQuote(deps, body, ip);
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
