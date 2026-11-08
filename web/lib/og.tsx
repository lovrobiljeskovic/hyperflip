import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import type { CardState } from "./share-card";

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
  ({ name, weight, style: "normal" as const, data: await readFile(join(process.cwd(), "assets/fonts", file)) })))
  .catch((e) => { fonts = undefined; throw e; }));

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
const TONE = { accent: C.accent, yes: C.yes, no: C.no, dim: C.dim } as const;
/** Share cards render at 2× the Open Graph frame so text stays crisp on high-density screens. */
export const CARD_SIZE = { width: size.width * 2, height: size.height * 2 };
const MAX_LEG_ROWS = 6;

/** The one share card (slip, ticket, record) as a landscape ticket: the stub on the left carries
 * the headline, stake rows and hero; the legs fill the right pane. Designed in 1200×630 units and
 * drawn at 2×. Every multi-child element is display:flex, as satori requires. */
export async function shareCard(state: CardState) {
  const [logo, fontList] = await Promise.all([logoDataUrl(), loadFonts()]);
  const px = (n: number) => n * 2;
  const display = "Bricolage Grotesque", sans = "Instrument Sans", mono = "Martian Mono";
  const stubW = 420, cardW = 1200 - 48, cardH = 630 - 48, paneW = cardW - stubW, padX = 40;
  // A leg's colour is its outcome once it has one; a fresh slip colours by side, as the builder does.
  const legColor = (leg: CardState["legs"][number]) =>
    leg.dot ? (leg.dot === "hit" ? C.yes : leg.dot === "lost" ? C.no : C.dim) : leg.isYes ? C.yes : C.no;
  const shown = state.legs.length > MAX_LEG_ROWS ? state.legs.slice(0, MAX_LEG_ROWS - 1) : state.legs;
  const hidden = state.legs.length - shown.length;
  const rowH = Math.min(96, cardH / (shown.length + (hidden ? 1 : 0) || 1));
  const tiles = state.legs.length === 0;

  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: C.ink, fontFamily: sans }}>
      <div style={{ display: "flex", width: px(cardW), height: px(cardH), background: C.panel, border: `${px(2)}px solid ${C.line}`, borderRadius: px(24), color: C.fg, overflow: "hidden" }}>
        {/* stub */}
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: px(stubW), padding: `${px(44)}px ${px(44)}px ${px(36)}px` }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", gap: px(10) }}>
              <img src={logo} width={px(34)} height={px(34)} />
              <span style={{ fontFamily: display, fontSize: px(24), fontWeight: 700 }}>hyperflip</span>
            </div>
            <span style={{ fontFamily: display, fontSize: px(60), fontWeight: 700, letterSpacing: px(-1.5), lineHeight: 1, marginTop: px(40) }}>{state.headline}</span>
            <span style={{ fontSize: px(22), color: C.dim, marginTop: px(12) }}>{state.subline}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {!tiles && state.rows.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", fontFamily: mono, fontSize: px(19), marginBottom: px(18) }}>
                {state.rows.map(([key, value]) => (
                  <div key={key} style={{ display: "flex", justifyContent: "space-between", marginBottom: px(8) }}>
                    <span style={{ color: C.dim }}>{key}</span><span>{value}</span>
                  </div>
                ))}
              </div>
            )}
            {state.hero && (
              <div style={{ display: "flex", flexDirection: "column", paddingTop: px(18), borderTop: `${px(2)}px solid ${C.line}` }}>
                <span style={{ fontFamily: mono, fontSize: px(14), fontWeight: 500, letterSpacing: px(2.5), color: C.dim }}>{state.hero.label}</span>
                <span style={{ fontFamily: mono, fontSize: px(64), fontWeight: 500, color: TONE[state.hero.tone], lineHeight: 1, marginTop: px(8) }}>{state.hero.value}</span>
              </div>
            )}
            <span style={{ fontFamily: mono, fontSize: px(14), fontWeight: 500, letterSpacing: px(2), color: C.dim, marginTop: px(24) }}>hyperflip.xyz</span>
          </div>
        </div>
        {/* tear line with notches */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 0, height: "100%", borderLeft: `${px(2)}px dashed ${C.line}`, position: "relative" }}>
          <div style={{ display: "flex", position: "absolute", top: px(-14), left: px(-14), width: px(28), height: px(28), borderRadius: px(14), background: C.ink, border: `${px(2)}px solid ${C.line}` }} />
          <div style={{ display: "flex", position: "absolute", bottom: px(-14), left: px(-14), width: px(28), height: px(28), borderRadius: px(14), background: C.ink, border: `${px(2)}px solid ${C.line}` }} />
        </div>
        {/* pane */}
        <div style={{ display: "flex", flexDirection: "column", width: px(paneW), height: "100%", background: C.ink }}>
          {tiles ? (
            <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", height: "100%", padding: `0 ${px(56)}px` }}>
              {state.rows.map(([key, value], i) => (
                <div key={key} style={{ display: "flex", flexDirection: "column", padding: `${px(28)}px 0`, borderTop: i ? `${px(2)}px solid ${C.line}` : "none" }}>
                  <span style={{ fontFamily: mono, fontSize: px(14), fontWeight: 500, letterSpacing: px(2.5), color: C.dim }}>{key.toUpperCase()}</span>
                  <span style={{ fontFamily: mono, fontSize: px(64), fontWeight: 500, lineHeight: 1, marginTop: px(10) }}>{value}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", height: "100%" }}>
              {shown.map((leg, i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", justifyContent: "center", height: px(rowH), padding: `0 ${px(padX)}px`, borderTop: i ? `${px(2)}px solid ${C.line}` : "none" }}>
                  <span style={{ fontFamily: mono, fontSize: px(rowH >= 80 ? 20 : 16), fontWeight: 500, color: legColor(leg) }}>{leg.label}</span>
                  <div style={{ display: "flex", width: px(paneW - padX * 2), fontSize: px(rowH >= 80 ? 24 : 19), color: C.fg, marginTop: px(rowH >= 80 ? 6 : 2), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{leg.title}</div>
                </div>
              ))}
              {hidden > 0 && (
                <div style={{ display: "flex", alignItems: "center", height: px(rowH), padding: `0 ${px(padX)}px`, borderTop: `${px(2)}px solid ${C.line}`, fontFamily: mono, fontSize: px(16), color: C.dim }}>
                  +{hidden} more {hidden === 1 ? "leg" : "legs"}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    { ...CARD_SIZE, fonts: fontList },
  );
}
