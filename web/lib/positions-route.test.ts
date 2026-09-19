import { afterEach, expect, test, vi } from "vitest";
import { createPositionsIndex, PositionsError } from "./positions-index";
import { GET } from "../app/api/positions/route";

vi.mock("./positions-index", async original => ({ ...await original<typeof import("./positions-index")>(), createPositionsIndex: vi.fn() }));
afterEach(() => vi.unstubAllEnvs());

test("API returns explicit errors and never exposes provider credentials", async () => {
  expect((await GET(new Request("http://app/api/positions?wallet=invalid"))).status).toBe(400);
  vi.stubEnv("POSITIONS_SUBGRAPH_URL", "");
  const url = "http://app/api/positions?wallet=0x1111111111111111111111111111111111111111";
  expect((await GET(new Request(url))).status).toBe(503);
  vi.stubEnv("POSITIONS_SUBGRAPH_URL", "https://provider.invalid/private-token");
  const load = vi.fn().mockRejectedValue(new Error("RPC request failed at https://provider.invalid/private-token"));
  vi.mocked(createPositionsIndex).mockReturnValue(load);
  const failed = await GET(new Request(url));
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("private-token");
  load.mockRejectedValue(new PositionsError("Positions changed; refresh", 409));
  expect((await GET(new Request(url))).status).toBe(409);
  load.mockResolvedValue({ rows: [{ id: 1n, block: 2n, mintedAtMs: 3000, burned: false, legVerdicts: [],
    parlay: { premium: 1000000n, maxPayout: 2000000n, legs: [], writer: "0x1111111111111111111111111111111111111111", status: 0 } }], next: null });
  const ok = await GET(new Request(url));
  expect(ok.status).toBe(200);
  expect(ok.headers.get("Cache-Control")).toBe("no-store");
  expect((await ok.json()).rows[0]).toMatchObject({ id: "1", block: "2", parlay: { premium: "1000000", maxPayout: "2000000" } });
});
