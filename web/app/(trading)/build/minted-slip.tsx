"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { appHref } from "@/lib/site";
import { ShareOnX } from "../slip/share-on-x";
import { SlipCard } from "../slip/slip-card";
import type { MintedSlip } from "./use-ticket";

/** The confirmed slip, printed once the mint lands. A native dialog: focus
 * trap, Escape and backdrop come free, so the only state is open or not. */
export function MintedSlipDialog({ slip, onClose }: { slip: MintedSlip | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (slip && !el.open) el.showModal();
    if (!slip && el.open) el.close();
  }, [slip]);

  // Read after mount so the server render and the first client render agree.
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  if (!slip) return null;
  const { legs, premium, maxPayout, hash, id } = slip;
  // The post links this exact slip when the mint event parsed; the app root otherwise.
  // Absolute in production via NEXT_PUBLIC_APP_ORIGIN; resolved against the page elsewhere.
  const path = appHref(id === null ? "/" : `/slip/${id}`);
  const url = path.startsWith("http") ? path : origin + path;

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      aria-labelledby="slip-title"
      className="minted-dialog m-auto w-[min(100%-2rem,400px)] bg-transparent p-0 backdrop:bg-ink/85 backdrop:backdrop-blur-sm"
    >
      <SlipCard
        legs={legs}
        premium={premium}
        maxPayout={maxPayout}
        id={id}
        hash={hash}
        stamp="Minted"
        footer={
          <>
            <div className="grid grid-cols-2 gap-2">
              <ShareOnX legs={legs} premium={premium} maxPayout={maxPayout} url={url} />
              <Link
                href="/positions"
                className="mono flex items-center justify-center rounded-[8px] border border-line py-[13px] text-[12px] uppercase tracking-[0.1em] text-fg transition-colors hover:border-dim"
              >
                View positions
              </Link>
            </div>
            <button type="button" onClick={onClose} className="mono mt-3 w-full py-1 text-[11px] text-dim transition-colors hover:text-fg">
              Back to the board
            </button>
          </>
        }
      />
    </dialog>
  );
}
