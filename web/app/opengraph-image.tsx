import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "Hyperflip. Combos on HIP-4 markets.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage() {
  const svg = await readFile(join(process.cwd(), "public/brand/logo-clean.svg"), "utf8");
  const logo = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "84px", background: "#0D0F0C", color: "#F1F4EB", fontFamily: "sans-serif" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 34 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 22, fontSize: 38, fontWeight: 800 }}>
          <img src={logo} width={72} height={72} />
          <span>hyperflip</span>
        </div>
        <div style={{ display: "flex", maxWidth: 740, fontSize: 78, fontWeight: 800, lineHeight: .93, letterSpacing: "-4px" }}>Stack your picks. Multiply the payout.</div>
        <div style={{ display: "flex", fontSize: 24, color: "#9CA592" }}>Combos on HIP-4 markets · HyperEVM testnet</div>
      </div>
      <div style={{ display: "flex", width: 20, height: 350, background: "#C8F36A", transform: "skewY(-18deg)" }} />
    </div>,
    size,
  );
}
