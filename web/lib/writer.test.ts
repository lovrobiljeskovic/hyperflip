import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { requestQuote } from "./writer";

const REQ = {
  taker: "0x1111111111111111111111111111111111111111" as const,
  legs: [],
  stake: "1000000",
  inviteCode: "OVR-TEST",
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("requestQuote surfaces a hung writer as the status-0 unreachable shape after ~10s", async () => {
  // Never resolves on its own — only reacts to the AbortController's signal,
  // same as a writer that accepted the connection but never answered.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    ),
  );

  const pending = requestQuote(REQ);
  await vi.advanceTimersByTimeAsync(10_000);
  await expect(pending).resolves.toEqual({ ok: false, status: 0, error: "writer-unreachable" });
});
