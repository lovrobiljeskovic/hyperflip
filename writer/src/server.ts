import http from "node:http";
import { isAddress, keccak256, type Address, type Hex } from "viem";
import type { WriterConfig } from "./config.js";
import { TooComplexError } from "./copula.js";
import { nominalPairCorrelation, riskAdjustedJointProbWad, type CorrLeg } from "./correlation.js";
import { ExposureBook } from "./exposure.js";
import { dominatingLeg, edgeBreakdown, independentJointProbWad, priceParlay, totalEdgeBps } from "./pricing.js";
import { WAD } from "./pure.js";
import { quoteDigest, type ParlayQuote, type QuoteLeg } from "./quotes.js";
import type { LegPriceObservation } from "./infoApi.js";
import type { QuoteDecision } from "./research/types.js";
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
  bestEstimateJointProbWad(legs: CorrLeg[]): Promise<bigint>;
  readAllowance(): Promise<bigint>;
  /** Lowercase vault addresses of legs already settled. */
  readSettled(vaults: Address[]): Promise<Set<string>>;
  sign(q: ParlayQuote): Promise<Hex>;
  recordQuote(decision: QuoteDecision): Promise<void>;
  now(): number;
  randomId(): Hex;
  metrics: Metrics;
  /** Waitlist signup store + mailer; absent in tests that only quote. */
  waitlist?: Waitlist;
  sendInvite?(email: string, code: string): Promise<void>;
  signupLimiter?: RateLimiter;
  /** Per-IP cap on failed invite attempts at /quote — brute-force guard only;
   * requests with a valid code never consume a slot. */
  badInviteLimiter?: RateLimiter;
  /** Per-IP cap on ALL /quote requests — a valid code doesn't make quotes free
   * to serve: each one reserves exposure until TTL and burns RPC calls.
   * ponytail: per-IP punishes shared NATs; key by inviteCode if that bites. */
  quoteLimiter?: RateLimiter;
  /** false until the exposure book is seeded from chain (index.ts); /quote answers
   * 503 warming-up meanwhile instead of quoting blind to real open exposure. */
  ready?: () => boolean;
}

type Validated =
  | { ok: true; taker: Address; legs: QuoteLeg[]; stake: bigint; inviteCode: string }
  | { ok: false; status: number; reason: string };

const pairKey = (left: string, right: string): string => left < right ? `${left}:${right}` : `${right}:${left}`;
const MODEL_MAX_AGE_MS = 7 * 86_400_000;

export function currentModelStatus(model: WriterConfig["model"], now: number): { ageMs: number; multiAssetEnabled: boolean } {
  const ageMs = Math.max(0, now - Date.parse(model.dataAsOf));
  return { ageMs, multiAssetEnabled: model.multiAssetEnabled && ageMs < MODEL_MAX_AGE_MS };
}

export function correlationEligibility(legs: QuoteLeg[], cfg: WriterConfig, now: number): string | null {
  const markets = legs.map((leg) => cfg.markets.get(leg.vault.toLowerCase())!);
  const underlyings = [...new Set(markets.map((market) => market.underlying))].sort();
  if (underlyings.length <= 1) return null;
  if (!currentModelStatus(cfg.model, now).multiAssetEnabled || markets.some((market) => market.direction === "band")) return "correlation-unavailable";
  for (const underlying of underlyings) if (!cfg.model.eligibleUnderlyings.has(underlying) || cfg.model.quarantinedUnderlyings.has(underlying)) return "correlation-unavailable";
  for (let left = 0; left < underlyings.length; left++) for (let right = left + 1; right < underlyings.length; right++) {
    const entry = cfg.model.pairEligibility.get(pairKey(underlyings[left], underlyings[right]));
    if (!entry || entry.status === "quarantined") return "correlation-unavailable";
    if (entry.status === "fallback" && (!cfg.model.fallbackEligible.has(underlyings[left]) || !cfg.model.fallbackEligible.has(underlyings[right]))) return "correlation-unavailable";
  }
  return null;
}

