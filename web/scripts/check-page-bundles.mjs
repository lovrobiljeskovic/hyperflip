import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Check actual initial scripts, not the client-reference manifest: the latter
// can list modules that a page never loads. Run after a production build.
for (const [page, expectsWallet] of [["index", false], ["build", true]]) {
  const html = readFileSync(`.next/server/app/${page}.html`, "utf8");
  const scripts = [...html.matchAll(/<script[^>]+src="([^"?]+)/g)]
    .map((match) => match[1]).filter((src) => src.startsWith("/_next/static/"));
  assert(scripts.length > 0, `${page}: expected initial scripts`);
  const code = scripts.map((src) => readFileSync(`.next/${src.slice("/_next/".length)}`, "utf8")).join("\n");
  assert.equal(code.includes("PrivyProvider"), expectsWallet, `${page}: wallet bundle isolation`);
  console.log(`PASS: ${page} ${expectsWallet ? "loads" : "excludes"} wallet provider code`);
}
