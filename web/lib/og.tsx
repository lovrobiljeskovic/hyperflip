import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { cardHeight, type CardState } from "./share-card";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** The mark has no fill or size of its own (the page styles it); satori paints it black at 0×0 without both. */
async function logoDataUrl(): Promise<string> {
  const svg = (await readFile(join(process.cwd(), "public/brand/logo-clean.svg"), "utf8")).replace("<svg ", '<svg fill="#f1f4eb" width="2400" height="2400" ');
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

type Font = { name: string; data: Buffer; weight: 400 | 500 | 700; style: "normal" };
const FONT_FILES: [string, string, Font["weight"]][] = [
  ["Bricolage Grotesque", "BricolageGrotesque-Bold.ttf", 700],
  ["Instrument Sans", "InstrumentSans-Regular.ttf", 400],
  ["Martian Mono", "MartianMono-Regular.ttf", 400],
  ["Martian Mono", "MartianMono-Medium.ttf", 500],
];
/** Vendored TTFs (assets/fonts, OFL): satori needs ttf/otf and refuses to draw text with no font at
 * all, so the files ship with the app instead of being fetched. Read once per process. */
let fonts: Promise<Font[]> | undefined;
const loadFonts = () => (fonts ??= Promise.all(FONT_FILES.map(async ([name, file, weight]) =>
  ({ name, weight, style: "normal" as const, data: await readFile(join(process.cwd(), "assets/fonts", file)) }))));

/** Static page cards: landing, build, leaderboard. */
export async function ogCard(headline: string, subtitle: string) {
  const logo = await logoDataUrl();
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "84px", background: "#0D0F0C", color: "#F1F4EB", fontFamily: "sans-serif" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 34 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 22, fontSize: 38, fontWeight: 800 }}>
          <img src={logo} width={72} height={72} />
          <span>hyperflip</span>
        </div>
        <div style={{ display: "flex", maxWidth: 740, fontSize: 78, fontWeight: 800, lineHeight: .93, letterSpacing: "-4px" }}>{headline}</div>
        <div style={{ display: "flex", fontSize: 24, color: "#9CA592" }}>{subtitle}</div>
      </div>
      <div style={{ display: "flex", width: 20, height: 350, background: "#C8F36A", transform: "skewY(-18deg)" }} />
    </div>,
    size,
  );
}

const C = { ink: "#0d0f0c", panel: "#151912", line: "#30362b", fg: "#f1f4eb", dim: "#9ca592", accent: "#c8f36a", yes: "#44d17a", no: "#ff5d6c" } as const;
const W = 1000; // natural card width; the canvas card was 1080 with 40px ink margins
const PAD = 72;
const TONE = { accent: C.accent, yes: C.yes, no: C.no, dim: C.dim } as const;

/** The one share card (slip, ticket, record): the portrait card designed at W×cardHeight, drawn
 * into the 1200×630 Open Graph frame with every length multiplied by one scale factor. Satori
 * applies `transform: scale` to descendants twice, so the scaling is done in the numbers instead.
 * Every multi-child element is display:flex, as satori requires. */
export async function shareCard(state: CardState) {
  const [logo, fontList] = await Promise.all([logoDataUrl(), loadFonts()]);
  const H = cardHeight(state);
  const k = (size.height - 40) / H;
  const px = (n: number) => Math.round(n * k * 100) / 100;
  const display = "Bricolage Grotesque", sans = "Instrument Sans", mono = "Martian Mono";
  const inner = px(W - PAD * 2);
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: C.ink }}>
      <div style={{ display: "flex", flexDirection: "column", width: px(W), height: px(H), background: C.panel,
        border: `2px solid ${C.line}`, borderRadius: px(28), color: C.fg, fontFamily: sans, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: px(14), padding: `${px(PAD)}px ${px(PAD)}px 0` }}>
          <img src={logo} width={px(48)} height={px(48)} />
          <span style={{ fontFamily: display, fontSize: px(34), fontWeight: 700 }}>hyperflip</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", padding: `${px(60)}px ${px(PAD)}px 0` }}>
          <span style={{ fontFamily: display, fontSize: px(76), fontWeight: 700, letterSpacing: px(-2) }}>{state.headline}</span>
          <span style={{ fontSize: px(28), color: C.dim, marginTop: px(10) }}>{state.subline}</span>
        </div>
        {state.legs.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", width: px(W), marginTop: px(40), borderTop: `2px solid ${C.line}` }}>
            {state.legs.map((leg, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", width: px(W), height: px(112), padding: `0 ${px(PAD)}px`,
                justifyContent: "center", background: C.ink, borderBottom: `2px solid ${C.line}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: px(12) }}>
                  {leg.dot && <div style={{ display: "flex", width: px(12), height: px(12), borderRadius: px(6),
                    background: leg.dot === "hit" ? C.yes : leg.dot === "lost" ? C.no : C.dim, opacity: leg.dot === "pending" ? .5 : 1 }} />}
                  <span style={{ fontFamily: mono, fontSize: px(24), fontWeight: 500, color: leg.isYes ? C.yes : C.no }}>{leg.label}</span>
                </div>
                <div style={{ display: "flex", width: inner, fontSize: px(28), color: C.dim, marginTop: px(8), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{leg.title}</div>
              </div>
            ))}
          </div>
        )}
        {state.rows.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", width: px(W), padding: `${px(48)}px ${px(PAD)}px 0`, fontFamily: mono, fontSize: px(26) }}>
            {state.rows.map(([key, value]) => (
              <div key={key} style={{ display: "flex", width: inner, justifyContent: "space-between", marginBottom: px(18) }}>
                <span style={{ color: C.dim }}>{key}</span><span>{value}</span>
              </div>
            ))}
          </div>
        )}
        {state.hero && (
          <div style={{ display: "flex", width: inner, alignItems: "flex-end", justifyContent: "space-between", margin: `${px(16)}px ${px(PAD)}px 0`,
            paddingTop: px(36), borderTop: `2px solid ${C.line}` }}>
            <span style={{ fontFamily: mono, fontSize: px(20), fontWeight: 500, letterSpacing: px(3), color: C.dim }}>{state.hero.label}</span>
            <span style={{ fontFamily: mono, fontSize: px(82), fontWeight: 500, color: TONE[state.hero.tone], lineHeight: 1 }}>{state.hero.value}</span>
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: px(W), marginTop: "auto", paddingBottom: px(56) }}>
          <div style={{ display: "flex", width: px(W), borderTop: `2px dashed ${C.line}` }} />
          <span style={{ fontFamily: mono, fontSize: px(22), fontWeight: 500, letterSpacing: px(2), color: C.dim, marginTop: px(40) }}>hyperflip.xyz</span>
        </div>
      </div>
    </div>,
    { ...size, fonts: fontList },
  );
}
