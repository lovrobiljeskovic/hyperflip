"use client";

import { type RefObject, useEffect } from "react";

/** Pin the element's bottom when it's taller than the viewport: sticky top =
 * min(6rem, viewport - height - 1rem). CSS alone can't read its own height.
 * `mounted` re-runs the measurement when the element appears or goes away. */
export function useStickyFit(ref: RefObject<HTMLElement | null>, mounted: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.top = `${Math.min(96, window.innerHeight - el.offsetHeight - 16)}px`;
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [ref, mounted]);
}
