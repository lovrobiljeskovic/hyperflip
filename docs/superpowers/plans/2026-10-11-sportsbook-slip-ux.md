# Sportsbook Slip UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/build` feel like a sportsbook slip: event cards with odds buttons, a bottom-sheet slip on the phone, dollar stake chips, one wallet prompt per ticket, an odds-format toggle, a persisted slip, and a phone header reduced to logo + funds chip + hamburger.

**Architecture:** All work is in `web/` (Next.js 16 app router, React 19, Tailwind v4, wagmi + viem + Privy, Vitest for `lib/**`). New pure logic goes in small `lib/*.ts` files with tests; components stay in `app/`. `useTicket` is lifted out of `Ticket` into the page so one quote loop feeds both the desktop rail and the phone sheet. No new dependencies, no state library, no component library.

**Tech Stack:** TypeScript, Next.js 16.3 (read `web/node_modules/next/dist/docs/` before touching routing or layouts), React 19, Tailwind v4 `@theme` tokens in `web/app/globals.css`, wagmi 3 / viem 2, Vitest 4.

**Spec:** `~/docs/superpowers/specs/2026-10-11-sportsbook-slip-ux-design.md` (archived in the vault under `Archive/specs/`). Mocks: https://claude.ai/artifact/2ZfycbVGhzpBs4suGPsaxR, tab "A · Sportsbook".

## Global Constraints

