import { expect, test } from "vitest";
import { slipShareText, xIntentUrl } from "./share";

test("share text lists legs and the stake-to-payout line", () => {
  const text = slipShareText(
    [
      { vault: "0x1", isYes: true, title: "Twins vs Yankees", coin: "a", label: "Twins" },
      { vault: "0x2", isYes: false, title: "Chiefs vs Bills", coin: "b" },
    ],
    25_000_000n,
    87_400_000n,
  );
  expect(text).toBe(
    "Just minted a 2-leg slip on @hyperflip_xyz\n\n✅ Twins · Twins vs Yankees\n✅ NO · Chiefs vs Bills\n\n25.00 USDC to win 87.40 USDC (3.50x)",
  );
  const url = new URL(xIntentUrl(text, "https://hyperflip.xyz"));
  expect(url.origin + url.pathname).toBe("https://x.com/intent/post");
  expect(url.searchParams.get("text")).toBe(text);
  expect(url.searchParams.get("url")).toBe("https://hyperflip.xyz");
});
