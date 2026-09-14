import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const contracts = { writer: ["ParlayVault", "OutcomeVault"], keeper: ["OutcomeVault", "KeeperVerifier"] };

export function generateAbis(directory, check = false) {
  for (const [service, names] of Object.entries(contracts)) {
    for (const name of names) {
      const { abi } = JSON.parse(readFileSync(join(directory, "out", `${name}.sol`, `${name}.json`), "utf8"));
      if (!Array.isArray(abi) || !abi.length) throw new Error(`Missing ABI: ${name}`);
      const generated = `${JSON.stringify(abi, null, 2)}\n`;
      const relative = `${service}/abi/${name}.json`;
      const file = join(directory, relative);
      if (check) {
        if (readFileSync(file, "utf8") !== generated) throw new Error(`ABI drift: ${relative}; run forge build && node scripts/abis.mjs`);
      } else {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, generated);
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("Usage: node scripts/abis.mjs [--check]");
  generateAbis(root, process.argv.includes("--check"));
  console.log(`PASS: service ABIs ${process.argv.includes("--check") ? "match Foundry artifacts" : "generated"}`);
}
