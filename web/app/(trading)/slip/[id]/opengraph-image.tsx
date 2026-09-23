import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { STATUS } from "@/lib/contracts";
import { formatUsdc, multiplier } from "@/lib/format";
import { loadSlip } from "@/lib/slip";

export const revalidate = 60;
export const alt = "A Hyperflip slip";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#0D0F0C", PANEL = "#151912", LINE = "#30362B", FG = "#F1F4EB", DIM = "#9CA592", ACCENT = "#C8F36A", YES = "#44D17A", NO = "#FF5D6C";
const STAMP: Record<number, string> = { [STATUS.Open]: "MINTED", [STATUS.Won]: "WON", [STATUS.Dead]: "LOST", [STATUS.Void]: "VOID" };

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const [slip, svg] = await Promise.all([loadSlip((await params).id), readFile(join(process.cwd(), "public/brand/logo-clean.svg"), "utf8")]);
  const logo = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  // Six rows fit the card; a longer slip shows the first five and a count.
  const shown = slip ? (slip.legs.length > 6 ? slip.legs.slice(0, 5) : slip.legs) : [];
  const more = slip ? slip.legs.length - shown.length : 0;
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", background: INK, color: FG, fontFamily: "sans-serif", padding: 56 }}>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, border: `2px solid ${LINE}`, borderRadius: 24, background: PANEL, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "36px 44px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 30, fontWeight: 800, letterSpacing: -1.5 }}>
            <img src={logo} width={48} height={48} />
            <span>hyperflip</span>
          </div>
          {slip && (
            <div style={{ display: "flex", padding: "8px 22px", border: `4px solid ${ACCENT}`, borderRadius: 10, color: ACCENT, fontSize: 26, letterSpacing: 6, transform: "rotate(-6deg)" }}>
              {STAMP[slip.status] ?? "MINTED"}
            </div>
          )}
        </div>
        {slip ? (
          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            <div style={{ display: "flex", fontSize: 54, fontWeight: 800, letterSpacing: -2, padding: "28px 44px 0" }}>Slip #{slip.id}</div>
            <div style={{ display: "flex", flexDirection: "column", marginTop: 22, borderTop: `2px solid ${LINE}` }}>
              {shown.map((leg) => (
                <div key={leg.vault} style={{ display: "flex", alignItems: "center", gap: 24, padding: "12px 44px", borderBottom: `2px solid ${LINE}`, background: INK, fontSize: 24 }}>
                  <span style={{ width: 170, color: leg.isYes ? YES : NO, textTransform: leg.group ? "none" : "uppercase", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                    {leg.label ?? (leg.isYes ? "YES" : "NO")}
                  </span>
                  <span style={{ width: 800, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{leg.title}</span>
                </div>
              ))}
              {more > 0 && <div style={{ display: "flex", padding: "12px 44px", color: DIM, fontSize: 22 }}>and {more} more</div>}
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", padding: "0 44px 36px", marginTop: "auto" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, color: DIM, fontSize: 24 }}>
                <span>Stake {formatUsdc(slip.premium)} USDC</span>
                <span>{multiplier(slip.premium, slip.maxPayout)} · {slip.legs.length} legs</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                <span style={{ color: DIM, fontSize: 20, letterSpacing: 4 }}>TO WIN</span>
                <span style={{ color: ACCENT, fontSize: 84, fontWeight: 800, letterSpacing: -3, lineHeight: 1 }}>{formatUsdc(slip.maxPayout)}</span>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", padding: 44, fontSize: 40, color: DIM }}>Slip not found</div>
        )}
      </div>
    </div>,
    size,
  );
}
