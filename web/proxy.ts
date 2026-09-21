import { NextRequest, NextResponse } from "next/server";
import { ACCESS_COOKIE, checkAdmission } from "@/lib/access";

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (path === "/access" || path === "/api/access") return NextResponse.next();
  const appHost = request.headers.get("host")?.split(":")[0].toLowerCase() === "app.hyperflip.xyz";
  const tradingPath = /^\/(?:build|positions|pricing|api\/positions)(?:\/|$)/.test(path);
  if (!appHost && !tradingPath) return NextResponse.next();

  const admission = await checkAdmission(request.cookies.get(ACCESS_COOKIE)?.value);
  if (admission === "admitted") {
    const response = NextResponse.next();
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
  if (path.startsWith("/api/")) {
    return NextResponse.json({ error: admission === "denied" ? "not-admitted" : "access-unavailable" },
      { status: admission === "denied" ? 403 : 503, headers: { "Cache-Control": "no-store" } });
  }
  const url = new URL("/access", request.url);
  url.searchParams.set("next", `${path}${request.nextUrl.search}`);
  if (admission === "unavailable") url.searchParams.set("error", "unavailable");
  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "no-store");
  if (admission === "denied") response.cookies.delete(ACCESS_COOKIE);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|sitemap.xml|opengraph-image).*)"],
};
