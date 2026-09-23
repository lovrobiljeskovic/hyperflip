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

/** Same-origin JSON-RPC proxy: the keyed Elysium URL stays server-side, the browser bundle
 * keeps only the public one. Anything but a read is refused before it reaches the endpoint. */
export async function POST(request: Request) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  let body: unknown;
  try { body = await request.json(); } catch { body = undefined; }
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length === 0 || calls.length > MAX_BATCH || !calls.every(isRead)) {
    return Response.json({ error: "Only read-only JSON-RPC calls are accepted" }, { status: 400, headers });
  }
  const upstream = process.env.ELYSIUM_RPC || appChain.rpcUrls.default.http[0];
  try {
    const response = await fetch(upstream, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(20_000) });
    return new Response(await response.text(), { status: response.status, headers });
  } catch {
    // Provider errors can carry the keyed URL. Never return or log them.
    return Response.json({ error: "RPC is temporarily unavailable" }, { status: 502, headers });
  }
}
