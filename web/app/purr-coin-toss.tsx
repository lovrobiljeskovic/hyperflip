const box = "block size-[clamp(9.5rem,20vw,12rem)] object-contain";

export function PurrCoinToss() {
  return (
    <div className="mb-3">
      <video className={`${box} motion-reduce:hidden`} autoPlay muted loop playsInline aria-hidden="true" width="384" height="384">
        <source src="/brand/purr-coin-toss.mp4" type="video/mp4" />
      </video>
      <img className={`${box} motion-safe:hidden`} src="/brand/purr-coin-toss-static.webp" alt="" width="384" height="384" />
    </div>
  );
}
