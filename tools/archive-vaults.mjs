// Move vaults out of registry.markets into registry.archived (titles stay for
// old tickets; on-chain vaults untouched). Usage:
//   node tools/archive-vaults.mjs registry/markets.json 0xabc... 0xdef...
import { readFileSync, writeFileSync } from "node:fs";
const [file, ...vaults] = process.argv.slice(2);
const junk = new Set(vaults.map((v) => v.toLowerCase()));
const r = JSON.parse(readFileSync(file, "utf8"));
const out = r.markets.filter((m) => junk.has(m.vault.toLowerCase()));
r.markets = r.markets.filter((m) => !junk.has(m.vault.toLowerCase()));
r.archived = [...(r.archived ?? []), ...out];
writeFileSync(file, JSON.stringify(r, null, 2) + "\n");
console.log(`archived ${out.length}: ${out.map((m) => m.groupTitle ?? m.title).join(", ")} — live now ${r.markets.length}`);
