import http from "node:http";
import { isAddress, type Address, type Hex } from "viem";
import type { WriterConfig } from "./config.js";
import { ExposureBook } from "./exposure.js";
import { priceParlay } from "./pricing.js";
import type { ParlayQuote, QuoteLeg } from "./quotes.js";

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
  fetchLegPriceWad(leg: QuoteLeg): Promise<bigint>;
  readAllowance(): Promise<bigint>;
  /** Lowercase vault addresses of legs already settled. */
  readSettled(vaults: Address[]): Promise<Set<string>>;
  sign(q: ParlayQuote): Promise<Hex>;
  now(): number;
  randomId(): Hex;
  metrics: Metrics;
}

type Validated =
  | { ok: true; taker: Address; legs: QuoteLeg[]; stake: bigint }
  | { ok: false; status: number; reason: string };

export function validateQuoteRequest(body: unknown, cfg: WriterConfig, now: number): Validated {
  const b = body as { taker?: unknown; legs?: unknown; stake?: unknown };
  if (!b || typeof b.taker !== "string" || !isAddress(b.taker)) {
    return { ok: false, status: 400, reason: "bad-taker" };
  }
  if (!Array.isArray(b.legs)) return { ok: false, status: 400, reason: "bad-legs" };
  if (b.legs.length < cfg.minLegs || b.legs.length > 10) {
    return { ok: false, status: 400, reason: "bad-leg-count" };
  }
  const legs: QuoteLeg[] = [];
  const seen = new Set<string>();
  for (const l of b.legs as { vault?: unknown; isYes?: unknown }[]) {
    if (typeof l?.vault !== "string" || !isAddress(l.vault) || typeof l.isYes !== "boolean") {
      return { ok: false, status: 400, reason: "bad-leg" };
    }
    const key = l.vault.toLowerCase();
    if (seen.has(key)) return { ok: false, status: 400, reason: "duplicate-vault" };
    seen.add(key);
    const market = cfg.markets.get(key);
    if (!market) return { ok: false, status: 400, reason: "unknown-vault" };
    if (market.expiryMs !== undefined && now >= market.expiryMs - cfg.lockoutMs) {
      return { ok: false, status: 400, reason: "expiry-lockout" };
    }
    legs.push({ vault: l.vault as Address, isYes: l.isYes });
  }
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

export async function handleQuote(deps: QuoteDeps, body: unknown): Promise<{ status: number; json: unknown }> {
  const { cfg, exposure, metrics } = deps;
  const v = validateQuoteRequest(body, cfg, deps.now());
  if (!v.ok) {
    reject(metrics, v.reason);
    return { status: v.status, json: { error: v.reason } };
  }
  const vaults = v.legs.map((l) => l.vault);

  let settled: Set<string>;
  let pricesWad: bigint[];
  let allowance: bigint;
  try {
    settled = await deps.readSettled(vaults);
  } catch {
    reject(metrics, "rpc-down");
    return { status: 503, json: { error: "rpc-down" } };
  }
  const settledLeg = v.legs.find((l) => settled.has(l.vault.toLowerCase()));
  if (settledLeg) {
    reject(metrics, "leg-settled");
    return { status: 409, json: { error: "leg-settled", vault: settledLeg.vault } };
  }
  try {
    pricesWad = await Promise.all(v.legs.map((l) => deps.fetchLegPriceWad(l)));
  } catch {
    reject(metrics, "stale-book");
    return { status: 503, json: { error: "stale-book" } };
  }
  try {
    allowance = await deps.readAllowance();
  } catch {
    reject(metrics, "rpc-down");
    return { status: 503, json: { error: "rpc-down" } };
  }

  const priced = priceParlay(pricesWad, v.stake, cfg.edgeBps, cfg.minPremiumBps);
  if (!priced.ok) {
    reject(metrics, priced.reason);
    return { status: 400, json: { error: priced.reason } };
  }

  // check + reserve is one synchronous step — no awaits between them (spec §4 race guard).
  // All chain/API reads happened above; the signing await happens after the reserve.
  const now = deps.now();
  const risk = priced.maxPayout - priced.premium;
  const check = exposure.check(risk, vaults, allowance, cfg.perMarketCap, now);
  if (!check.ok) {
    reject(metrics, check.reason);
    // Structured at-capacity log: the bankroll topup signal (spec §6).
    console.log(JSON.stringify({ at: new Date(now).toISOString(), event: "quote-rejected", reason: check.reason, risk: risk.toString() }));
    return { status: 409, json: { error: check.reason } };
  }
  const quoteId = deps.randomId();
  exposure.reserve(quoteId, risk, vaults, now + cfg.quoteTtlMs);

  const quote: ParlayQuote = {
    taker: v.taker,
    legs: v.legs,
    premium: priced.premium,
    maxPayout: priced.maxPayout,
    deadline: BigInt(Math.floor((now + cfg.quoteTtlMs) / 1000)),
    quoteId,
  };
  const sig = await deps.sign(quote);
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
    },
  };
}

export function startServer(deps: QuoteDeps, port: number, health: () => unknown): http.Server {
  const server = http.createServer((req, res) => {
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.method === "GET" && req.url === "/health") return send(200, health());
    if (req.method === "GET" && req.url === "/metrics") return send(200, deps.metrics);
    if (req.method === "POST" && req.url === "/quote") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return send(400, { error: "bad-json" });
        }
        try {
          const r = await handleQuote(deps, body);
          send(r.status, r.json);
        } catch (err) {
          console.error(new Date().toISOString(), "quote handler error", err);
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
