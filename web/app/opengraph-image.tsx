import { ImageResponse } from "next/og";

export const alt = "Hyperflip. Stack outcomes on HyperCore.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "84px", background: "#0D0F0C", color: "#F1F4EB", fontFamily: "sans-serif" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 34 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 22, fontSize: 38, fontWeight: 800 }}>
          <svg viewBox="0 0 96 96" width="72" height="72">
            <circle cx="48" cy="48" r="44" fill="#C8F36A" />
            <circle cx="48" cy="48" r="40.5" fill="none" stroke="#0D0F0C" strokeWidth="1.5" />
            <circle cx="48" cy="48" r="37" fill="#0D0F0C" />
            <g transform="translate(25 23) scale(.62)">
              <path fill="#C8F36A" d="M5 16 24 5v25l32 17v14L24 45v20L5 76Z" />
              <path fill="#F1F4EB" d="M6.5 41.5 24 51v14Z" />
              <path fill="#F1F4EB" d="m56 16 13-7v60l-13 7Z" />
            </g>
          </svg>
          <span>hyperflip</span>
        </div>
        <div style={{ display: "flex", maxWidth: 740, fontSize: 78, fontWeight: 800, lineHeight: .93, letterSpacing: "-4px" }}>Flip markets. Stack outcomes.</div>
        <div style={{ display: "flex", fontSize: 24, color: "#9CA592" }}>Live on HyperEVM testnet</div>
      </div>
      <div style={{ display: "flex", width: 20, height: 350, background: "#C8F36A", transform: "skewY(-18deg)" }} />
    </div>,
    size,
  );
}
