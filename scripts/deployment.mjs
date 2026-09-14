import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// The frontend uploads independently, so include its build-time manifest loader.
const root = resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");
for (const name of ["deployment.mts", "deployment.testnet.json"]) {
  const source = readFileSync(resolve(root, "registry", name), "utf8");
  const destination = resolve(root, "web/deployment", name);
  if (check) {
    if (readFileSync(destination, "utf8") !== source) throw new Error(`Deployment drift: ${name}; run node scripts/deployment.mjs`);
  } else {
    mkdirSync(resolve(root, "web/deployment"), { recursive: true });
    writeFileSync(destination, source);
  }
}
console.log(`PASS: frontend deployment files ${check ? "match registry" : "generated"}`);
