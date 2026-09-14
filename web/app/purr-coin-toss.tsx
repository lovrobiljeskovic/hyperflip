"use client";

import { useEffect, useRef, useState } from "react";

const poster = "/brand/purr-hero-poster.jpg";

export function PurrCoinToss() {
  const video = useRef<HTMLVideoElement>(null);
  const [animate, setAnimate] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px) and (prefers-reduced-motion: no-preference)");
    const update = () => setAnimate(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return (
    <>
      <div
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden [mask-image:radial-gradient(ellipse_70%_65%_at_50%_50%,black_30%,transparent_75%)]"
        aria-hidden="true"
      >
        <div className="absolute left-[-45%] top-0 aspect-video w-[150%] opacity-[.35] [mask-image:radial-gradient(ellipse_48%_48%_at_50%_50%,black_15%,#0009_45%,transparent_100%)] lg:left-[-16%] lg:top-1/2 lg:w-[110%] lg:-translate-y-1/2">
          <img className="absolute inset-0 size-full object-contain" src={poster} alt="" width="1280" height="720" />
          {animate && (
            <video
              ref={video}
              className="relative block size-full object-contain"
              src="/brand/purr-hero.mp4"
              poster={poster}
              autoPlay
              muted
              loop
              playsInline
              width="1280"
              height="720"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onError={() => setAnimate(false)}
            />
          )}
        </div>
      </div>
      {animate && (
        <button
          type="button"
          className="absolute right-6 bottom-3 z-10 min-h-11 rounded-lg px-3 text-xs text-dim hover:text-fg"
          onClick={() => {
            const player = video.current;
            if (!player) return;
            if (player.paused) void player.play().catch(() => setPlaying(false));
            else player.pause();
          }}
        >
          {playing ? "Pause animation" : "Play animation"}
        </button>
      )}
    </>
  );
}
