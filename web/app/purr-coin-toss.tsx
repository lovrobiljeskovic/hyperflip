export function PurrCoinToss() {
  return (
    <picture
      className="mb-3 block size-[clamp(9.5rem,20vw,12rem)] [filter:drop-shadow(0_16px_24px_rgb(0_0_0/.24))]"
      aria-hidden="true"
    >
      <source media="(prefers-reduced-motion: reduce)" srcSet="/brand/purr-coin-toss-static.webp" />
      <img
        src="/brand/purr-coin-toss.webp"
        alt=""
        width="384"
        height="384"
        fetchPriority="high"
        decoding="async"
        className="size-full object-contain"
      />
    </picture>
  );
}
