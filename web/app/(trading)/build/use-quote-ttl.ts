"use client";

import { type RefObject, useEffect, useState } from "react";
import { secondsLeft } from "@/lib/format";
import type { QuoteResult } from "@/lib/writer";

/** Counts the live quote down every 250 ms and requotes on expiry. `clockSkewRetried` is owned by the
 * caller, which resets it on every new ticket and on retry. */
export function useQuoteTtl({ quoteResult, mintState, runQuote, setQuoteResult, clockSkewRetried }: {
  quoteResult: QuoteResult | null;
  mintState: string;
  runQuote: () => Promise<void>;
  setQuoteResult: (result: QuoteResult | null) => void;
  clockSkewRetried: RefObject<boolean>;
}): number {
  const [ttlLeft, setTtlLeft] = useState(0);
  useEffect(() => {
    if (!quoteResult?.ok) {
      setTtlLeft(0);
      return;
    }
    if (mintState === "pending" || mintState === "done") return; // freeze - don't requote under a mint
    let firstTick = true;
    let expired = false;
    const tick = () => {
      if (expired) return;
      const left = secondsLeft(BigInt(quoteResult.quote.deadline), Date.now());
      setTtlLeft(left);
      if (left <= 0) {
        expired = true;
        if (firstTick && clockSkewRetried.current) {
          setQuoteResult({ ok: false, status: 0, error: "clock-skew" });
          return;
        }
        if (firstTick) clockSkewRetried.current = true;
        setQuoteResult(null);
        void runQuote();
      }
      firstTick = false;
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [quoteResult, mintState, runQuote, setQuoteResult, clockSkewRetried]);
  return ttlLeft;
}