/** Independence pricing is only honest across games. Two legs on one game
 * (same `underlying`) or one HIP-4 question (A / Draw / B) are either mutually
 * exclusive or strongly correlated, and a product price is wrong either way —
 * sportsbooks sell those as a separate SGP product. Returns the offending vault. */
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
    // Lock at the resolution deadline, not kickoff: in-play quoting is wanted,
    // the Core mid moves with the game and pricing follows it.
    //
    // ponytail: MAINNET GATE — in-play quoting off a thin Core book. After a
    // goal the true probability jumps at once but the Core mid only moves when
    // someone repositions an order; in that window anyone on a live feed buys
    // the winning side from us at the stale price. edgeBps covers noise, not a
    // 30-point mispricing. Before real USDC sits in the vault, once
    // `now >= market.startMs`: widen the edge, cut the per-market cap, or
    // refuse for N seconds after a large mid move. Kickoff lockout
    // (`market.startMs ?? market.expiryMs` here) was the pre-2026-09-11 guard.
    const lockAtMs = market.expiryMs;
    if (lockAtMs !== undefined && now >= lockAtMs - cfg.lockoutMs) {
      return { ok: false, status: 400, reason: "expiry-lockout" };
    }
    legs.push({ vault: l.vault as Address, isYes: l.isYes });
  }
  if (cfg.pricingMode === "independent") {
    if (sameGameLeg(legs, cfg)) return { ok: false, status: 400, reason: "same-game" };
  } else {
    const correlationReason = correlationEligibility(legs, cfg, now);
    if (correlationReason) return { ok: false, status: 400, reason: correlationReason };
  }
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
  // Defensive, not load-bearing: ExposureBook tests vault membership
  // (Array.includes/some) rather than summing per occurrence, so a duplicated
  // vault would not double-count today even without this. Deduping still
  // guards against a future ExposureBook that sums per entry.
  // `.toLowerCase()` widens Address to string; the cast recovers it — the
  // value is still a well-formed 0x-prefixed address, just lowercase.
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
  // An empty book reports spotPx 0.5 until Core prints a trade: a placeholder,
  // not a probability. Quoting it hands the taker a free pick of the mispriced
  // side on every outcome of the question.
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

  // Correlation lives in the probability, not the edge: legs that comove make
  // the joint probability higher than the product of the marginals, and legs
  // that oppose make it lower. jointProbWad returns the house-favorable end of
  // the rho band, so a hand-set loading being optimistic costs the house less
  // than it otherwise would.
  const corrLegs: CorrLeg[] = v.legs.map((l, i) => {
    const m = cfg.markets.get(l.vault.toLowerCase())!;
    return {
      vault: l.vault,
      isYes: l.isYes,
      probWad: priceObservations[i].priceWad,
      cluster: m.cluster,
      underlying: m.underlying,
      bullish: m.direction === "band" ? null : (m.direction === "up") === l.isYes,
    };
  });
  let joint: bigint;
  let bestEstimate: bigint;
  if (cfg.pricingMode === "independent") {
    // Sports: different games are independent, and same-game legs were refused
    // in validation, so the joint is the plain product. No copula, no worker.
    joint = independentJointProbWad(priceObservations.map((price) => price.priceWad));
    bestEstimate = joint;
  } else {
    try {
      joint = riskAdjustedJointProbWad(corrLegs, cfg.correlations, cfg.rhoBandPct);
    } catch (e) {
      // The writer is single-threaded, so a ticket whose factor tree costs
      // seconds to integrate would stall every other request and the poker with
      // it. Refusing is the honest answer; see MAX_QUADRATURE_POINTS.
      if (!(e instanceof TooComplexError)) throw e;
      reject(metrics, "ticket-too-complex");
      return { status: 400, json: { error: "ticket-too-complex" } };
    }
    try {
      bestEstimate = new Set(corrLegs.map((leg) => leg.underlying)).size === 1
        ? riskAdjustedJointProbWad(corrLegs, cfg.correlations, 0)
        : await deps.bestEstimateJointProbWad(corrLegs);
    } catch (error) {
      if (error instanceof TooComplexError) {
        reject(metrics, "ticket-too-complex");
        return { status: 400, json: { error: "ticket-too-complex" } };
      }
      reject(metrics, "pricing-unavailable");
      return { status: 503, json: { error: "pricing-unavailable" } };
    }
  }

  const edge = edgeBreakdown(v.legs.length, cfg.edgeBps, cfg.legEdgeBps);
  const priced = priceParlay(joint, v.stake, totalEdgeBps(edge), cfg.minPremiumBps);
  if (!priced.ok) {
    reject(metrics, priced.reason);
    return { status: 400, json: { error: priced.reason } };
  }

  // A ticket that pays no more than one of its own legs traded alone on Core is
  // strictly worse than that trade; `vault` names the leg worth keeping so the
  // UI can say which legs to drop. See dominatingLeg.
  const dom = dominatingLeg(priceObservations.map((price) => price.priceWad), v.stake, priced.maxPayout);
  if (dom !== -1) {
    reject(metrics, "dominated");
    return { status: 400, json: { error: "dominated", vault: v.legs[dom].vault } };
  }

  // check + reserve is one synchronous step — no awaits between them (spec §4 race guard).
  // All chain/API reads happened above; the signing await happens after the reserve.
  const now = deps.now();
  const risk = priced.maxPayout - priced.premium;
  // Quota keyed on the invite code, not the taker address: codes are limited-supply
  // and already gate this endpoint, so rotating them isn't free — and spam that names
  // someone else's address burns the spammer's own code budget, not the victim's.
  const check = exposure.check(risk, vaults, allowance, cfg.perMarketCap, now, cfg.perClusterCap, v.inviteCode, cfg.perCodeReservedCap);
  if (!check.ok) {
    reject(metrics, check.reason);
    // Structured at-capacity log: the bankroll topup signal (spec §6).
    console.log(JSON.stringify({ at: new Date(now).toISOString(), event: "quote-rejected", reason: check.reason, risk: risk.toString() }));
    // Risk is linear in stake (premium == stake, maxPayout == stake * mult), so
    // the largest stake that still fits under the binding cap is just the same
    // ratio applied to the headroom. Let the taker shrink the ticket instead of
    // guessing at a wall.
    const fitStake = risk > 0n ? (v.stake * check.headroom) / risk : 0n;
    return { status: 409, json: { error: check.reason, maxStake: fitStake.toString() } };
  }
  const quoteId = deps.randomId();
  exposure.reserve(quoteId, risk, vaults, now + cfg.quoteTtlMs, v.inviteCode);

  const quote: ParlayQuote = {
    taker: v.taker,
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
  const decision: QuoteDecision = {
    schemaVersion: 3,
    network: cfg.model.network,
    profileSha256: cfg.model.profileSha256,
    marketRegistrySha256: cfg.model.marketRegistrySha256,
    deploymentRegistrySha256: cfg.model.deploymentRegistrySha256,
    baselineCorrelationSha256: cfg.model.baselineCorrelationSha256,
    artifactKind: cfg.model.artifactKind,
    artifactSha256: cfg.model.artifactSha256,
    validationSha256: cfg.model.validationSha256,
    validationState: cfg.model.validationState,
    pairDecisions: cfg.pricingMode === "independent" ? [] : [...new Set(corrLegs.map((leg) => leg.underlying))].sort().flatMap((left, index, underlyings) => underlyings.slice(index + 1).map((right) => {
      const evidence = cfg.model.pairEligibility.get(pairKey(left, right))!;
      const leftLeg = corrLegs.find((leg) => leg.underlying === left)!;
      const rightLeg = corrLegs.find((leg) => leg.underlying === right)!;
      return {
        pair: [left, right] as [string, string], status: evidence.status, reason: evidence.reason,
        correlation: nominalPairCorrelation(leftLeg, rightLeg, cfg.correlations), evidenceCorrelation: evidence.correlation,
      };
    })),
    recordedAtMs: deps.now(),
    quoteId,
    quoteDigest: quoteDigest(deps.chainId, cfg.parlayVault, quote),
    chainId: deps.chainId,
    parlayVault: cfg.parlayVault,
    taker: quote.taker,
    legs: v.legs.map((leg) => {
      const market = cfg.markets.get(leg.vault.toLowerCase())!;
      return { vault: leg.vault, isYes: leg.isYes, underlying: market.underlying, cluster: market.cluster, direction: market.direction, outcomeCoin: leg.isYes ? market.coinYes : market.coinNo };
    }),
    bookInputs: priceObservations.map((price) => ({
      priceWad: price.priceWad.toString(), source: price.source, observedAtMs: price.observedAtMs,
      depthWad: price.depthWad?.toString() ?? null, vwapWad: price.vwapWad?.toString() ?? null, freshnessMs: price.freshnessMs,
    })),
    modelVersion: cfg.model.version,
    dataAsOf: cfg.model.dataAsOf,
    dataManifestSha256: cfg.model.dataManifestSha256,
    sourceRegistrySha256: cfg.model.sourceRegistrySha256,
    bestEstimateJointProbWad: bestEstimate.toString(),
    riskAdjustedJointProbWad: joint.toString(),
    rhoBandPct: cfg.rhoBandPct,
    edge: { baseBps: edge.baseBps.toString(), legBps: edge.legBps.toString(), totalBps: totalEdgeBps(edge).toString() },
    premium: quote.premium.toString(),
    maxPayout: quote.maxPayout.toString(),
    deadline: quote.deadline.toString(),
    signatureHash: keccak256(sig).slice(2),
  };
  try {
    await deps.recordQuote(decision);
  } catch (err) {
    // Swallowed, this 503s every quote (journal-failed) with nothing in the log to say why.
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
        legs: quote.legs,
        premium: quote.premium.toString(),
        maxPayout: quote.maxPayout.toString(),
        deadline: quote.deadline.toString(),
        quoteId: quote.quoteId,
      },
      sig,
      // Informational only — not covered by the signature. Lets the UI show how
      // the multiplier was built: per-leg book price, the correlated joint
      // probability, then each edge component. Same order as quote.legs.
      breakdown: {
        legPricesWad: priceObservations.map((price) => price.priceWad.toString()),
        jointProbWad: joint.toString(),
        bestEstimateJointProbWad: bestEstimate.toString(),
        edgeBps: edge.baseBps.toString(),
        legBps: edge.legBps.toString(),
        pairDecisions: decision.pairDecisions.map(({ pair, status, reason }) => ({ pair, status, reason })),
      },
    },
  };
}

