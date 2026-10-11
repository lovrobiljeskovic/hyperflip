import { readFileSync, writeFileSync } from "node:fs";
const registry = JSON.parse(readFileSync(new URL("../registry/markets.json", import.meta.url), "utf8"));
const fields = ["vault", "title", "category", "coinYes", "coinNo", "startMs", "expiryMs", "sideYes", "sideNo", "group", "groupTitle", "sport"];
const markets = [...registry.markets, ...(registry.archived ?? [])].filter(m => m.category === "sports")
  // Elysium-shaped rows carry the leg as `vault`; the subgraph (998 only) keys tickets by the 998 vault.
  .map(m => ({ ...m, vault: m.sourceVault ?? m.vault }))
  .map(m => Object.fromEntries(fields.filter(k => m[k] !== undefined).map(k => [k, m[k]])));
const output = JSON.stringify(markets) + "\n";
const file = new URL("../web/public/position-markets.json", import.meta.url);
if (process.argv.includes("--check")) {
  if (readFileSync(file, "utf8") !== output) throw new Error("Position labels drifted; run node scripts/position-markets.mjs");
} else writeFileSync(file, output);
console.log(`PASS: position market snapshot (${markets.length} markets)`);
