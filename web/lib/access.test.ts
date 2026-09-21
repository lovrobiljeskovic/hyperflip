import { afterEach, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";
import { ACCESS_COOKIE, accessReturnPath, checkAdmission } from "./access";
import { proxy } from "../proxy";
import { POST, DELETE } from "../app/api/access/route";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function writer(status = 200, body: unknown = { ok: true }) {
  vi.stubEnv("WRITER_URL", "http://writer.test");
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status })));
}

function request(path: string, code?: string, host = "app.hyperflip.xyz") {
  return new NextRequest(`https://${host}${path}`, { headers: { host, ...(code ? { cookie: `${ACCESS_COOKIE}=${code}` } : {}) } });
}

test("direct app links and local trading pages require a verified admission, including APIs and RSC requests", async () => {
  writer();
  for (const path of ["/", "/build", "/positions", "/pricing", "/unknown", "/build?_rsc=preview"]) {
    const response = await proxy(request(path));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/access");
  }
  expect(fetch).not.toHaveBeenCalled();
  expect((await proxy(request("/api/positions"))).status).toBe(403);
  expect((await proxy(request("/build", undefined, "localhost"))).status).toBe(307);
  for (const path of ["/access", "/api/access"]) expect((await proxy(request(path))).headers.get("x-middleware-next")).toBe("1");
  expect((await proxy(request("/", undefined, "hyperflip.xyz"))).headers.get("x-middleware-next")).toBe("1");
  const admitted = await proxy(request("/positions", "verified-token"));
  expect(admitted.headers.get("x-middleware-next")).toBe("1");
  expect(admitted.headers.get("cache-control")).toBe("private, no-store");
  expect(fetch).toHaveBeenLastCalledWith("http://writer.test/access", expect.objectContaining({ cache: "no-store", headers: expect.objectContaining({ Authorization: "Bearer verified-token" }), body: "{}" }));
  writer(403, { error: "not-admitted" });
  expect((await proxy(request("/build", "made-up-cookie"))).status).toBe(307);
  writer(503, { error: "unavailable" });
  expect((await proxy(request("/api/positions", "verified-token"))).status).toBe(503);
  const unavailable = await proxy(request("/build", "verified-token"));
  expect(unavailable.headers.get("location")).toContain("error=unavailable");
  expect(unavailable.headers.has("set-cookie")).toBe(false);
});

test("access login rejects cross-origin and unadmitted accounts; verified tokens get a protected host cookie", async () => {
  writer();
  const login = (origin: string, accessToken: unknown = "verified-token") => new NextRequest("https://app.hyperflip.xyz/api/access", {
    method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify({ accessToken }),
  });
  expect((await POST(login("https://other.example"))).status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
  expect((await POST(login("https://app.hyperflip.xyz", null))).status).toBe(403);
  writer(403, { error: "not-admitted" });
  const denied = await POST(login("https://app.hyperflip.xyz"));
  expect(denied.status).toBe(403);
  expect(denied.headers.has("set-cookie")).toBe(false);
  writer();
  const admitted = await POST(login("https://app.hyperflip.xyz"));
  expect(admitted.status).toBe(200);
  expect(await admitted.json()).toEqual({ ok: true });
  const cookie = admitted.headers.get("set-cookie")!;
  for (const flag of ["HttpOnly", "Secure", "SameSite=lax", "Path=/"]) expect(cookie).toContain(flag);
  expect(cookie).not.toContain("Domain=");
  const local = (origin: string) => new NextRequest("http://localhost:3001/api/access", {
    method: "POST", headers: { host: "127.0.0.1:3001", origin, "Content-Type": "application/json" },
    body: JSON.stringify({ accessToken: "verified-token" }),
  });
  expect((await POST(local("http://127.0.0.1:3001"))).status).toBe(200);
  expect((await POST(local("http://localhost:3001"))).status).toBe(403);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  expect(await checkAdmission("verified-token")).toBe("unavailable");
});

test("return paths cannot escape the app or loop through the access page", () => {
  for (const path of ["https://evil.example", "//evil.example", "/\\evil.example", "/\t/evil.example", "/access", "/api/access", undefined]) {
    expect(accessReturnPath(path)).toBe("/build");
  }
  expect(accessReturnPath("/positions?view=open")).toBe("/positions?view=open");
});


test("legacy codes cannot create sessions and logout rejects cross-origin requests", async () => {
  writer();
  const url = "https://app.hyperflip.xyz/api/access";
  const headers = { origin: "https://app.hyperflip.xyz", "content-type": "application/json" };
  expect((await POST(new NextRequest(url, { method: "POST", headers, body: JSON.stringify({ inviteCode: "historical-code" }) }))).status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
  expect((await DELETE(new NextRequest(url, { method: "DELETE", headers: { origin: "https://other.example" } }))).status).toBe(403);
  const cleared = await DELETE(new NextRequest(url, { method: "DELETE", headers }));
  expect(cleared.status).toBe(200);
  expect(cleared.headers.get("set-cookie")).toContain(`${ACCESS_COOKIE}=`);
  expect(cleared.headers.get("set-cookie")).toContain("Expires=Thu, 01 Jan 1970");
  writer(401, { error: "unauthenticated" });
  expect(await checkAdmission("expired-token")).toBe("denied");
});
