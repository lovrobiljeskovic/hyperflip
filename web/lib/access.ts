import "server-only";

export const ACCESS_COOKIE = "hyperflip-access";

/** Recheck the admission record on each request; a made-up cookie grants nothing. */
export async function checkAdmission(code: unknown): Promise<"admitted" | "denied" | "unavailable"> {
  if (typeof code !== "string" || !code || code.length > 256) return "denied";
  const writer = process.env.WRITER_URL ?? process.env.NEXT_PUBLIC_WRITER_URL;
  if (!writer) return "unavailable";
  try {
    const response = await fetch(`${writer.replace(/\/$/, "")}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteCode: code }),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 200 && (await response.json()).ok === true) return "admitted";
    return response.status === 403 ? "denied" : "unavailable";
  } catch { return "unavailable"; }
}

export function accessReturnPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\r\n]/.test(value)) return "/build";
  const url = new URL(value, "https://hyperflip.local");
  if (url.origin !== "https://hyperflip.local" || /^\/(?:access|api\/access)(?:\/|$)/.test(url.pathname)) return "/build";
  return `${url.pathname}${url.search}`;
}
