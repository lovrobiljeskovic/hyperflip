import { afterEach, expect, test, vi } from "vitest";
import { formatOdds, readOddsFormat, setOddsFormat, ODDS_FORMATS } from "./odds-format";

afterEach(() => { vi.unstubAllGlobals(); });

test("formatOdds renders each format and the null dash", () => {
  expect(formatOdds(0.61, "x")).toBe("1.64x");
  expect(formatOdds(0.61, "decimal")).toBe("1.64");
  expect(formatOdds(0.61, "probability")).toBe("61%");
  expect(formatOdds(0.4, "american")).toBe("+150");
  expect(formatOdds(0.61, "american")).toBe("-156");
  expect(formatOdds(0.5, "american")).toBe("+100");
  for (const f of ODDS_FORMATS) expect(formatOdds(null, f)).toBe("—");
});

test("odds format persists through storage and tolerates a throwing one", () => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  setOddsFormat("decimal");
  expect(store.get("hf:odds-format")).toBe("decimal");
  expect(readOddsFormat()).toBe("decimal");
  store.set("hf:odds-format", "garbage");
  expect(readOddsFormat()).toBe("x");
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  expect(() => setOddsFormat("american")).not.toThrow();
  expect(readOddsFormat()).toBe("american");
});
