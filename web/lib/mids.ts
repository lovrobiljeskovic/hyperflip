"use client";

import { useSyncExternalStore } from "react";
import { fetchMids, NO_MIDS } from "./info";

const POLL_MS = 5000;

/* One poll for the whole page. useMids() used to own a fetch and an interval
   per caller, so the landing page ran two of each (hero slip + board) and
   /build ran two more (market table + ticket): double the requests, and two
   copies of the same state landing in separate commits, so the hero and the
   board showed different numbers for a second at a time.

   Scheduled with setTimeout after each response rather than setInterval:
   allMids has been measured at 1.8-4.7s against a 5s period, so a fixed
   interval stacks requests on top of ones still in flight. */
let mids = NO_MIDS;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
/* Retires in-flight polls. A request can outlive the subscription that started
   it (StrictMode's mount/unmount/mount, or a route change mid-fetch); without
   this the stale one still re-arms on return and the page ends up with two
   pollers racing. */
let generation = 0;

async function poll(gen: number) {
  const next = await fetchMids();
  if (gen !== generation) return;
  if (next !== NO_MIDS) {
    mids = next;
    listeners.forEach((l) => l());
  }
  timer = setTimeout(() => poll(gen), POLL_MS);
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  if (listeners.size === 1) void poll(++generation);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) {
      generation++;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}

/** Live mids for every coin, keyed by coin string. Every caller on the page
 * shares one poll of allMids (CORS-open, spec §7.5), so they all read the same
 * snapshot in the same commit.
 *
 * `fallback` is a server-rendered snapshot. The first client poll lands ~1.9s
 * after hydration, so without it the hero would print an em dash for every leg
 * and fill the numbers in afterwards — the same "renders twice" problem the
 * market list had. */
export function useMids(fallback: Record<string, string> = NO_MIDS): Record<string, string> {
  const live = useSyncExternalStore(
    subscribe,
    () => mids,
    () => NO_MIDS,
  );
  return live === NO_MIDS ? fallback : live;
}
