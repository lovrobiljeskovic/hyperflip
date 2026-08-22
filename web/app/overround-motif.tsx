/** Motif 02 — the overround. Two implied-probability rings on counter-tilted
 * planes, turning about a shared 3D axis: under perspective each reads as
 * spinning against the other, and they cross where the book takes its margin.
 *
 * The splay between the planes is bound to the live quoted overround, so the
 * rings separate as the margin rises: this is data, not decoration. `margin`
 * is a fraction (0.054 = 5.4%); null renders the neutral splay used before a
 * quote lands. The turn is continuous — the motif is the only graphic on the
 * slip panel, and every state a taker without a signed quote can reach used to
 * leave it inert. */
export function Overround({ size, margin }: { size: number; margin: number | null }) {
  // 5% margin is the reference splay. Clamped so a wild quote can't tip a ring
  // to edge-on, where it stops reading as a ring at all.
  const tilt = margin === null ? 38 : Math.max(20, Math.min(55, 38 * (1 + (margin - 0.05) * 4)));
  return (
    <div className="motif" style={{ width: size, height: size }} aria-hidden>
      <div className="motif-spin">
        <span className="motif-ring motif-ring-a" style={{ transform: `rotateY(${tilt}deg)` }} />
        <span className="motif-ring motif-ring-b" style={{ transform: `rotateY(${-tilt}deg)` }} />
      </div>
    </div>
  );
}
