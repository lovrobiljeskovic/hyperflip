import "server-only";
import { appChain } from "@/lib/chain";

export const runtime = "nodejs";
export const maxDuration = 30;

// Read-only surface of what the client transport issues (viem reads, simulate, receipt
// polling). Wallet sends go through the wallet's own provider, never through here.
const READS = new Set([
  "eth_chainId", "eth_blockNumber", "eth_call", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas",
  "eth_feeHistory", "eth_getBalance", "eth_getCode", "eth_getTransactionCount", "eth_getBlockByNumber",
  "eth_getBlockByHash", "eth_getLogs", "eth_getTransactionByHash", "eth_getTransactionReceipt",
]);
const MAX_BATCH = 100;

const isRead = (call: unknown) => {
  const { id, method } = (typeof call === "object" && call !== null ? call : {}) as { id?: unknown; method?: unknown };
  return id !== undefined && typeof method === "string" && READS.has(method);
};

/** Same-origin JSON-RPC proxy: keyed URLs stay server-side, the browser bundle keeps only the
 * public one. Anything but a read is refused before it reaches an endpoint. `APP_RPC` is a
 * comma-separated list tried in order; a provider that throws or answers non-2xx hands the batch
 * to the next (2026-10-17: Chainlink's hl-node went away while its chain-id probe still answered). */
export async function POST(request: Request) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  let body: unknown;
  try { body = await request.json(); } catch { body = undefined; }
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length === 0 || calls.length > MAX_BATCH || !calls.every(isRead)) {
    return Response.json({ error: "Only read-only JSON-RPC calls are accepted" }, { status: 400, headers });
  }
  const upstreams = (process.env.APP_RPC || appChain.rpcUrls.default.http[0]).split(",").map((u) => u.trim()).filter(Boolean);
  for (const upstream of upstreams) {
    try {
      // 8 s each keeps three upstreams inside maxDuration.
      const response = await fetch(upstream, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(8_000) });
      // ponytail: a dead node behind a healthy gateway answers 200 with a JSON-RPC error and is
      // not retried here; parse the body for -32603/-32005 if that ever shows up.
      if (response.ok) return new Response(await response.text(), { status: 200, headers });
    } catch {
      // Provider errors can carry the keyed URL. Never return or log them.
    }
  }
  return Response.json({ error: "RPC is temporarily unavailable" }, { status: 502, headers });
}
