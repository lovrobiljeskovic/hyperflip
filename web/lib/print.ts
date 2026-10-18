"use client";

import { useEffect, useState } from "react";

/** Releases the paused `print-line` cascade after first paint, so a slow load cannot burn it off-screen.
 * The returned class owns every `.print-line` beneath it, including rows mounted later. */
export function usePrinting(): string {
  const [printing, setPrinting] = useState(false);
  useEffect(() => setPrinting(true), []);
  return printing ? "printing" : "";
}
