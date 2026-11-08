import { expect, test } from "vitest";
import { slipShareText, slipUrl, ticketShareText, ticketUrl, xIntentUrl } from "./share";

test("share text names the leg count and the intent carries text and link", () => {
  const text = slipShareText(3);
  expect(text).toBe("Just minted a 3-leg slip on @hyperflip_xyz");
  const url = new URL(xIntentUrl(text, "https://hyperflip.xyz"));
  expect(url.origin + url.pathname).toBe("https://x.com/intent/post");
  expect(url.searchParams.get("text")).toBe(text);
  expect(url.searchParams.get("url")).toBe("https://hyperflip.xyz");
});

test("slipUrl encodes each leg as ?leg=<vault> with :n for the NO side", () => {
  const a = `0x${"a".repeat(40)}` as const;
  const b = `0x${"b".repeat(40)}` as const;
  expect(slipUrl("https://app.hyperflip.xyz", [{ vault: a, isYes: true }, { vault: b, isYes: false }]))
    .toBe(`https://app.hyperflip.xyz/build?leg=${a}&leg=${b}%3An`);
});

test("ticketShareText per state and ticketUrl carries the state as a cache-buster", () => {
  expect(ticketShareText("open", 3)).toBe("Riding a 3-leg slip on @hyperflip_xyz");
  expect(ticketShareText("won", 3, 35_000_000n)).toBe("Hit a 3-leg slip for +35.00 USDC on @hyperflip_xyz");
  expect(ticketShareText("lost", 2)).toBe("Lost a 2-leg slip on @hyperflip_xyz");
  expect(ticketShareText("void", 4)).toBe("4-leg slip voided on @hyperflip_xyz");
  expect(ticketUrl("https://hyperflip.xyz", 7n, "won")).toBe("https://hyperflip.xyz/t/7?v=won");
});
