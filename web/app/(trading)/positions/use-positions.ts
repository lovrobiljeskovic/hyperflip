"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicClient, TransactionReceipt } from "viem";
import { INDEXED_POSITIONS, loadPositions, loadRow, type Row } from "@/lib/positions";
import { fetchPositionPage, type PositionSnapshot } from "@/lib/positions-api";
import { confirmedPositionRow, forgetPositions, mergePositionRows, receiptPositions, savedPositions } from "@/lib/position-receipts";

export function usePositions(client: PublicClient | undefined, address: `0x${string}` | undefined) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState<{ before: string; snapshot: PositionSnapshot } | null>(null);
  const sequence = useRef(0);
  const loadingRef = useRef(false);
  // quiet: a background reconciliation retry. Failures stay silent (the previous state stands);
  // only the initial load and a manual Refresh report problems. Success always clears them.
  const load = useCallback(async (more?: { before: string; snapshot: PositionSnapshot }, quiet = false) => {
    if (!address || !client || loadingRef.current) return;
    loadingRef.current = true;
    const request = ++sequence.current;
    setLoading(true);
    if (!quiet) setError(false);
    const preview = receiptPositions(client, address).then(overlay => {
      if (request === sequence.current && overlay.rows.length) setRows(previous => mergePositionRows(previous ?? [], overlay.rows));
      return overlay;
    });
    try {
      if (!INDEXED_POSITIONS) {
        // Writer index lags a poll tick behind the chain; a fresh mint's receipt fills the gap.
        const [result, overlay] = await Promise.all([loadPositions(client, address), preview]);
        if (request !== sequence.current) return;
        const indexed = new Set(result.rows.map(row => String(row.id)));
        if (result.rows.length && !result.failed) forgetPositions(address, result.rows.reduce((max, row) => row.block > max ? row.block : max, 0n));
        const rows = mergePositionRows(result.rows, overlay.rows);
        setRows(previous => result.failed && !rows.length ? previous : rows);
        if (!quiet || !result.failed) setError(result.failed > 0);
        if (!quiet || !result.failed) setNotice(overlay.rows.some(row => !indexed.has(String(row.id))) ? "Your transaction is confirmed. Updating the ticket history…" : "");
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
      const trouble = page.failed > 0 || overlay.failed || (page.stale && !nextRows.length);
      if (quiet && trouble) return;
      setError(trouble);
      setNotice(overlay.pending ? "Your transaction is confirmed. Updating the ticket history…" : page.stale ? "Ticket history is catching up. Refresh for the latest positions." : "");
    } catch {
      if (request !== sequence.current || quiet) return;
      setError(true);
      setNotice("Positions could not be updated. Refresh to try again.");
      const overlay = await preview;
      if (request === sequence.current && overlay.rows.length) setRows(previous => mergePositionRows(previous ?? [], overlay.rows));
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
    const timers = address && savedPositions(address).length
      ? [3000, 8000, 15_000, 30_000].map(ms => setTimeout(() => void load(undefined, true), ms)) : [];
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
