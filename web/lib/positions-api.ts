import type { Row } from "./positions";

export type PositionSnapshot = { number: string; hash: `0x${string}` };
export type PositionPage = {
  rows: Row[];
  next: string | null;
  snapshot: PositionSnapshot;
  indexed: PositionSnapshot;
  observed: PositionSnapshot & { timestamp: number };
  stale: boolean;
  failed: number;
};

export type WireRow = Omit<Row, "id" | "block" | "parlay"> & {
  id: string; block: string;
  parlay: Omit<Row["parlay"], "premium" | "maxPayout"> & { premium: string; maxPayout: string };
};

export function encodeRow(row: Row): WireRow {
  return { ...row, id: String(row.id), block: String(row.block), parlay: {
    ...row.parlay, premium: String(row.parlay.premium), maxPayout: String(row.parlay.maxPayout),
  } };
}

export function decodeRow(row: WireRow): Row {
  return { ...row, id: BigInt(row.id), block: BigInt(row.block), parlay: {
    ...row.parlay, premium: BigInt(row.parlay.premium), maxPayout: BigInt(row.parlay.maxPayout),
  } };
}

export async function fetchPositionPage(wallet: string, before?: string, snapshot?: PositionSnapshot): Promise<PositionPage> {
  const query = new URLSearchParams({ wallet });
  if (before && snapshot) {
    query.set("before", before);
    query.set("block", snapshot.number);
    query.set("snapshot", snapshot.hash);
  }
  const response = await fetch(`/api/positions?${query}`, { cache: "no-store", signal: AbortSignal.timeout(35_000) });
  if (!response.ok) throw new Error(response.status === 409 ? "Positions changed. Refresh to continue." : "Positions are temporarily unavailable.");
  const page = await response.json() as Omit<PositionPage, "rows"> & { rows: WireRow[] };
  return { ...page, rows: page.rows.map(decodeRow) };
}
