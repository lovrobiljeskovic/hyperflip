import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectSources } from "./candles.js";
import { parseSourceRegistry } from "./types.js";

if (process.argv[2] !== "collect") {
  console.error("usage: npm run research -- collect");
  process.exitCode = 2;
} else {
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
}
