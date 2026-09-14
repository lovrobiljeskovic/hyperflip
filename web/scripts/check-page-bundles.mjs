import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Inspect initial scripts; manifests also list modules the page never loads.
for (const [page, expectsWallet] of [["index", false], ["build", true]]) {
  const html = readFileSync(`.next/server/app/${page}.html`, "utf8");
  const scripts = [...html.matchAll(/<script[^>]+src="([^"?]+)/g)]
    .map((match) => match[1]).filter((src) => src.startsWith("/_next/static/"));
  assert(scripts.length > 0, `${page}: expected initial scripts`);
  const code = scripts.map((src) => readFileSync(`.next/${src.slice("/_next/".length)}`, "utf8")).join("\n");
  const hasWallet = ["PrivyProvider", "WagmiProvider"].some((provider) => code.includes(provider));
  assert.equal(hasWallet, expectsWallet, `${page}: wallet bundle isolation`);
  console.log(`PASS: ${page} ${expectsWallet ? "loads" : "excludes"} wallet provider code`);
}
