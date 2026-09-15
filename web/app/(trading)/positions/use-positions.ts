"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicClient } from "viem";
import { loadPositions, loadRow, type Row } from "@/lib/positions";
import type { ParlayRef } from "@/lib/writer";

export function usePositions(client: PublicClient | undefined, address: `0x${string}` | undefined) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    setError(false);
    setRows(null);
    if (!address || !client) return;
    try {
      const result = await loadPositions(client, address);
      if (request !== sequence.current) return;
      setRows(result.failed && !result.rows.length ? null : result.rows);
      setError(result.failed > 0);
    } catch { if (request === sequence.current) setError(true); }
  }, [client, address]);

  useEffect(() => {
    void load();
    return () => { sequence.current++; };
  }, [load]);

  async function reloadRow(ref: ParlayRef) {
    if (!client) return;
    const request = sequence.current;
    const fresh = await loadRow(client, ref);
    if (request === sequence.current) setRows(previous => previous?.map(row => row.id === ref.id ? fresh : row) ?? null);
  }
  return { rows, error, load, reloadRow };
}
