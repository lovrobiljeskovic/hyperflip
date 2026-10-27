"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, LinkIcon } from "lucide-react";
import { slipUrl } from "@/lib/share";
import { Button } from "@/components/ui/button";

const TITLE = "Copy a link that opens this slip - valid until its markets kick off";

/** Copies a link that rebuilds the slip in a friend's builder. `icon` is the header glyph
 * on the ticket; otherwise a full-width button for the minted dialog. */
export function CopySlipLink({ legs, icon = false }: { legs: { vault: string; isYes: boolean }[]; icon?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(slipUrl(location.origin, legs));
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2500);
    } catch { /* clipboard blocked: nothing to show, the X share still carries the link */ }
  }
  if (icon) {
    return (
      <Button variant="ghost" size="icon-sm" onClick={() => void copy()} aria-label="Copy slip link" title={TITLE} className="text-dim hover:text-fg">
        {copied ? <CheckIcon className="text-yes" /> : <LinkIcon />}
      </Button>
    );
  }
  return (
    <Button variant="outline" onClick={() => void copy()} title={TITLE} className="mono h-11 w-full text-[12px] uppercase tracking-[0.1em]">
      {copied ? "Link copied" : "Copy link"}
    </Button>
  );
}
