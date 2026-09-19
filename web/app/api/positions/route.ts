import "server-only";
import { createPublicClient, http } from "viem";
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
    index ??= createPositionsIndex(createPublicClient({ chain: hyperEvmTestnet,
      transport: http(process.env.POSITIONS_RPC_URL ?? hyperEvmTestnet.rpcUrls.default.http[0], { timeout: 8_000, retryCount: 0 }) }),
    endpoint, process.env.POSITIONS_SUBGRAPH_TOKEN);
    const page = await index(query);
    return Response.json({ ...page, rows: page.rows.map(encodeRow) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Provider/RPC errors can contain credential-bearing URLs. Never return or log them.
    return Response.json({ error: error instanceof PositionsError ? error.message : "Positions are temporarily unavailable" },
      { status: error instanceof PositionsError ? error.status : 503, headers: { "Cache-Control": "no-store" } });
  }
}
