import "server-only";
import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { appChain } from "./chain";
import { MULTICALL3 } from "./contracts";
import { shortAddress } from "./format";
import { deriveRow, readTicket } from "./positions";
import { ticketCardState, type CardState } from "./share-card";
import { legFor } from "./slip-storage";
import { fetchMarkets, type Market } from "./writer";

/** Plain decimal only; anything else (hex, negative, 20+ digits) is not a ticket we could have minted. */
export function parseTicketId(raw: string): bigint | null {
  return /^\d{1,18}$/.test(raw) ? BigInt(raw) : null;
}

let client: PublicClient | undefined;
function serverClient(): PublicClient {
  const urls = (process.env.POSITIONS_RPC_URL ?? appChain.rpcUrls.default.http[0]).split(",").map((u) => u.trim()).filter(Boolean);
  return (client ??= createPublicClient({ chain: { ...appChain, contracts: { multicall3: { address: MULTICALL3 } } },
    transport: fallback(urls.map((u) => http(u, { timeout: 8_000, retryCount: 0 }))) }) as PublicClient);
}

/** Null on any failure: the OG route answers 404 and never surfaces an RPC error (URLs may carry keys). */
export async function loadTicketCard(id: bigint, deps: { read?: typeof readTicket; markets?: () => Promise<Market[]>; client?: PublicClient } = {}): Promise<CardState | null> {
  try {
    const [ticket, markets] = await Promise.all([
      (deps.read ?? readTicket)(deps.client ?? serverClient(), id),
      (deps.markets ?? (() => fetchMarkets(true)))(),
    ]);
    // An unminted id reads back as an empty parlay (and ownerOf reverts, which looks "burned").
    if (ticket.parlay.legs.length === 0 || ticket.parlay.premium === 0n) return null;
    const byVault = new Map(markets.map((m) => [m.vault.toLowerCase(), m]));
    const legs = ticket.parlay.legs.map((l) => {
      const m = byVault.get(l.vault.toLowerCase());
      return m ? legFor(m, l.isYes) : { vault: l.vault, isYes: l.isYes, title: shortAddress(l.vault), coin: "" };
    });
    const row = { ...ticket, block: 0n, mintedAtMs: 0 };
    return ticketCardState(row, legs, deriveRow(row));
  } catch { return null; }
}
