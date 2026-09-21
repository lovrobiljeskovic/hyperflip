import { NextRequest, NextResponse } from "next/server";
import { ACCESS_COOKIE, checkAdmission } from "@/lib/access";

export async function POST(request: NextRequest) {
  const json = (value: unknown, status: number) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
  // Prevent another origin from replacing a user's admission session.
  // Next may normalize the internal URL to localhost; compare the actual Host.
  const origin = `${request.nextUrl.protocol}//${request.headers.get("host") ?? request.nextUrl.host}`;
  if (request.headers.get("origin") !== origin ||
      !request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "bad-request" }, 403);
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "bad-request" }, 400); }
  const code = typeof body?.inviteCode === "string" ? body.inviteCode.trim() : null;
  const admission = await checkAdmission(code);
  if (admission !== "admitted") return json({ error: admission === "denied" ? "not-admitted" : "access-unavailable" }, admission === "denied" ? 403 : 503);
  const response = json({ ok: true }, 200);
  response.cookies.set(ACCESS_COOKIE, code!, {
    httpOnly: true, secure: request.nextUrl.protocol === "https:", sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}
