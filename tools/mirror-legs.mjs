// One-off cutover: mirror the live house-venue markets onto Elysium. Deploys an OutcomeLeg per
// live registry row from our HIP-4 venue that has no `sourceVault` yet (script/MirrorLegs.s.sol,
// one broadcast), then rewrites those rows as { vault: leg, sourceVault: vault998 }. Live rows
// from other venues move to `archived`: the Elysium ParlayVault cannot read a 998 vault, so
// they must not stay quotable. Rows already mirrored and `archived` are left alone. Usage:
//   node tools/mirror-legs.mjs [--dry-run|--apply]   (.env: PRIVATE_KEY, ELYSIUM_RPC, RELAY_ADDRESS, PARLAY_VAULT_ADDRESS)
// --apply skips the broadcast and only maps the latest MirrorLegs broadcast into the registry.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { VENUES } from "./house-lib.mjs";
import { ELYSIUM_CHAIN_ID, requireEnvKeys, ROOT, writeRegistry } from "./rotate-lib.mjs";

const REGISTRY = path.join(ROOT, "registry/markets.json");
const dryRun = process.argv.includes("--dry-run");
const applyOnly = process.argv.includes("--apply");
process.loadEnvFile(path.join(ROOT, ".env"));
requireEnvKeys("PRIVATE_KEY", "ELYSIUM_RPC", "RELAY_ADDRESS", "PARLAY_VAULT_ADDRESS");

const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));
const nowMs = Date.now();
const house = (m) => VENUES.includes(m.deployer);
const todo = registry.markets.filter((m) => house(m) && m.expiryMs > nowMs && !m.sourceVault);
// Everything that gets no leg leaves the board: foreign venues and already-expired house rows.
const foreign = registry.markets.filter((m) => !m.sourceVault && !todo.includes(m));
console.log(`live ${registry.markets.filter((m) => m.expiryMs > nowMs).length}, house to mirror ${todo.length}, other venues to archive ${foreign.length}`);
for (const m of foreign) console.log(`  archive ${m.vault} — ${m.title} (${m.deployer ?? "unknown venue"})`);
if (dryRun) process.exit(0);

if (todo.length && !applyOnly) execFileSync(
  "forge",
  ["script", "script/MirrorLegs.s.sol", "--rpc-url", process.env.ELYSIUM_RPC.split(",")[0], "--private-key", process.env.PRIVATE_KEY,
    "--broadcast", "--skip-simulation", "--gas-estimate-multiplier", "150", "--sig", "run()", "--retries", "12", "--delay", "2"],
  { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, SOURCE_VAULTS: todo.map((m) => m.vault).join(",") } },
);

// Map each landed leg back to its source vault from the broadcast; a leg missing here (tx
// dropped) leaves its row untouched, so a rerun picks it up.
const legOf = new Map();
if (todo.length) for (const t of JSON.parse(readFileSync(path.join(ROOT, `broadcast/MirrorLegs.s.sol/${ELYSIUM_CHAIN_ID}/run-latest.json`), "utf8")).transactions) {
  if (t.contractName === "OutcomeLeg" && t.contractAddress) legOf.set(String(t.arguments?.[0]).toLowerCase(), t.contractAddress);
}
let mirrored = 0;
const markets = registry.markets.filter((m) => !foreign.includes(m)).map((m) => {
  const leg = legOf.get(m.vault.toLowerCase());
  if (!leg || m.sourceVault) return m;
  mirrored++;
  const { vault, ...rest } = m;
  return { vault: leg, sourceVault: vault, ...rest };
});
writeRegistry(registry, markets, [...(registry.archived ?? []), ...foreign]);
console.log(`mirrored ${mirrored} of ${todo.length}, archived ${foreign.length}; registry written. Restart writer and keeper.`);
