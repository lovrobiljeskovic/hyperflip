import { afterEach, expect, test, vi } from "vitest";
import { loadSlip, restoreLegs, saveSlip, slipKey } from "./slip-storage";
import type { Market } from "./writer";
import type { BuilderLeg } from "./ticket";

afterEach(() => vi.unstubAllGlobals());

const vaultA = `0x${"a".repeat(40)}` as const;
const vaultB = `0x${"b".repeat(40)}` as const;
const leg = (vault: `0x${string}`, isYes: boolean): BuilderLeg => ({ vault, isYes, title: `t-${vault.slice(2, 4)}`, coin: `c-${vault.slice(2, 4)}` });
const market = (vault: `0x${string}`): Market => ({ vault, title: "x", coinYes: "y", coinNo: "n", category: "sports" } as Market);

test("slip key is per chain and vault", () => {
  expect(slipKey()).toMatch(/^hf:slip:\d+:0x[0-9a-f]{40}$/);
});

test("saveSlip and loadSlip round-trip only vault and side", () => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  saveSlip([leg(vaultA, true), leg(vaultB, false)]);
  expect(loadSlip()).toEqual([{ vault: vaultA, isYes: true }, { vault: vaultB, isYes: false }]);
  saveSlip([]);
  expect(loadSlip()).toEqual([]);
  store.set(slipKey(), "{not json");
  expect(loadSlip()).toEqual([]);
  store.set(slipKey(), JSON.stringify([{ vault: "nope", isYes: true }, { vault: vaultA, isYes: "yes" }, { vault: vaultA, isYes: true }]));
  expect(loadSlip()).toEqual([{ vault: vaultA, isYes: true }]);
});

test("throwing storage neither crashes nor persists", () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } });
  expect(() => saveSlip([leg(vaultA, true)])).not.toThrow();
  expect(loadSlip()).toEqual([]);
});

test("restoreLegs drops legs whose market left the board and keeps board order of the saved list", () => {
  const legFor = (m: Market, isYes: boolean) => leg(m.vault, isYes);
  const restored = restoreLegs([{ vault: vaultB, isYes: false }, { vault: vaultA, isYes: true }, { vault: `0x${"c".repeat(40)}`, isYes: true }], [market(vaultA), market(vaultB)], legFor);
  expect(restored.map((l) => [l.vault, l.isYes])).toEqual([[vaultB, false], [vaultA, true]]);
});
