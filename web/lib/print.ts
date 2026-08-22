"use client";

import { useEffect, useState } from "react";

/** Releases the paused `print-line` cascade (see globals.css) once the
 * component has mounted on the client, which the browser only reaches after
 * it has painted. Left to start on its own the animation's clock runs from
 * style resolution during HTML parse, so a slow load burns the cascade
 * off-screen and the slip appears already printed.
 *
 * Returns the class for the element that owns the cascade; every `.print-line`
 * beneath it — including rows mounted later, like a leg added to the ticket —
 * animates from that point on. */
export function usePrinting(): string {
  const [printing, setPrinting] = useState(false);
  useEffect(() => setPrinting(true), []);
  return printing ? "printing" : "";
}