/** Public beta-waitlist signup: store the email, mail back a generated invite
 * code. Signup is persisted before the send, so a mail failure is retryable
 * (idempotent signup re-sends the same code). */
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
  // No email address in logs — the file is the record; this is the growth pulse.
  console.log(
    JSON.stringify({ at: new Date(deps.now()).toISOString(), event: "waitlist-signup", isNew, total: waitlist.size() }),
  );
  return { status: 200, json: { ok: true } };
}

const MAX_BODY = 64 * 1024;

/** CORS is browser-enforcement only — a non-browser caller (curl, the poker
 * script) never sends an Origin header and ignores these headers entirely, so
 * omitting Access-Control-Allow-Origin never blocks that caller's request; it
 * only stops a browser from letting a disallowed page's JS read the response.
 * The invite gate and exposure caps are the actual blast-radius bound. */
function corsAllowedOrigin(req: http.IncomingMessage, allowlist: string[]): string | undefined {
  const raw = req.headers.origin;
  const origin = Array.isArray(raw) ? raw[0] : raw;
  return origin && allowlist.includes(origin) ? origin : undefined;
}

/** Headers for a route locked to the allowlist (everything but GET /markets).
 * A disallowed or missing Origin omits Access-Control-Allow-Origin — the
 * request still proceeds server-side; only a browser reading the response is
 * stopped, and only for a disallowed origin. Vary: Origin is set either way
 * since the response headers differ by Origin regardless of match — without
 * it a cache could serve one origin's ACAO (or lack of it) to another. */
function lockedCors(req: http.IncomingMessage, allowlist: string[]): Record<string, string> {
  const origin = corsAllowedOrigin(req, allowlist);
  return { Vary: "Origin", ...(origin ? { "Access-Control-Allow-Origin": origin } : {}) };
}

export function startServer(deps: QuoteDeps, port: number, health: () => unknown): http.Server {
  const server = http.createServer((req, res) => {
    // Unhandled 'error' on req/res (e.g. client resets mid-upload) is otherwise an
    // uncaught exception that kills the whole process — log and drop just this request.
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
      // /markets is open (*) on the real GET, so its preflight (browsers only send
      // one for non-simple requests — a plain GET here never triggers it in
      // practice) must match, not fall through to the locked-route default.
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
    if (req.method === "GET" && req.url === "/markets") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      return res.end(deps.cfg.registryJson);
    }
    // Quote-shaping limits the builder needs before it can even offer a stake
    // preset — a chip above maxStake is a button that always 400s.
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
          // Rate-limit key: first hop of x-forwarded-for (set by Caddy in front),
          // falling back to the socket address for direct/local runs.
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
