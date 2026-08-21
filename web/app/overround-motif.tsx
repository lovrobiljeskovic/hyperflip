/** Motif 02 — the overround. Two intersecting implied-probability volumes; the
 * lens where they overlap is the book's margin. The lens width is bound to the
 * live quoted overround, so it widens as the margin rises: this is data, not
 * decoration. `margin` is a fraction (0.054 = 5.4%); null renders the neutral
 * width used before a quote lands. */
export function Overround({ size, margin }: { size: number; margin: number | null }) {
  // 5% margin is the reference width. Clamped so a wild quote can't draw a lens
  // wider than the circles that produce it.
  const rx = margin === null ? 28 : Math.max(10, Math.min(52, 28 * (1 + (margin - 0.05) * 6)));
  return (
    <svg
      viewBox="0 0 240 200"
      width={size}
      height={(size * 200) / 240}
      aria-hidden
      focusable="false"
    >
      <circle cx="85" cy="85" r="70" fill="none" stroke="var(--color-accent)" strokeOpacity="0.85" strokeWidth="2" />
      <circle cx="145" cy="115" r="70" fill="none" stroke="var(--color-fg)" strokeOpacity="0.6" strokeWidth="1.5" />
      <ellipse
        cx="115"
        cy="100"
        rx={rx}
        ry="54"
        fill="var(--color-accent)"
        fillOpacity="0.6"
        transform="rotate(-31 115 100)"
      />
    </svg>
  );
}
