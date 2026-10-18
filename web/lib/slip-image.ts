import { formatUsdc, multiplier } from "./format";
import { legLabel, type BuilderLeg } from "./ticket";

type SlipImageInput = { legs: Pick<BuilderLeg, "isYes" | "title" | "label" | "group">[]; premium: bigint; maxPayout: bigint };

const W = 1080;
const PAD = 72;
const ROW = 112;
const SCALE = 2;
const C = { ink: "#0d0f0c", panel: "#151912", line: "#30362b", fg: "#f1f4eb", dim: "#9ca592", accent: "#c8f36a", yes: "#44d17a", no: "#ff5d6c" };

function families() {
  const pick = (cls: string) => {
    const el = document.querySelector(`.${cls}`);
    return el ? getComputedStyle(el).fontFamily : "sans-serif";
  };
  return { display: pick("display"), mono: pick("mono"), sans: getComputedStyle(document.body).fontFamily };
}

function loadLogo(): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = "/brand/logo-clean.svg";
  });
}

function ellipsis(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

export async function renderSlipPng(slip: SlipImageInput): Promise<Blob> {
  await document.fonts.ready;
  const [logo, f] = await Promise.all([loadLogo(), families()]);
  const H = 520 + slip.legs.length * ROW + 300;
  const canvas = document.createElement("canvas");
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(SCALE, SCALE);

  ctx.fillStyle = C.ink;
  ctx.fillRect(0, 0, W, H);
  const card = { x: 40, y: 40, w: W - 80, h: H - 80, r: 28 };
  ctx.beginPath();
  ctx.roundRect(card.x, card.y, card.w, card.h, card.r);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = C.line;
  ctx.stroke();

  let y = card.y + PAD;
  ctx.drawImage(logo, PAD, y, 48, 48);
  ctx.fillStyle = C.fg;
  ctx.font = `800 34px ${f.display}`;
  ctx.textBaseline = "middle";
  ctx.fillText("hyperflip", PAD + 62, y + 25);

  y += 130;
  ctx.font = `700 76px ${f.display}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(`${slip.legs.length} leg combo`, PAD - 2, y);
  y += 44;
  ctx.font = `400 28px ${f.sans}`;
  ctx.fillStyle = C.dim;
  ctx.fillText("All legs must hit.", PAD, y);

  y += 52;
  for (const leg of slip.legs) {
    ctx.fillStyle = C.line;
    ctx.fillRect(card.x, y, card.w, 2);
    ctx.fillStyle = C.ink;
    ctx.fillRect(card.x, y + 2, card.w, ROW - 2);
    const label = legLabel(leg);
    ctx.font = `500 24px ${f.mono}`;
    ctx.fillStyle = leg.isYes ? C.yes : C.no;
    ctx.fillText(leg.group ? label : label.toUpperCase(), PAD, y + 44);
    ctx.font = `400 28px ${f.sans}`;
    ctx.fillStyle = C.dim;
    ctx.fillText(ellipsis(ctx, leg.title, card.w - PAD * 2), PAD, y + 84);
    y += ROW;
  }
  ctx.fillStyle = C.line;
  ctx.fillRect(card.x, y, card.w, 2);

  y += 64;
  const right = W - PAD;
  ctx.font = `400 26px ${f.mono}`;
  const row = (k: string, v: string) => {
    ctx.fillStyle = C.dim;
    ctx.textAlign = "left";
    ctx.fillText(k, PAD, y);
    ctx.fillStyle = C.fg;
    ctx.textAlign = "right";
    ctx.fillText(v, right, y);
    y += 44;
  };
  row("Stake", `${formatUsdc(slip.premium)} USDC`);
  row("Multiplier", multiplier(slip.premium, slip.maxPayout));
  y += 8;
  ctx.fillStyle = C.line;
  ctx.fillRect(PAD, y, card.w - PAD * 2 + 8, 2);
  y += 84;
  ctx.fillStyle = C.dim;
  ctx.textAlign = "left";
  ctx.font = `500 20px ${f.mono}`;
  ctx.letterSpacing = "3px";
  ctx.fillText("TO WIN", PAD, y);
  ctx.letterSpacing = "0px";
  ctx.fillStyle = C.accent;
  ctx.textAlign = "right";
  ctx.font = `500 82px ${f.mono}`;
  ctx.fillText(formatUsdc(slip.maxPayout), right + 4, y + 6);

  y += 60;
  ctx.setLineDash([8, 10]);
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(card.x, y);
  ctx.lineTo(card.x + card.w, y);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const cx of [card.x, card.x + card.w]) {
    ctx.beginPath();
    ctx.arc(cx, y, 20, 0, Math.PI * 2);
    ctx.fillStyle = C.ink;
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = C.dim;
  ctx.textAlign = "center";
  ctx.font = `500 22px ${f.mono}`;
  ctx.letterSpacing = "2px";
  ctx.fillText("hyperflip.xyz", W / 2, y + 62);

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
  );
}
