"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicClient, TransactionReceipt } from "viem";
import { INDEXED_POSITIONS, loadPositions, loadRow, type Row } from "@/lib/positions";
import { fetchPositionPage, type PositionSnapshot } from "@/lib/positions-api";
import { confirmedPositionRow, mergePositionRows, receiptPositions, savedPositions } from "@/lib/position-receipts";

export function usePositions(client: PublicClient | undefined, address: `0x${string}` | undefined) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState<{ before: string; snapshot: PositionSnapshot } | null>(null);
  const sequence = useRef(0);
  const loadingRef = useRef(false);
  const load = useCallback(async (more?: { before: string; snapshot: PositionSnapshot }) => {
    if (!address || !client || loadingRef.current) return;
    loadingRef.current = true;
    const request = ++sequence.current;
    setLoading(true);
    setError(false);
    // Show confirmed receipts while the index request is still in flight.
    const preview = INDEXED_POSITIONS ? receiptPositions(client, address).then(overlay => {
      if (request === sequence.current && overlay.rows.length) setRows(previous => mergePositionRows(previous ?? [], overlay.rows));
      return overlay;
    }) : null;
    try {
      if (!INDEXED_POSITIONS) {
        const result = await loadPositions(client, address);
        if (request !== sequence.current) return;
        setRows(previous => result.failed && !result.rows.length ? previous : result.rows);
        setError(result.failed > 0);
        return;
      }
      const page = await fetchPositionPage(address, more?.before, more?.snapshot);
      await preview;
      const overlay = await receiptPositions(client, address, page.snapshot);
      if (request !== sequence.current) return;
      const nextRows = mergePositionRows(page.rows, overlay.rows);
      const pendingIds = new Set(savedPositions(address).map(p => p.id));
      setRows(previous => {
        if (page.stale && !nextRows.length) return previous;
        const base = more ? mergePositionRows(previous ?? [], nextRows) : nextRows;
        return overlay.failed ? mergePositionRows(base, (previous ?? []).filter(row => pendingIds.has(String(row.id)))) : base;
      });
      setCursor(page.next ? { before: page.next, snapshot: page.snapshot } : null);
      setError(page.failed > 0 || overlay.failed || (page.stale && !nextRows.length));
      setNotice(overlay.pending ? "Your transaction is confirmed. Updating the ticket history…" : page.stale ? "Ticket history is catching up. Refresh for the latest positions." : "");
    } catch {
      if (request !== sequence.current) return;
      setError(true);
      setNotice("Positions could not be updated. Refresh to try again.");
      if (preview) {
        const overlay = await preview;
        if (request === sequence.current && overlay.rows.length) setRows(previous => mergePositionRows(previous ?? [], overlay.rows));
      }
    } finally {
      if (request === sequence.current) { loadingRef.current = false; setLoading(false); }
    }
  }, [client, address]);

  useEffect(() => {
    setRows(null);
    setCursor(null);
    setNotice("");
    loadingRef.current = false;
    void load();
    // Bounded reconciliation: manual refresh remains available after these attempts.
    const timers = INDEXED_POSITIONS && address && savedPositions(address).length
      ? [3000, 8000, 15_000, 30_000].map(ms => setTimeout(() => void load(), ms)) : [];
    return () => { sequence.current++; timers.forEach(clearTimeout); };
  }, [load, address]);

  async function reloadRow(row: Row, receipt: TransactionReceipt) {
    if (!client) return;
    // Retire a pending page request so it cannot overwrite the confirmed action.
    sequence.current++;
    loadingRef.current = false;
    setLoading(false);
    const confirmed = confirmedPositionRow(row, receipt);
    setRows(previous => mergePositionRows(previous ?? [], [confirmed]));
    setNotice("Transaction confirmed. Refresh to update the ticket history.");
    const request = sequence.current;
    try {
      const fresh = await loadRow(client, row);
      if (request === sequence.current && (!confirmed.burned || fresh.burned)) setRows(previous => mergePositionRows(previous ?? [], [{ ...confirmed, ...fresh }]));
    } catch { /* Keep the confirmed receipt result if the RPC is temporarily behind. */ }
  }
  return { rows, error, notice, loading, hasMore: cursor !== null, load: () => load(),
    loadMore: () => cursor ? load(cursor) : Promise.resolve(), reloadRow };
}
