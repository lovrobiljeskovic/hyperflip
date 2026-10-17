import { appChain } from "./chain";
import { afterEach, expect, test, vi } from "vitest";
import { POST } from "../app/api/rpc/route";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const post = (body: unknown) => POST(new Request("http://app/api/rpc", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
const call = (method: string, id = 1) => ({ jsonrpc: "2.0", id, method, params: [] });

test("proxy forwards read-only JSON-RPC to the keyed endpoint and never exposes it", async () => {
  vi.stubEnv("APP_RPC", "https://provider.invalid/private-key");
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);

  const ok = await post(call("eth_blockNumber"));
  expect(ok.status).toBe(200);
  expect(ok.headers.get("Cache-Control")).toBe("no-store");
  expect(await ok.json()).toMatchObject({ result: "0x1" });
  expect(fetch).toHaveBeenCalledWith("https://provider.invalid/private-key", expect.objectContaining({ method: "POST", body: JSON.stringify(call("eth_blockNumber")) }));

  const batch = await post([call("eth_call", 1), call("eth_getBlockByNumber", 2)]);
  expect(batch.status).toBe(200);
  expect(fetch).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ body: JSON.stringify([call("eth_call", 1), call("eth_getBlockByNumber", 2)]) }));

  expect((await post(call("eth_sendRawTransaction"))).status).toBe(400);
  expect((await post([call("eth_call", 1), call("personal_sign", 2)])).status).toBe(400);
  expect((await post("not json")).status).toBe(400);
  expect((await post([])).status).toBe(400);
  expect((await post({ method: "eth_call" })).status).toBe(400);
  expect(fetch).toHaveBeenCalledTimes(2);

  fetch.mockRejectedValue(new Error("fetch failed: https://provider.invalid/private-key"));
  const down = await post(call("eth_call"));
  expect(down.status).toBe(502);
  expect(await down.text()).not.toContain("private-key");
});

test("proxy falls back to the public app-chain endpoint when no key is configured", async () => {
  vi.stubEnv("APP_RPC", "");
  const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  await post(call("eth_chainId"));
  // The app chain's own endpoint (fixture URL under the repo gate), never a keyed one.
  expect(fetch.mock.calls[0][0]).toBe(appChain.rpcUrls.default.http[0]);
  expect(fetch.mock.calls[0][0]).not.toContain("private");
});

test("proxy tries APP_RPC upstreams in order and skips one that fails or answers non-2xx", async () => {
  vi.stubEnv("APP_RPC", "https://dead.invalid/key, https://gateway.invalid/key,https://alive.invalid/key");
  const fetch = vi.fn()
    .mockRejectedValueOnce(new Error("fetch failed: https://dead.invalid/key"))
    .mockResolvedValueOnce(new Response('{"error":"upstream"}', { status: 500 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2" }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const ok = await post(call("eth_call"));
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ result: "0x2" });
  expect(fetch.mock.calls.map((c) => c[0])).toEqual(["https://dead.invalid/key", "https://gateway.invalid/key", "https://alive.invalid/key"]);

  fetch.mockReset().mockResolvedValue(new Response("boom https://dead.invalid/key", { status: 503 }));
  const down = await post(call("eth_call"));
  expect(down.status).toBe(502);
  expect(await down.text()).not.toContain("invalid/key");
  expect(fetch).toHaveBeenCalledTimes(3);
});
