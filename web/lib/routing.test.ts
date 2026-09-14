import { afterEach, expect, test, vi } from "vitest";
import { getRedirectUrl, getRewrittenUrl, unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import nextConfig from "../next.config";
import { appHref } from "./site";

afterEach(() => vi.unstubAllEnvs());

test("production hosts separate trading, retain legacy deep links, and leave assets alone", async () => {
  const respond = (url: string) => unstable_getResponseFromNextConfig({ url, nextConfig });
  const app = await respond("https://app.hyperflip.xyz/?leg=0x123");
  expect(getRewrittenUrl(app)).toBe("https://app.hyperflip.xyz/build?leg=0x123");
  for (const host of ["hyperflip.xyz", "www.hyperflip.xyz", "overround.xyz", "www.overround.xyz"]) {
    for (const path of ["build", "positions", "pricing"]) {
      const response = await respond(`https://${host}/${path}?leg=0x123`);
      expect(response.status).toBe(308);
      expect(getRedirectUrl(response)).toBe(`https://app.hyperflip.xyz/${path === "build" ? "" : path}?leg=0x123`);
    }
  }
  expect(getRedirectUrl(await respond("https://app.hyperflip.xyz/build?leg=0x123"))).toBe("https://app.hyperflip.xyz/?leg=0x123");
  for (const url of [
    "https://hyperflip.xyz/", "https://app.hyperflip.xyz/positions", "https://app.hyperflip.xyz/pricing",
    "https://app.hyperflip.xyz/_next/static/chunk.js", "https://app.hyperflip.xyz/icon.svg",
    "http://localhost:3000/build", "https://preview.vercel.app/build", "https://appXhyperflip.xyz/",
  ]) {
    const response = await respond(url);
    expect(getRedirectUrl(response)).toBeNull();
    expect(getRewrittenUrl(response)).toBeNull();
  }
});

test("app links stay local in development and preview, and use the app domain in production", () => {
  vi.stubEnv("NEXT_PUBLIC_APP_ORIGIN", "");
  expect(appHref()).toBe("/build");
  expect(appHref("/positions")).toBe("/positions");
  expect(appHref("/pricing")).toBe("/pricing");
  vi.stubEnv("NEXT_PUBLIC_APP_ORIGIN", "https://app.hyperflip.xyz");
  expect(appHref()).toBe("https://app.hyperflip.xyz/");
  expect(appHref("/positions")).toBe("https://app.hyperflip.xyz/positions");
});
