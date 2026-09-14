import { existsSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PurrCoinToss } from "../app/purr-coin-toss";

test("initial render provides a real still without loading video before motion preferences are known", () => {
  const html = renderToStaticMarkup(createElement(PurrCoinToss));
  const poster = html.match(/<img[^>]+src="([^"]+)"/)?.[1];
  expect(poster).toBeTruthy();
  expect(existsSync(`public${poster}`)).toBe(true);
  expect(html).not.toContain("<video");
  expect(html).not.toContain("<button");
});
