import "server-only";
import { createPublicClient, fallback, http } from "viem";
import { hyperEvmTestnet } from "@/lib/chain";
import { createPositionsIndex, parsePositionQuery, PositionsError } from "@/lib/positions-index";
import { encodeRow } from "@/lib/positions-api";

export const runtime = "nodejs";
export const maxDuration = 40;
let index: ReturnType<typeof createPositionsIndex> | undefined;

export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams;
    parsePositionQuery(query);
    const endpoint = process.env.POSITIONS_SUBGRAPH_URL;
    if (!endpoint) throw new PositionsError("Positions index is not configured");
    // Comma-separated, tried in order: one public endpoint rate-limits serverless IPs
    // hard enough to fail the first getChainId, and rpc() rethrows that as a 503.
    const rpcUrls = (process.env.POSITIONS_RPC_URL ?? hyperEvmTestnet.rpcUrls.default.http[0])
      .split(",").map((url) => url.trim()).filter(Boolean);
    index ??= createPositionsIndex(createPublicClient({ chain: hyperEvmTestnet,
      transport: fallback(rpcUrls.map((url) => http(url, { timeout: 8_000, retryCount: 0 }))) }),
    endpoint, process.env.POSITIONS_SUBGRAPH_TOKEN);
    const page = await index(query);
    return Response.json({ ...page, rows: page.rows.map(encodeRow) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Provider/RPC errors can contain credential-bearing URLs. Never return or log them.
    return Response.json({ error: error instanceof PositionsError ? error.message : "Positions are temporarily unavailable" },
      { status: error instanceof PositionsError ? error.status : 503, headers: { "Cache-Control": "no-store" } });
  }
}
