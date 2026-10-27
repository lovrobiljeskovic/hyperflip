import { expect, test } from "vitest";
import { slipShareText, slipUrl, xIntentUrl } from "./share";

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
