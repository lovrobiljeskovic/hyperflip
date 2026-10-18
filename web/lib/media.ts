"use client";

import { useCallback, useSyncExternalStore } from "react";

/** Server and first client render say false; the real match lands right after hydration. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const mq = window.matchMedia(query);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

/** True at Tailwind `lg` and up, so the phone layout is the hydration baseline and the desktop
 * rail mounts right after. */
export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 1024px)");
}
