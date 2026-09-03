import { ImageResponse } from "next/og";

export const alt = "Hyperflip. Stack outcomes on HyperCore.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "84px", background: "#0D0F0C", color: "#F1F4EB", fontFamily: "sans-serif" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 34 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 22, fontSize: 38, fontWeight: 800 }}>
          <svg viewBox="0 0 100 100" width="72" height="72">
            <circle cx="50" cy="50" r="48" fill="#C8F36A" stroke="#0D0F0C" strokeWidth="1.5" />
            <circle cx="50" cy="50" r="44.5" fill="none" stroke="#0D0F0C" strokeWidth="1.2" />
            <circle cx="1" cy="50" r="6.5" fill="#0D0F0C" />
            <circle cx="99" cy="50" r="6.5" fill="#0D0F0C" />
            <path d="M50 9A41 41 0 0 0 50 91Z" fill="#C8F36A" stroke="#0D0F0C" strokeWidth="1.2" />
            <path d="M50 9A41 41 0 0 1 50 91Z" fill="#F1F4EB" stroke="#0D0F0C" strokeWidth="1.2" />
            <path d="M26 30 38 21v58L26 70Z" fill="#F1F4EB" stroke="#0D0F0C" strokeWidth="1.4" strokeLinejoin="round" />
            <path d="M38 43h24v14H38l5-7Z" fill="#0D0F0C" />
            <path d="M62 21 74 30v40l-12 9Z" fill="#0D0F0C" />
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
