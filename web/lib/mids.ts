"use client";

import { useEffect, useState } from "react";

const INFO_API = process.env.NEXT_PUBLIC_INFO_API ?? "https://api.hyperliquid-testnet.xyz/info";

/** Live mids for every coin, keyed by coin string ("#130690" → "0.56667").
 * Polls allMids (CORS-open, spec §7.5). ponytail: poll only; switch to the
 * WS allMids subscription if 5s latency ever feels bad. */
export function useMids(pollMs = 5000): Record<string, string> {
  const [mids, setMids] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(INFO_API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "allMids" }),
        });
        if (alive && r.ok) setMids(await r.json());
      } catch {
        /* keep last mids on transient failure */
      }
    };
    void load();
    const t = setInterval(load, pollMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pollMs]);
  return mids;
}