- Vocabulary: slip, ticket, legs, mint, positions. The word "bet" never appears in UI text, aria labels, or copy. "Approve" appears only on the first ticket's CTA.
- `MIN_LEGS = 2` stays (`web/app/(trading)/build/use-ticket.ts:17`). No singles.
- No new npm dependencies. No `zustand`, `framer-motion`, `radix`, icon packs.
- Design tokens only: `ink`, `panel`, `raised`, `line`, `fg`, `dim`, `accent`, `on-accent`, `yes`, `no` from `web/app/globals.css`. No new hex colours in components.
- Every number is mono tabular (`mono` class). Money as `formatUsdc` (2 dp) with a `$` prefix in the new slip controls.
- Reduced motion: every new animation or transition has a `motion-reduce:` fallback or a `@media (prefers-reduced-motion: reduce)` override.
- Landing page (`web/app/page.tsx`) must keep excluding wallet-provider code from its JavaScript (`scripts/check-page-bundles.mjs` enforces it in `npm run check`).
- Standing USDC allowance = `ALLOWANCE_MULTIPLE (25) × maxStake` from `/limits`; when `maxStake` is unknown, approve the exact premium.
- Default odds format is `x` (today's `oddsLabel`). Storage key `hf:odds-format`.
- Slip storage key `hf:slip:<chainId>:<vault lowercase>`. Stake is not persisted.
- Commits go through the `caveman:caveman-commit` skill (user rule). Conventional Commits, `feat(web): …` / `test(web): …`.
- Check command: `npm run check --prefix web` (build + vitest + bundle gate). Fast loop: `npx vitest run --prefix web` or `cd web && npx vitest run lib/<file>.test.ts`.
- Rollout deviation from the spec, decided in this plan: **no `NEXT_PUBLIC_SLIP_UX` flag.** Work on branch `feat/sportsbook-slip`, verify on a Vercel preview deploy, then promote per lane. A build-time flag would carry the old list view and old `Ticket` for one deploy cycle for no user benefit. If the user wants the flag, add it at Task 12.

## Review Focus

1. A stake chip larger than the house `maxStake` (today 8 USDC) must be disabled with the limit in its `title`, never a button that 409s. Pinned in Task 6 (`chipState`).
2. A persisted leg whose market has left the board (expired, rotated out) must be dropped silently on restore, never rendered as a dead leg. Pinned in Task 2 (`restoreLegs`).
3. When `/limits` fails (`maxStake === null`), the first-ticket approval must fall back to the exact premium, not `25 × 0`. Pinned in Task 3 (`standingAllowance`).
4. American odds at exactly `0.5` must read `+100`, and a `null` mid must read `—` in every format. Pinned in Task 1 (`formatOdds`).
5. `localStorage` that throws (private window, blocked storage) must not break the page: restore returns `[]`, save is a no-op. Pinned in Task 2 (`loadSlip` / `saveSlip` with a throwing storage).

---

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `web/lib/odds-format.ts` | create | `OddsFormat` type, `formatOdds`, storage-backed `useOddsFormat` / `setOddsFormat` |
| `web/lib/odds-format.test.ts` | create | format math, persistence |
| `web/app/odds-format-toggle.tsx` | create | segmented control bound to `useOddsFormat` |
| `web/lib/slip-storage.ts` | create | `loadSlip`, `saveSlip`, `restoreLegs` |
| `web/lib/slip-storage.test.ts` | create | round trip, drop unknown vault, throwing storage |
| `web/lib/slip-summary.ts` | create | pure helpers for the sheet bar and stake chips: `barSummary`, `chipState`, `STAKE_CHIPS` |
| `web/lib/slip-summary.test.ts` | create | bar text, chip states |
| `web/lib/ticket.ts` | modify | `ALLOWANCE_MULTIPLE`, `standingAllowance`, `revokeUsdc` |
| `web/lib/ticket.test.ts` | modify | allowance tests |
| `web/lib/media.ts` | create | `useIsDesktop()` (`matchMedia` via `useSyncExternalStore`) |
| `web/app/funds-chip.tsx` | create | balance + Deposit (faucet link on 998, bridge dialog on Elysium) |
| `web/app/wallet-menu.tsx` | create | rows for the hamburger: address, network, switch chain, revoke allowance, disconnect |
| `web/app/site-header.tsx` | modify | `mobileAction` and `menu` slots |
| `web/app/app-header.tsx` | modify | wire FundsChip + WalletMenu |
| `web/app/(trading)/build/use-ticket.ts` | modify | drop `display`, standing allowance, CTA labels, `toWin` |
| `web/app/(trading)/build/ticket.tsx` | modify | takes `ticket` prop; new stake block; single CTA; no `display` mode |
| `web/app/(trading)/build/slip-sheet.tsx` | create | phone bottom sheet with collapsed bar |
| `web/app/(trading)/build/page.tsx` | modify | cards only, odds toggle in filters row, lifted `useTicket`, persistence, sheet vs rail |
| `web/app/(trading)/build/minted-slip.tsx` | modify | subtitle, phone slide-up, button labels |
| `web/app/live-markets.tsx` | modify | `OddsCell` uses `formatOdds` |
| `web/app/globals.css` | modify | sheet + dialog animations, reduced-motion |

---

### Task 0: Branch

**Files:** none.

- [ ] **Step 1: Create the branch from `main`**

```bash
cd /Users/lovrobiljeskovic/hype-evm && git switch -c feat/sportsbook-slip
```

- [ ] **Step 2: Confirm the web check is green before changing anything**

Run: `npm run check --prefix web`
Expected: build succeeds, all vitest files pass, bundle gate prints no error. If red, stop and report; do not start Task 1 on a red baseline.

---

### Task 1: Odds format library and toggle

**Files:**
- Create: `web/lib/odds-format.ts`
- Create: `web/lib/odds-format.test.ts`
- Create: `web/app/odds-format-toggle.tsx`

**Interfaces:**
- Produces: `type OddsFormat = "x" | "decimal" | "american" | "probability"`, `ODDS_FORMATS: readonly OddsFormat[]`, `ODDS_FORMAT_LABEL: Record<OddsFormat, string>`, `formatOdds(mid: number | null, format: OddsFormat): string`, `useOddsFormat(): OddsFormat`, `setOddsFormat(f: OddsFormat): void`, `OddsFormatToggle(): JSX`.

- [ ] **Step 1: Write the failing tests**

```ts
// web/lib/odds-format.test.ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run lib/odds-format.test.ts`
Expected: FAIL, `Cannot find module './odds-format'`.

- [ ] **Step 3: Write the library**

```ts
// web/lib/odds-format.ts
"use client";

import { useSyncExternalStore } from "react";

export type OddsFormat = "x" | "decimal" | "american" | "probability";
export const ODDS_FORMATS: readonly OddsFormat[] = ["x", "decimal", "american", "probability"];
export const ODDS_FORMAT_LABEL: Record<OddsFormat, string> = { x: "1.5x", decimal: "1.50", american: "+150", probability: "%" };
const KEY = "hf:odds-format";
const DEFAULT: OddsFormat = "x";

export function formatOdds(mid: number | null, format: OddsFormat): string {
  if (mid === null || !(mid > 0 && mid < 1)) return "—";
  switch (format) {
    case "x": return `${(1 / mid).toFixed(2)}x`;
    case "decimal": return (1 / mid).toFixed(2);
    case "probability": return `${Math.round(mid * 100)}%`;
    case "american": {
      // Underdog (p < .5): profit per 100 staked. Favourite: stake per 100 profit. 0.5 is +100 by convention.
      return mid <= 0.5 ? `+${Math.round((1 / mid - 1) * 100)}` : `-${Math.round((mid / (1 - mid)) * 100)}`;
    }
  }
}

const isFormat = (v: unknown): v is OddsFormat => ODDS_FORMATS.includes(v as OddsFormat);

// Module-level mirror so a blocked localStorage still keeps the choice for the session.
let current: OddsFormat | null = null;
const listeners = new Set<() => void>();

export function readOddsFormat(): OddsFormat {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    // Storage is the source of truth when readable; an unknown value is the default, not the last choice.
    if (raw !== null) return isFormat(raw) ? (current = raw) : DEFAULT;
    return current ?? DEFAULT;
  } catch { return current ?? DEFAULT; }
}

export function setOddsFormat(f: OddsFormat): void {
  current = f;
  try { localStorage.setItem(KEY, f); } catch { /* storage blocked; the in-memory value still applies */ }
  listeners.forEach((l) => l());
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => { listeners.delete(onChange); };
}

/** The viewer's odds format; `x` on the server and before hydration. */
export function useOddsFormat(): OddsFormat {
  return useSyncExternalStore(subscribe, readOddsFormat, () => DEFAULT);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run lib/odds-format.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the toggle component**

```tsx
// web/app/odds-format-toggle.tsx
"use client";

import { ODDS_FORMAT_LABEL, ODDS_FORMATS, setOddsFormat, useOddsFormat } from "@/lib/odds-format";

/** Segmented control. Lives in the hamburger on the phone and at the right of the market filters on desktop. */
export function OddsFormatToggle({ className = "" }: { className?: string }) {
  const format = useOddsFormat();
  return (
    <div role="group" aria-label="Odds format" className={`mono inline-flex overflow-hidden rounded-[6px] border border-line text-[11px] ${className}`}>
      {ODDS_FORMATS.map((f) => (
        <button
          key={f}
          type="button"
          aria-pressed={format === f}
          onClick={() => setOddsFormat(f)}
          className={`px-2.5 py-1 transition-colors ${format === f ? "bg-raised text-fg" : "text-dim hover:text-fg"}`}
        >
          {ODDS_FORMAT_LABEL[f]}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add web/lib/odds-format.ts web/lib/odds-format.test.ts web/app/odds-format-toggle.tsx
```
Commit with the `caveman:caveman-commit` skill. Message shape: `feat(web): odds format helper and toggle`.

---

### Task 2: Slip persistence

**Files:**
- Create: `web/lib/slip-storage.ts`
- Create: `web/lib/slip-storage.test.ts`

**Interfaces:**
- Consumes: `BuilderLeg` from `web/lib/ticket.ts`, `Market` from `web/lib/writer.ts`, `appChain` from `web/lib/chain.ts`, `PARLAY_VAULT` from `web/lib/contracts.ts`.
- Produces: `slipKey(): string`, `loadSlip(): SavedLeg[]`, `saveSlip(legs: BuilderLeg[]): void`, `restoreLegs(saved: SavedLeg[], board: Market[], legFor: (m: Market, isYes: boolean) => BuilderLeg): BuilderLeg[]`, `type SavedLeg = { vault: `0x${string}`; isYes: boolean }`.

- [ ] **Step 1: Write the failing tests**

```ts
// web/lib/slip-storage.test.ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run lib/slip-storage.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the library**

```ts
// web/lib/slip-storage.ts
import { appChain } from "./chain";
import { PARLAY_VAULT } from "./contracts";
import type { BuilderLeg } from "./ticket";
import type { Market } from "./writer";

export type SavedLeg = { vault: `0x${string}`; isYes: boolean };

export const slipKey = (): string => `hf:slip:${appChain.id}:${PARLAY_VAULT.toLowerCase()}`;

const isSaved = (v: unknown): v is SavedLeg =>
  !!v && typeof v === "object" && /^0x[0-9a-f]{40}$/i.test(String((v as SavedLeg).vault)) && typeof (v as SavedLeg).isYes === "boolean";

export function loadSlip(): SavedLeg[] {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(slipKey());
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSaved).map((l) => ({ vault: l.vault, isYes: l.isYes })) : [];
  } catch { return []; }
}

export function saveSlip(legs: BuilderLeg[]): void {
  try {
    if (legs.length === 0) localStorage.removeItem(slipKey());
    else localStorage.setItem(slipKey(), JSON.stringify(legs.map((l) => ({ vault: l.vault, isYes: l.isYes }))));
  } catch { /* storage blocked: the slip lives for this page only */ }
}

/** Rebuild legs from a saved list against the board that just loaded. Unknown vaults are dropped. */
export function restoreLegs(saved: SavedLeg[], board: Market[], legFor: (m: Market, isYes: boolean) => BuilderLeg): BuilderLeg[] {
  const byVault = new Map(board.map((m) => [m.vault.toLowerCase(), m]));
  return saved.flatMap((s) => { const m = byVault.get(s.vault.toLowerCase()); return m ? [legFor(m, s.isYes)] : []; });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run lib/slip-storage.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/lib/slip-storage.ts web/lib/slip-storage.test.ts
```
Commit with `caveman:caveman-commit`. Shape: `feat(web): persist slip legs per deployment`.

---

### Task 3: Standing allowance and revoke

**Files:**
- Modify: `web/lib/ticket.ts` (after `tryParseStake`, and `approveUsdc` doc comment)
- Modify: `web/lib/ticket.test.ts` (append)

**Interfaces:**
- Produces: `ALLOWANCE_MULTIPLE = 25n`, `standingAllowance(premium: bigint, maxStake: bigint | null): bigint`, `revokeUsdc(args: Omit<Parameters<typeof approveUsdc>[0], "amount">): Promise<void>`.
- `approveUsdc` unchanged in signature; callers now pass the standing amount.

- [ ] **Step 1: Write the failing tests** (append to `web/lib/ticket.test.ts`)

```ts
import { ALLOWANCE_MULTIPLE, revokeUsdc, standingAllowance } from "./ticket";

test("standing allowance is 25x the house max stake, never below the premium, exact when limits are unknown", () => {
  expect(standingAllowance(1_000_000n, 8_000_000n)).toBe(8_000_000n * ALLOWANCE_MULTIPLE);
  expect(standingAllowance(300_000_000n, 8_000_000n)).toBe(300_000_000n);
  expect(standingAllowance(1_000_000n, null)).toBe(1_000_000n);
  expect(standingAllowance(1_000_000n, 0n)).toBe(1_000_000n);
});

test("revokeUsdc approves zero for the vault", async () => {
  const { client, write } = setup();
  await revokeUsdc({ client: client as never, write: write as never, usdc: vault, taker, current: () => true });
  expect(write.mock.calls[0][0]).toMatchObject({ functionName: "approve", args: [PARLAY_VAULT, 0n] });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run lib/ticket.test.ts`
Expected: FAIL, `standingAllowance` is not exported.

- [ ] **Step 3: Implement** (add after `tryParseStake` in `web/lib/ticket.ts`)

```ts
/** One approval per wallet, not one per ticket: the first mint approves a standing allowance
 * so later mints are a single wallet prompt. Capped at a multiple of the house max stake;
 * mainnet can lower the multiple. Exact premium when /limits is unavailable. */
export const ALLOWANCE_MULTIPLE = 25n;
export function standingAllowance(premium: bigint, maxStake: bigint | null): bigint {
  const standing = maxStake === null ? 0n : maxStake * ALLOWANCE_MULTIPLE;
  return standing > premium ? standing : premium;
}

export async function revokeUsdc(args: Omit<Parameters<typeof approveUsdc>[0], "amount">): Promise<void> {
  await approveUsdc({ ...args, amount: 0n });
}
```

Update the `approveUsdc` doc comment from "Step one of the two-tx flow: exact-amount USDC approval for the vault." to "USDC approval for the vault. Callers pass `standingAllowance(...)` for the first ticket and `0n` to revoke; `mintTicket` passes the exact premium as a fallback."

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run lib/ticket.test.ts`
Expected: PASS, including the three pre-existing mint tests (they still use the exact-premium fallback path inside `mintTicket`).

- [ ] **Step 5: Commit**

```bash
git add web/lib/ticket.ts web/lib/ticket.test.ts
```
Commit with `caveman:caveman-commit`. Shape: `feat(web): standing usdc allowance and revoke`.

---

### Task 4: Slip summary helpers

**Files:**
- Create: `web/lib/slip-summary.ts`
- Create: `web/lib/slip-summary.test.ts`

**Interfaces:**
- Produces: `STAKE_CHIPS = [5, 10, 25, 50, 100] as const`, `chipState(usdc: number, maxStake: bigint | null, balance: bigint | undefined): { enabled: boolean; title?: string }`, `barSummary(input: { legs: number; multiplier: number | null; stakeUsdc: bigint | null; maxPayout: bigint | null }): { primary: string; secondary: string; right: string | null }`.
- Consumes: `formatUsdc`, `USDC_DECIMALS` from `web/lib/format.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// web/lib/slip-summary.test.ts
import { expect, test } from "vitest";
import { barSummary, chipState, STAKE_CHIPS } from "./slip-summary";

test("chips above the house max or the balance are disabled with the reason in the title", () => {
  expect(STAKE_CHIPS).toEqual([5, 10, 25, 50, 100]);
  expect(chipState(5, 8_000_000n, 1_000_000_000n)).toEqual({ enabled: true });
  expect(chipState(10, 8_000_000n, 1_000_000_000n)).toEqual({ enabled: false, title: "House limit 8.00 USDC per ticket" });
  expect(chipState(25, 100_000_000n, 20_000_000n)).toEqual({ enabled: false, title: "Balance 20.00 USDC" });
  expect(chipState(100, null, undefined)).toEqual({ enabled: true });
});

test("bar summary reads legs, multiplier, stake and to-win", () => {
  expect(barSummary({ legs: 1, multiplier: null, stakeUsdc: null, maxPayout: null }))
    .toEqual({ primary: "1 leg · —", secondary: "add 1 more leg", right: null });
  expect(barSummary({ legs: 3, multiplier: 4.123, stakeUsdc: 25_000_000n, maxPayout: 103_000_000n }))
    .toEqual({ primary: "3 legs · 4.12x", secondary: "$25.00 stake", right: "→ $103.00" });
  expect(barSummary({ legs: 2, multiplier: 2.5, stakeUsdc: null, maxPayout: null }))
    .toEqual({ primary: "2 legs · 2.50x", secondary: "enter a stake", right: null });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run lib/slip-summary.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// web/lib/slip-summary.ts
import { formatUsdc, USDC_DECIMALS } from "./format";

export const STAKE_CHIPS = [5, 10, 25, 50, 100] as const;
const MIN_LEGS = 2;

export function chipState(usdc: number, maxStake: bigint | null, balance: bigint | undefined): { enabled: boolean; title?: string } {
  const base = BigInt(usdc) * 10n ** BigInt(USDC_DECIMALS);
  if (maxStake !== null && base > maxStake) return { enabled: false, title: `House limit ${formatUsdc(maxStake)} USDC per ticket` };
  if (balance !== undefined && base > balance) return { enabled: false, title: `Balance ${formatUsdc(balance)} USDC` };
  return { enabled: true };
}

/** Text for the collapsed sheet bar. `right` is the to-win figure once a quote exists. */
export function barSummary({ legs, multiplier, stakeUsdc, maxPayout }: { legs: number; multiplier: number | null; stakeUsdc: bigint | null; maxPayout: bigint | null }) {
  const primary = `${legs} ${legs === 1 ? "leg" : "legs"} · ${multiplier === null ? "—" : `${multiplier.toFixed(2)}x`}`;
  const secondary = legs < MIN_LEGS ? `add ${MIN_LEGS - legs} more leg${MIN_LEGS - legs === 1 ? "" : "s"}` : stakeUsdc === null ? "enter a stake" : `$${formatUsdc(stakeUsdc)} stake`;
  const right = maxPayout === null ? null : `→ $${formatUsdc(maxPayout)}`;
  return { primary, secondary, right };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run lib/slip-summary.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add web/lib/slip-summary.ts web/lib/slip-summary.test.ts
```
Commit with `caveman:caveman-commit`. Shape: `feat(web): slip bar and stake chip helpers`.

---

### Task 5: Header: funds chip, wallet menu, slots

**Files:**
- Create: `web/app/funds-chip.tsx`
- Create: `web/app/wallet-menu.tsx`
- Create: `web/lib/media.ts`
- Modify: `web/app/site-header.tsx`
- Modify: `web/app/app-header.tsx`

**Interfaces:**
- Consumes: `useUsdc`, `useWalletState`, `useConnectAction`, `useDisconnectAction` (`web/lib/wallet.ts`); `BRIDGED`, `HL_DRIP`, `appChain` (`web/lib/chain.ts`); `BridgeStep` (`web/app/(trading)/build/bridge-step.tsx`); `OddsFormatToggle` (Task 1); `revokeUsdc` (Task 3).
- Produces: `FundsChip()`, `WalletMenu()`, `useIsDesktop(): boolean`, `SiteHeader` gains optional props `mobileAction?: ReactNode` and `menu?: ReactNode`.

- [ ] **Step 1: Media hook**

```ts
// web/lib/media.ts
"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(min-width: 1024px)"; // Tailwind `lg`

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** True at Tailwind `lg` and up. Server and first client render say false, so the phone layout
 * is the hydration baseline and the desktop rail mounts right after. */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false);
}
```

- [ ] **Step 2: Funds chip**

```tsx
// web/app/funds-chip.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { BRIDGED, HL_DRIP } from "@/lib/chain";
import { formatUsdc } from "@/lib/format";
import { useConnectAction, useUsdc, useWalletState } from "@/lib/wallet";
import { BridgeStep } from "@/app/(trading)/build/bridge-step";

/** Balance plus Deposit. Deposit is the faucet on 998 and the bridge on a bridged lane. */
export function FundsChip() {
  const { ready, isConnected, address } = useWalletState();
  const connect = useConnectAction();
  const { balance } = useUsdc();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  if (!ready) return <div className="h-9 w-32 animate-pulse rounded-full bg-panel motion-reduce:animate-none" aria-hidden />;
  if (!isConnected || !address) {
    return (
      <button type="button" onClick={() => connect()} className="rounded-full bg-accent px-4 py-2 text-[13px] font-medium text-on-accent transition-transform active:scale-[0.98] motion-reduce:transition-none">
        Connect wallet
      </button>
    );
  }
  const deposit = "rounded-full bg-accent px-3 py-1 text-[11px] font-semibold text-on-accent transition-transform active:scale-[0.98] motion-reduce:transition-none";
  return (
    <div className="mono flex items-center gap-2 rounded-full border border-line py-1 pl-3 pr-1 text-[12px] text-fg">
      <span aria-label="USDC balance">${balance === undefined ? "–" : formatUsdc(balance)}</span>
      {BRIDGED ? (
        <button type="button" onClick={() => setOpen(true)} className={deposit}>Deposit</button>
      ) : (
        <a href={HL_DRIP} target="_blank" rel="noreferrer" className={deposit}>Deposit</a>
      )}
      {BRIDGED && (
        <dialog ref={ref} onClose={() => setOpen(false)} onClick={(e) => e.target === e.currentTarget && setOpen(false)}
          className="m-auto w-[min(100%-2rem,420px)] rounded-card border border-line bg-panel p-4 text-fg backdrop:bg-ink/80">
          <BridgeStep address={address} needUsdc={0n} needGas={false} />
          <button type="button" onClick={() => setOpen(false)} className="mono mt-3 w-full py-1 text-[11px] text-dim hover:text-fg">Close</button>
        </dialog>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wallet menu rows** (what the old wallet popover held, as menu rows)

```tsx
// web/app/wallet-menu.tsx
"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { appChain, explorerAddress } from "@/lib/chain";
import { shortAddress, shortError } from "@/lib/format";
import { revokeUsdc } from "@/lib/ticket";
import { useDisconnectAction, useUsdc, useWalletState } from "@/lib/wallet";
import { OddsFormatToggle } from "./odds-format-toggle";

const row = "flex w-full items-center justify-between gap-4 py-2 text-left text-[12px] normal-case tracking-normal";

/** Hamburger rows under the nav links: odds format, wallet facts, chain, allowance, disconnect. */
export function WalletMenu() {
  const { address, isConnected } = useWalletState();
  const { chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const disconnect = useDisconnectAction();
  const { address: usdc } = useUsdc();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [revoking, setRevoking] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const wrongChain = chainId !== undefined && chainId !== appChain.id;
  const explorer = address ? explorerAddress(address) : null;

  async function revoke() {
    if (!client || !usdc || !address) return;
    setRevoking("pending");
    try { await revokeUsdc({ client, write: writeContractAsync, usdc, taker: address, current: () => true }); setRevoking("done"); }
    catch (err) { setError(shortError(err)); setRevoking("error"); }
  }

  return (
    <div className="flex flex-col border-t border-line pt-2">
      <div className={row}><span className="text-dim">Odds format</span><OddsFormatToggle /></div>
      {isConnected && address && (
        <>
          <div className={row}><span className="text-dim">Wallet</span>
            {explorer ? <a href={explorer} target="_blank" rel="noreferrer" className="mono text-fg">{shortAddress(address)} ↗</a> : <span className="mono">{shortAddress(address)}</span>}
          </div>
          <div className={row}><span className="text-dim">Network</span><span className={`mono ${wrongChain ? "text-no" : ""}`}>{wrongChain ? `chain ${chainId}` : appChain.name}</span></div>
          {wrongChain && <button type="button" onClick={() => switchChain({ chainId: appChain.id })} className={`${row} text-accent`}>Switch to {appChain.name}</button>}
          <button type="button" disabled={revoking === "pending"} onClick={() => void revoke()} className={`${row} text-dim hover:text-fg`}>
            <span>Revoke USDC allowance</span><span className="mono text-[11px]">{revoking === "pending" ? "Confirm in wallet…" : revoking === "done" ? "Revoked" : ""}</span>
          </button>
          {revoking === "error" && <p className="mono text-[11px] text-no">{error}</p>}
          <button type="button" onClick={() => disconnect()} className={`${row} text-no`}>Disconnect</button>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Header slots** (`web/app/site-header.tsx`)

Add props `mobileAction?: ReactNode` and `menu?: ReactNode` to `SiteHeader`. In the `lg:hidden` block replace `{action}` with `{mobileAction ?? action}`. Inside the mobile `<nav aria-label="Mobile navigation">`, after the links `map`, render `{menu}`. Everything else stays.

```tsx
export function SiteHeader({ links, action, mobileAction, menu, home = "/" }: {
  links: { href: string; label: string; activePaths?: string[]; scrollTo?: string; icon?: string }[];
  action: ReactNode;
  /** Phone header slot; falls back to `action`. */
  mobileAction?: ReactNode;
  /** Rows under the links in the hamburger. */
  menu?: ReactNode;
  home?: string;
}) {
```
and
```tsx
        <div className="ml-auto flex items-center gap-3 lg:hidden">
          {mobileAction ?? action}
          <button …>
```
and at the end of the mobile nav:
```tsx
          })}
          {menu}
        </nav>
```

- [ ] **Step 5: Wire the app header** (`web/app/app-header.tsx`)

```tsx
"use client";

import { altLane, appHref, websiteHref } from "@/lib/site";
import { SiteHeader } from "./site-header";
import { WalletButton } from "./wallet-button";
import { FundsChip } from "./funds-chip";
import { WalletMenu } from "./wallet-menu";

export function AppHeader() {
  return <SiteHeader
    home={appHref()}
    links={[
      { href: appHref(), label: "Trade", activePaths: ["/", "/build"] },
      { href: appHref("/positions"), label: "Positions", activePaths: ["/positions"] },
      { href: appHref("/pricing"), label: "Pricing", activePaths: ["/pricing"] },
      { href: websiteHref, label: "Website" },
      ...(altLane ? [{ href: altLane.href, label: `${altLane.label} ↗`, icon: altLane.icon }] : []),
    ]}
    action={<span className="flex items-center gap-3"><FundsChip /><WalletButton /></span>}
    mobileAction={<FundsChip />}
    menu={<WalletMenu />}
  />;
}
```

After Disconnect the hamburger stays open and the wallet rows disappear (they are gated on `isConnected`); the links and the odds row remain. That is fine: the user is still in the menu they opened.

- [ ] **Step 6: Typecheck and build**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: no type errors; build passes. The landing page must not import `FundsChip` or `WalletMenu` (they pull wagmi); only `AppHeader` does. `npm run check` later enforces it.

- [ ] **Step 7: Manual check**

Run: `cd web && npm run dev`, open `http://localhost:3000/build` at 390 px wide. Expected: header shows logo, `$… · Deposit` chip (or Connect wallet), hamburger. Open the hamburger: links, Odds format toggle, wallet rows. At 1280 px: inline nav, funds chip, wallet popover. Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add web/app/funds-chip.tsx web/app/wallet-menu.tsx web/lib/media.ts web/app/site-header.tsx web/app/app-header.tsx
```
Commit with `caveman:caveman-commit`. Shape: `feat(web): funds chip and hamburger wallet menu`.

---

### Task 6: Ticket: lifted hook, dollar stakes, single CTA

**Files:**
- Modify: `web/app/(trading)/build/use-ticket.ts`
- Modify: `web/app/(trading)/build/ticket.tsx`

**Interfaces:**
- `useTicket(legs: BuilderLeg[])` (the `display` parameter is removed). Returns the same object plus `toWin: bigint | null` (= `maxPayout` of the current ok quote) and `multiplier: number | null` (= `multiplierNum(premium, maxPayout)` or null), and `stakeBase: bigint | null`.
- `Cta` `"pay"` variant becomes `{ kind: "pay"; needsApproval: boolean; label: string; enabled: boolean; step: "approve" | "mint" }`.
- `Ticket({ legs, onRemove, ticket }: { legs: BuilderLeg[]; onRemove: (vault) => void; ticket: ReturnType<typeof useTicket> })`.
- Consumes: `STAKE_CHIPS`, `chipState` (Task 4); `standingAllowance` (Task 3); `formatOdds`, `useOddsFormat` (Task 1).

- [ ] **Step 1: `use-ticket.ts` edits**

1. Signature: `export function useTicket(legs: BuilderLeg[])`. Delete every `display` reference: the `select` key tuple drops `display`; the `enabled: !display && …` queries become `enabled: !!address` / `enabled: !!usdcAddr && !!address`; the limits effect, `runQuote` guard, debounce effect and TTL effect drop their `display` checks; `const cta = computeCta();`.
2. `approve()` passes the standing amount:
```ts
      await approveUsdc({ client: publicClient, write: writeContractAsync, usdc: usdcAddr, taker: address,
        amount: standingAllowance(stakeBase, maxStake), current: () => session.revision === revision });
```
   Import `standingAllowance` from `@/lib/ticket`.
3. Replace the `Cta` `"pay"` variant and the tail of `computeCta()`:
```ts
  | { kind: "pay"; step: "approve" | "mint"; label: string; enabled: boolean; needsApproval: boolean };
```
```ts
    if (mintState === "done") return { kind: "done", label: "Minted · view positions", href: "/positions" };
    const minting = session.minting || mintState === "pending";
    if (needsApproval) {
      return { kind: "pay", step: "approve", needsApproval: true, enabled: !approving && !minting,
        label: approving ? "Confirm in wallet…" : "Approve USDC once" };
    }
    const waiting =
      minting ? "Confirm in wallet…"
      : quoting ? "Quoting…"
      : !quoteResult ? "Waiting for quote…"
      : !quoteResult.ok ? "Unable to quote"
      : secondsLeft(BigInt(quoteResult.quote.deadline), Date.now()) <= 0 ? "Refreshing quote…"
      : null;
    if (waiting || !quoteResult?.ok) return { kind: "pay", step: "mint", needsApproval: false, enabled: false, label: waiting ?? "Waiting for quote…" };
    return { kind: "pay", step: "mint", needsApproval: false, enabled: true, label: `Mint ticket · $${formatUsdc(BigInt(quoteResult.quote.premium))}` };
```
4. Add to the return object: `stakeBase`, `toWin: quoteResult?.ok ? BigInt(quoteResult.quote.maxPayout) : null`, `multiplier: quoteResult?.ok ? multiplierNum(BigInt(quoteResult.quote.premium), BigInt(quoteResult.quote.maxPayout)) : null` (import `multiplierNum` from `@/lib/format`).
5. `MIN_LEGS` message stays `"Add 2 legs to price a ticket"` when `legs.length === 0`; when exactly one leg: `"Add 1 more leg to price a ticket"`:
```ts
    if (legs.length < MIN_LEGS) return { kind: "disabled", label: legs.length === 1 ? "Add 1 more leg to price a ticket" : "Add 2 legs to price a ticket" };
```

- [ ] **Step 2: `ticket.tsx` edits**

1. Props: `export function Ticket({ legs, onRemove, ticket }: { legs: BuilderLeg[]; onRemove: (vault: `0x${string}`) => void; ticket: ReturnType<typeof useTicket> })` and `const { stake, setStake, quoteResult, ttlLeft, ttlSeconds, mintState, mintErrorMsg, mintErrorDetail, maxStake, limits, usdcBalance, cta, approve, mintQuoted, retry, connect, switchChain, address, minted, dismissMinted, stakeBase, toWin } = ticket;`. Import `type { useTicket }` only for the type (`import type { useTicket } from "./use-ticket"`).
2. Delete the `display` branches entirely: the `display ? … : …` sample math (`sampleProbs`, `combinedImplied`, `sampleMultiplier`, `samplePayout`), the display stake block, the display TTL bar, the display CTA, and the `!display &&` guards. Delete `STAKE_PRESETS` and `presets`.
3. Leg row price: replace `midPct(mids, leg.coin)` with `formatOdds(marketMid(mids, {}, leg.coin), format)` where `const format = useOddsFormat();`. Delete `midPct`.
4. Stake block (replaces the `Stake (USDC)` label, input, preset row):
```tsx
          <div className="mt-4">
            <div className="grid grid-cols-2 items-end gap-3">
              <div>
                <label htmlFor="stake" className="mono text-[10px] uppercase tracking-[0.16em] text-dim">Stake</label>
                <div className="mt-1 flex items-baseline gap-1 rounded-card border border-line bg-ink px-3 py-2 focus-within:border-accent">
                  <span className="mono text-dim">$</span>
                  <input id="stake" inputMode="decimal" autoComplete="off" value={stake} onChange={(e) => setStake(e.target.value)} placeholder="0.00"
                    className="mono w-full bg-transparent text-[20px] leading-none text-fg outline-none placeholder:text-dim" />
                </div>
              </div>
              <div className="text-right">
                <span className="mono text-[10px] uppercase tracking-[0.16em] text-dim">To win</span>
                <div className={`mono mt-1 text-[22px] leading-none ${toWin === null ? "text-dim" : "text-accent"}`}>
                  {toWin === null ? (lastWin.current === null ? "—" : `$${formatUsdc(lastWin.current)}`) : <CountUp value={Number(formatUnits(toWin, USDC_DECIMALS))} format={(x) => `$${usdc2(x)}`} />}
                </div>
              </div>
            </div>
            <div className="mt-2 flex gap-1.5">
              {STAKE_CHIPS.map((v) => {
                const s = chipState(v, maxStake, usdcBalance);
                return (
                  <button key={v} type="button" disabled={!s.enabled} title={s.title} aria-pressed={stake === String(v)} onClick={() => setStake(String(v))}
                    className="mono flex-1 rounded-[6px] border border-line py-1.5 text-[11px] text-dim transition-colors hover:border-dim hover:text-fg aria-pressed:border-accent aria-pressed:text-accent disabled:cursor-not-allowed disabled:opacity-40">
                    ${v}
                  </button>
                );
              })}
              <button type="button" disabled={maxAllowed === null || maxAllowed === 0n} onClick={() => maxAllowed !== null && setStake(formatUnits(maxAllowed, USDC_DECIMALS))}
                className="mono flex-1 rounded-[6px] border border-line py-1.5 text-[11px] text-dim transition-colors hover:border-dim hover:text-fg disabled:cursor-not-allowed disabled:opacity-40">
                Max
              </button>
            </div>
            <div className="mono mt-2 flex items-center justify-between text-[11px] text-dim">
              <span>{quoteResult?.ok ? `Ticket ${mult(multiplierNum(premium, maxPayout))} · ${legs.length} legs` : `Balance $${usdcBalance === undefined ? "–" : formatUsdc(usdcBalance)}`}</span>
              {quoteResult?.ok && <span>Quote locked {ttlLeft}s</span>}
            </div>
          </div>
```
   Add near the top of the component: `const lastWin = useRef<bigint | null>(null); if (toWin !== null) lastWin.current = toWin;` (import `useRef` from react). This keeps the last to-win dimmed while a requote is in flight, so the number does not jump to a dash.
   Keep `HouseLimits` but move it inside the `Quote details` disclosure (below `MathBreakdown`).
5. Quote block: drop the `Stake` / `Combined implied` / `Fair` / `Quoted` / `Max payout` rows (the stake block above now carries stake and to-win). Keep the TTL bar (`h-[3px]`) directly under the stake block, and change the `<details open …>` to `<details …>` (collapsed by default) with summary text `Quote details`. Inside, keep `MathBreakdown`, then `HouseLimits`, then the Profit / Break-even / Max loss rows. Delete the sentence comment about "open by default".
6. CTA: replace the `cta.kind === "pay"` two-button block with one button:
```tsx
          {cta.kind === "pay" && (
            <div className="mt-4 flex flex-col gap-2">
              {cta.needsApproval && (
                <p className="rounded-[6px] border border-accent/30 bg-accent/10 px-3 py-2 text-[12px] text-fg">
                  First ticket on this wallet: approve USDC once, then every ticket is a single wallet prompt.
                </p>
              )}
              <button type="button" disabled={!cta.enabled}
                onClick={() => cta.step === "approve" ? void approve() : quoteResult?.ok && mintQuoted(quoteResult.quote, quoteResult.sig)}
                className={payButtonClass(cta.enabled, false)}>
                {cta.label}
              </button>
            </div>
          )}
```
   `payButtonClass` keeps its signature; change its `text-[12px] uppercase tracking-[0.1em]` to `text-[14px] font-semibold normal-case tracking-normal py-[14px]` so the single CTA reads as the sportsbook button in the mock.
7. The `connect`, `switch-chain`, `external`, `done`, `bridge`, `disabled` branches stay as they are.
8. Empty state text: `No legs yet - pick a side from the market list.` → `Tap any price to start a slip.`

- [ ] **Step 3: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: errors only in `page.tsx` (`Ticket` now requires `ticket`; `useTicket` signature). Task 7 fixes them. If other files error, fix them here.

- [ ] **Step 4: Commit**

```bash
git add "web/app/(trading)/build/use-ticket.ts" "web/app/(trading)/build/ticket.tsx"
```
Commit with `caveman:caveman-commit`. Shape: `feat(web): dollar stakes, to-win, one-prompt mint cta`.

---

### Task 7: Board cards, odds toggle, lifted hook, persistence, sheet vs rail

**Files:**
- Create: `web/app/(trading)/build/slip-sheet.tsx`
- Modify: `web/app/(trading)/build/page.tsx`
- Modify: `web/app/globals.css`

**Interfaces:**
- `SlipSheet({ legs, ticket, children }: { legs: BuilderLeg[]; ticket: ReturnType<typeof useTicket>; children: ReactNode })` renders the fixed bottom sheet on the phone; `children` is the `<Ticket …/>`.
- Consumes: `barSummary` (Task 4), `useIsDesktop` (Task 5), `loadSlip`/`saveSlip`/`restoreLegs` (Task 2), `OddsFormatToggle`, `formatOdds`, `useOddsFormat` (Task 1).

- [ ] **Step 1: CSS** (append to `web/app/globals.css` before the reduced-motion block for the minted slip)

```css
/* Phone slip sheet: slides up from the bottom; the collapsed bar is always there once a leg exists. */
@keyframes sheet-up { from { transform: translateY(24px); opacity: 0; } to { transform: none; opacity: 1; } }
.sheet { animation: sheet-up .25s cubic-bezier(.2,.8,.2,1) both; padding-bottom: env(safe-area-inset-bottom, 0px); }
@keyframes badge-pulse { 0% { transform: scale(1); } 40% { transform: scale(1.25); } 100% { transform: scale(1); } }
.badge-pulse { animation: badge-pulse .15s ease-out; }
@media (prefers-reduced-motion: reduce) { .sheet, .badge-pulse { animation: none; } }
```

- [ ] **Step 2: Slip sheet component**

```tsx
// web/app/(trading)/build/slip-sheet.tsx
"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { barSummary } from "@/lib/slip-summary";
import type { BuilderLeg } from "@/lib/ticket";
import type { useTicket } from "./use-ticket";

const DRAG_PX = 40;

/** Phone-only bottom sheet around the Ticket. Collapsed: one bar with legs, multiplier, stake and
 * to-win. Expanded: the whole ticket, scrolling inside the sheet. Collapses on backdrop tap,
 * Escape, a downward drag of the handle, and after a successful mint. */
export function SlipSheet({ legs, ticket, children }: { legs: BuilderLeg[]; ticket: ReturnType<typeof useTicket>; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const dragStart = useRef<number | null>(null);
  const summary = barSummary({ legs: legs.length, multiplier: ticket.multiplier, stakeUsdc: ticket.stakeBase, maxPayout: ticket.toWin });

  useEffect(() => { if (ticket.mintState === "done") setOpen(false); }, [ticket.mintState]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Badge pulse on every leg count change.
  const [pulse, setPulse] = useState(0);
  const prevCount = useRef(legs.length);
  useEffect(() => { if (legs.length !== prevCount.current) { prevCount.current = legs.length; setPulse((n) => n + 1); } }, [legs.length]);

  if (legs.length === 0 && !open) return null;

  return (
    <>
      {open && <button type="button" aria-label="Collapse slip" onClick={() => setOpen(false)} className="fixed inset-0 z-20 bg-ink/60 lg:hidden" />}
      <section aria-label="Your slip" className="sheet fixed inset-x-0 bottom-0 z-30 flex max-h-[85svh] flex-col rounded-t-[18px] border border-b-0 border-line bg-raised shadow-[0_-20px_60px_rgba(4,10,12,0.6)] lg:hidden">
        <div
          className="flex justify-center py-2 touch-none"
          onPointerDown={(e) => { dragStart.current = e.clientY; }}
          onPointerUp={(e) => {
            if (dragStart.current === null) return;
            const dy = e.clientY - dragStart.current;
            dragStart.current = null;
            if (dy > DRAG_PX) setOpen(false); else if (dy < -DRAG_PX) setOpen(true);
          }}
        >
          <span className="h-1 w-10 rounded-full bg-line" aria-hidden />
        </div>
        {open ? (
          <div className="min-h-0 overflow-y-auto px-4 pb-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="mono text-[10px] uppercase tracking-[0.16em] text-dim">Your slip <span key={pulse} className="badge-pulse ml-1 inline-grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] text-on-accent">{legs.length}</span></span>
              <button type="button" onClick={() => setOpen(false)} aria-label="Collapse slip" className="text-dim">⌄</button>
            </div>
            {children}
          </div>
        ) : (
          <button type="button" aria-expanded={false} onClick={() => setOpen(true)} className="flex w-full items-center justify-between gap-3 px-4 pb-4 pt-1 text-left">
            <span className="flex flex-col">
              <span className="mono text-[14px] text-fg">{summary.primary} <span key={pulse} className="badge-pulse ml-1 inline-grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] text-on-accent">{legs.length}</span></span>
              <span className="text-[11px] text-dim">{summary.secondary}</span>
            </span>
            <span className="mono text-[15px] font-semibold text-accent">{summary.right ?? "⌃"}</span>
          </button>
        )}
      </section>
    </>
  );
}
```

Note: when `open` is true the `children` must stay mounted so `Ticket`'s inputs keep focus; when collapsed the `Ticket` unmounts but `useTicket` lives in the page, so the quote, stake and mint state survive.

- [ ] **Step 3: `page.tsx` edits**

1. Imports: remove `oddsLabel, pct1`; add `formatOdds, useOddsFormat` from `@/lib/odds-format`, `OddsFormatToggle` from `@/app/odds-format-toggle`, `useIsDesktop` from `@/lib/media`, `loadSlip, restoreLegs, saveSlip` from `@/lib/slip-storage`, `useTicket` from `./use-ticket`, `SlipSheet` from `./slip-sheet`. Remove `type View`, `ViewToggle`, and the `view` state.
2. `PriceCell`: drop `chip`; always a stacked card button. Replace the body:
```tsx
function PriceCell({ mid, side, tone, selected, label, onPick }: { mid: number | null; side: string; tone: "yes" | "no"; selected: boolean; label: string; onPick: () => void }) {
  const format = useOddsFormat();
  return (
    <button type="button" onClick={onPick} disabled={mid === null} aria-pressed={selected} aria-label={label}
      className={`flex min-w-0 flex-col items-center gap-0.5 rounded-[8px] border px-2 py-2 transition-[transform,background-color,border-color] active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none ${
        selected ? "border-accent bg-accent" : "border-line bg-panel hover:border-dim"}`}>
      <span title={side} className={`w-full truncate text-center text-[11px] ${selected ? "text-on-accent/70" : "text-dim"}`}>{side}</span>
      <span className={`mono text-[14px] font-medium ${selected ? "text-on-accent" : tone === "yes" ? "text-yes" : "text-no"}`}>{formatOdds(mid, format)}</span>
    </button>
  );
}
```
   The aria-label text passed by callers keeps `pct1(mid)`; change those to `formatOdds(mid, "probability")` so screen readers always hear a probability (import stays via `formatOdds`).
3. `BoardRow`: delete the `card` prop and the non-card branch; keep the card branch as the only return, with `<div className="grid gap-2 pt-3" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>{cells}</div>` (two columns). `GroupRow`: delete `card`; keep the card markup; outcomes grid becomes `grid-cols-3` for three members and `grid-cols-2` otherwise: ``className={`mt-auto grid gap-2 pt-3 ${priced.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}``. `PriceCell` calls drop `chip`.
4. Lift the hook and persistence into `BuildPage`:
```tsx
  const ticket = useTicket(legs);
  const isDesktop = useIsDesktop();
  // Persist legs; restore once the board is known so a stale vault never renders.
  const restored = useRef(false);
  useEffect(() => { if (restored.current) saveSlip(legs); }, [legs]);
```
   and in `load()` after `setMarkets(board)`:
```tsx
      if (!restored.current) {
        restored.current = true;
        const saved = restoreLegs(loadSlip(), board, legFor);
        if (saved.length) setLegs((prev) => (prev.length ? prev : saved));
      }
```
   Keep the `?leg=` block after it (it still adds on top).
5. Filters row: replace the `h1 + ViewToggle` block and the tabs block with:
```tsx
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="display text-[32px] [font-variation-settings:'wght'_700] tracking-[-0.03em]">Build a slip</h1>
            <button type="button" onClick={() => setSoonestFirst((v) => !v)} aria-label={`Sort by kickoff, ${soonestFirst ? "soonest" : "latest"} first`}
              className="mono text-[10px] uppercase tracking-[0.16em] text-dim transition-colors hover:text-fg">Kickoff {soonestFirst ? "↑" : "↓"}</button>
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
            <div className="mono flex flex-wrap gap-1 text-[10px] uppercase tracking-[0.16em]">
              {tabs.length > 2 && tabs.map((t) => ( …existing tab button… ))}
            </div>
            <OddsFormatToggle className="hidden lg:inline-flex" />
          </div>
```
6. Board rendering: delete the `view === "grid" ? … : …` branch and the list header; always render the card grid:
```tsx
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {groupMarkets(board).map((entry) =>
                  entry.kind === "market"
                    ? <BoardRow key={entry.market.vault} market={entry.market} mids={mids} legs={legs} onPick={addLeg} />
                    : <GroupRow key={entry.group} title={entry.title} members={entry.members} mids={mids} legs={legs} onPick={addLeg} />,
                )}
              </div>
```
7. Slip placement: replace the `<aside …>` and the mobile bar with:
```tsx
        {isDesktop ? (
          <aside ref={slipRef} id="slip" className="scroll-mt-20 lg:sticky lg:top-24 lg:self-start lg:pl-8">
            <Ticket legs={legs} onRemove={removeLeg} ticket={ticket} />
          </aside>
        ) : (
          <SlipSheet legs={legs} ticket={ticket}>
            <Ticket legs={legs} onRemove={removeLeg} ticket={ticket} />
          </SlipSheet>
        )}
```
   The `ResizeObserver` effect that pins the sticky slip must tolerate `slipRef.current === null` on the phone (it already returns early when `!el`; add `isDesktop` to its dependency array so it re-runs when the aside mounts).
   Delete the whole `{legs.length > 0 && (<button … View slip …/>)}` block and its comment. Add `pb-28 lg:pb-10` on `<main>` so the sheet bar never covers the last card.
8. `MintedSlipDialog` is rendered inside `Ticket`; on the phone `Ticket` unmounts when the sheet collapses after a mint, which would close the dialog. Move `<MintedSlipDialog slip={ticket.minted} onClose={ticket.dismissMinted} />` out of `Ticket` into `BuildPage` (render it once, after `</main>`), and delete it from `ticket.tsx`.

- [ ] **Step 4: Typecheck and build**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 5: Manual check on both widths**

Run: `cd web && npm run dev`. At 390 px: tap three prices, the bar appears with `3 legs · —` then the multiplier once the quote lands; tap the bar, the ticket opens with `$` input and chips; `Escape` and backdrop collapse it; reload, the three legs come back. At 1280 px: odds toggle at the right of the sport tabs, the rail unchanged in placement, switching the toggle changes every price on the board and in the slip. Stop the dev server.

- [ ] **Step 6: Run the whole check**

Run: `npm run check --prefix web`
Expected: green, including the landing bundle gate.

- [ ] **Step 7: Commit**

```bash
git add "web/app/(trading)/build/slip-sheet.tsx" "web/app/(trading)/build/page.tsx" "web/app/(trading)/build/ticket.tsx" web/app/globals.css
```
Commit with `caveman:caveman-commit`. Shape: `feat(web): event cards, slip sheet, odds toggle, persisted legs`.

---

### Task 8: Minted slip polish

**Files:**
- Modify: `web/app/(trading)/build/minted-slip.tsx`
- Modify: `web/app/globals.css`

- [ ] **Step 1: Copy and layout**

1. Under the `<h2>` add a subtitle:
```tsx
          <p className="mono mt-2 text-[11px] text-dim">{slip.id ? `Ticket #${slip.id} · ` : ""}settles after the last leg · payout escrowed on-chain</p>
```
2. Button labels: `Share on X` stays; `Copy image` stays; `View positions` stays; `Back to the board` → `Done`.
3. Dialog placement on the phone: change the `<dialog>` className to `minted-dialog mt-auto mb-0 w-[min(100%,420px)] sm:m-auto sm:w-[min(100%-2rem,400px)] …` so it sits at the bottom on small screens and centres from `sm`.

- [ ] **Step 2: CSS**

In `globals.css`, change `slip-print` so it enters from below on small screens:
```css
@keyframes slip-print { from { opacity: 0; transform: translateY(40px) scale(.97); } to { opacity: 1; transform: none; } }
@media (min-width: 640px) { @keyframes slip-print { from { opacity: 0; transform: translateY(-40px) scale(.97); clip-path: inset(0 0 100% 0); } to { opacity: 1; transform: none; clip-path: inset(0); } } }
```
(Keyframes inside a media query override the global ones in that range. The reduced-motion override already sets `animation: none`.)

- [ ] **Step 3: Build and eyeball**

Run: `cd web && npm run build`; then in dev at 390 px mint cannot be reached without a wallet, so temporarily render `<MintedSlipDialog slip={{ legs: [...two legs...], premium: 25_000_000n, maxPayout: 103_000_000n, hash: "0x…", id: "318" }} onClose={() => {}} />` from `BuildPage` to see it, then revert that line before committing. Expected: dark panel, lime `Minted` stamp, slides up from the bottom.

- [ ] **Step 4: Commit**

```bash
git add "web/app/(trading)/build/minted-slip.tsx" web/app/globals.css
```
Commit with `caveman:caveman-commit`. Shape: `feat(web): minted slip subtitle and phone slide-up`.

---

### Task 9: Odds format on the landing ticker

**Files:**
- Modify: `web/app/live-markets.tsx:76-104` (`OddsCell`)

- [ ] **Step 1: Replace `oddsLabel(mid)` in `OddsCell` with `formatOdds(mid, format)`** where `const format = useOddsFormat();` is called inside `OddsCell` (it is a client component; confirm the file starts with `"use client"`; if `OddsCell` is server-rendered, leave it on `oddsLabel` and note it in the commit body). Keep the secondary `pct1` line there: the landing is a teaser, not the board.

- [ ] **Step 2: Bundle gate**

Run: `npm run check --prefix web`
Expected: green. `odds-format.ts` imports only React, so the landing bundle stays free of wallet code.

- [ ] **Step 3: Commit**

```bash
git add web/app/live-markets.tsx
```
Commit with `caveman:caveman-commit`. Shape: `feat(web): landing ticker follows odds format`.

---

### Task 10: Copy sweep

**Files:**
- Modify: `web/app/(trading)/build/layout.tsx`, `web/app/(trading)/build/ticket.tsx`, `web/app/(trading)/build/use-ticket.ts`, `web/app/page.tsx` (only if a string below is found there)

- [ ] **Step 1: Grep for forbidden and stale strings**

```bash
cd web && grep -rn -i -E "\bbets?\b|betting|Mint slip|View slip|No legs yet|Stake \(USDC\)" app lib --include='*.tsx' --include='*.ts' | grep -v test
```
Expected hits to fix: `Mint slip - …` (now `Mint ticket · $…`, Task 6), `View slip` (deleted, Task 7). Any `bet` hit in UI text is replaced with slip / ticket wording. Zero hits when done.

- [ ] **Step 2: Vitest and build**

Run: `npm run check --prefix web`
Expected: green.

- [ ] **Step 3: Commit** (only if anything changed)

Commit with `caveman:caveman-commit`. Shape: `fix(web): slip wording sweep`.

---

### Task 11: Preview deploy and real mints

**Files:** none in the repo. `tools/vercel-lanes.sh` is the deploy tool (read it end to end first, user rule: read scripts before recommending).

- [ ] **Step 1: Read the deploy script**

Run: `cat /Users/lovrobiljeskovic/hype-evm/tools/vercel-lanes.sh`
Confirm which flag produces a **preview** (non-prod) deploy for the 998 lane. If it only does `--prod`, use the plain CLI from `web/` with the lane's env already linked: `cd web && vercel --yes --scope lovrobiljeskovics-projects` (no `--prod`). Do not run `scripts/verify.sh`'s web build for this.

- [ ] **Step 2: Preview deploy the 998 lane** and give the user the preview URL. Ask the user to do the phone test on a real device with their test wallet: one ticket with three legs (first mint = approve once + mint), then a second ticket (single prompt), then Revoke USDC allowance from the menu. Record the ticket ids.

- [ ] **Step 3: Production**: on the user's go, deploy both lanes with `tools/vercel-lanes.sh hyperevm` then `tools/vercel-lanes.sh elysium` (confirm the exact arguments from the script). Verify each by loading the lane URL and checking the header shows the funds chip.

---

### Task 12: Vault and branch wrap-up

**Files:**
- Vault: `Roadmap/Current State.md`, `Operations/Release History.md`, `Architecture/Frontend.md`, `Gotchas.md` (only if a new gotcha surfaced)

- [ ] **Step 1: Vault notes**

In `Architecture/Frontend.md`: replace the Slate + Amber token table with the live tokens (`ink #0d0f0c`, `panel #151912`, `raised #1d2219`, `line #30362b`, `fg #f1f4eb`, `dim #9ca592`, `accent #c8f36a`, `on-accent #172006`, `yes #44d17a`, `no #ff5d6c`; fonts Bricolage Grotesque / Instrument Sans / Martian Mono), describe the new `/build` (cards, sheet, odds format, persisted slip, standing allowance), and list the new `lib/` files. In `Release History.md` add the deploy with commits and deployment ids. In `Current State.md` move the D63 line to "live" with the date. Then `bash "$HOME/Library/CloudStorage/GoogleDrive-biljeskovic.lovro@gmail.com/My Drive/Hyperflip/kb-sync.sh"`.

- [ ] **Step 2: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill: squash or merge `feat/sportsbook-slip` into `main` per the user's choice, push.

---

## Self-review notes

- Spec §1 header → Task 5. §2 board → Task 7. §3 sheet → Task 7. §4 stake → Task 6. §5 odds format → Tasks 1, 7, 9. §6 one-prompt mint → Tasks 3, 6. §7 minted slip → Task 8. §8 persistence → Tasks 2, 7. §9 copy → Tasks 6, 7, 10. Testing section → Tasks 1–4 (vitest), 7 and 11 (manual). Rollout → Task 11, with the flag deviation stated in Global Constraints.
- `Ticket` prop `ticket: ReturnType<typeof useTicket>` is used identically in Tasks 6 and 7. `barSummary` input names (`legs`, `multiplier`, `stakeUsdc`, `maxPayout`) match `useTicket`'s new `multiplier`, `stakeBase`, `toWin` returns via the mapping in `SlipSheet`.
- `display` mode removal touches `use-ticket.ts` and `ticket.tsx` only; no other caller passed `display` (checked: `page.tsx:493` is the only `<Ticket>` use).
