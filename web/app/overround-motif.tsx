/** Two implied-probability rings whose splay follows the quoted overround.
 * `margin` is a fraction (0.054 = 5.4%); null renders the neutral splay. */
export function Overround({ margin }: { margin: number | null }) {
  // 5% margin is the reference splay. Clamped so a wild quote can't tip a ring
  // to edge-on, where it stops reading as a ring at all.
  const tilt = margin === null ? 38 : Math.max(20, Math.min(55, 38 * (1 + (margin - 0.05) * 4)));
  return (
    <div className="motif" style={{ width: 44, height: 44 }} aria-hidden>
      <div className="motif-spin">
        <span className="motif-ring motif-ring-a" style={{ transform: `rotateY(${tilt}deg)` }} />
        <span className="motif-ring motif-ring-b" style={{ transform: `rotateY(${-tilt}deg)` }} />
      </div>
    </div>
  );
}
