import { expect, test } from "vitest";
import { slipShareText, xIntentUrl } from "./share";

test("share text names the leg count and the intent carries text and link", () => {
  const text = slipShareText(3);
  expect(text).toBe("Just minted a 3-leg slip on @hyperflip_xyz");
  const url = new URL(xIntentUrl(text, "https://hyperflip.xyz"));
  expect(url.origin + url.pathname).toBe("https://x.com/intent/post");
  expect(url.searchParams.get("text")).toBe(text);
  expect(url.searchParams.get("url")).toBe("https://hyperflip.xyz");
});
