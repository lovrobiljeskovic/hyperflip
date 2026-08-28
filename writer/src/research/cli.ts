import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectSources } from "./candles.js";
import { deriveReturns } from "./returns.js";
import { parseSourceRegistry } from "./types.js";

if (process.argv[2] !== "collect" && process.argv[2] !== "derive") {
  console.error("usage: npm run research -- collect|derive");
  process.exitCode = 2;
} else if (process.argv[2] === "collect") {
  const root = process.env.RESEARCH_ROOT;
  const registryFile = process.env.CORRELATION_SOURCES_FILE;
  if (!root || !registryFile) {
    console.error("RESEARCH_ROOT and CORRELATION_SOURCES_FILE are required");
    process.exitCode = 2;
  } else {
    const summary = await collectSources({
      root: resolve(root),
      registry: parseSourceRegistry(readFileSync(resolve(registryFile), "utf8")),
      apiUrl: process.env.RESEARCH_INFO_API_URL,
    });
    console.log(JSON.stringify(summary));
    if (summary.failures.length) process.exitCode = 1;
  }
} else {
  const root = process.env.RESEARCH_ROOT;
  const manifestFile = process.env.RESEARCH_MANIFEST_FILE;
  const asOfMs = Number(process.env.RESEARCH_AS_OF_MS);
  const lookbackMs = Number(process.env.RESEARCH_LOOKBACK_MS);
  if (!root || !manifestFile || !Number.isSafeInteger(asOfMs) || !Number.isSafeInteger(lookbackMs) || lookbackMs < 0) {
    console.error("RESEARCH_ROOT, RESEARCH_MANIFEST_FILE, RESEARCH_AS_OF_MS, and RESEARCH_LOOKBACK_MS are required");
    process.exitCode = 2;
  } else {
    const output = deriveReturns(resolve(root), JSON.parse(readFileSync(resolve(manifestFile), "utf8")), { asOfMs, lookbackMs });
    console.log(JSON.stringify(output));
  }
}
