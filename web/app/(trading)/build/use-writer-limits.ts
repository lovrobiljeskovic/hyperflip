"use client";

import { useEffect, useState } from "react";
import { fetchLimits, type WriterLimits } from "@/lib/writer";

const TTL_SECONDS = 30;

export function useWriterLimits() {
  const [maxStake, setMaxStake] = useState<bigint | null>(null);
  const [limits, setLimits] = useState<WriterLimits | null>(null);
  const [ttlSeconds, setTtlSeconds] = useState(TTL_SECONDS);
  useEffect(() => {
    void fetchLimits().then((l) => {
      if (!l) return;
      setLimits(l);
      setMaxStake(BigInt(l.maxStake));
      if (l.quoteTtlMs > 0) setTtlSeconds(Math.round(l.quoteTtlMs / 1000));
    });
  }, []);
  return { maxStake, limits, ttlSeconds };
}
