import "server-only";

export const ACCESS_COOKIE = "hyperflip-session";

/** Recheck the admission record on each request; a made-up cookie grants nothing. */
export async function checkAdmission(token: unknown): Promise<"admitted" | "denied" | "unavailable"> {
  if (typeof token !== "string" || !token || token.length > 8192) return "denied";
  const writer = process.env.WRITER_URL ?? process.env.NEXT_PUBLIC_WRITER_URL;
  if (!writer) return "unavailable";
  try {
    const response = await fetch(`${writer.replace(/\/$/, "")}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{}",
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 200 && (await response.json()).ok === true) return "admitted";
    return response.status === 401 || response.status === 403 ? "denied" : "unavailable";
  } catch { return "unavailable"; }
}

export function accessReturnPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\r\n]/.test(value)) return "/build";
  const url = new URL(value, "https://hyperflip.local");
  if (url.origin !== "https://hyperflip.local" || /^\/(?:access|api\/access)(?:\/|$)/.test(url.pathname)) return "/build";
  return `${url.pathname}${url.search}`;
}
