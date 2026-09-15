import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bigBlocks, deploy, info, pickSports, ROOT, rotatedRegistry, sportsRegistryEntry } from "./rotate-lib.mjs";

const REGISTRY = path.join(ROOT, "registry/markets.json");
const ENV_FILE = path.join(ROOT, ".env");

const dryRun = process.argv.includes("--dry-run");
process.loadEnvFile(ENV_FILE);
if (process.env.ROTATE_MODE && process.env.ROTATE_MODE !== "sports") {
  throw new Error("ROTATE_MODE must be sports or unset");
}
for (const key of ["PRIVATE_KEY", "TESTNET_RPC", "KEEPER_ADDRESS"]) {
  if (!process.env[key]) {
    console.error(`${key} must be set in .env`);
    process.exit(1);
  }
}
console.log(`keeper: ${process.env.KEEPER_ADDRESS} (must be KEEPER_PRIVATE_KEY's address)`);

const [{ outcomes, questions }, mids] = await Promise.all([
  info("outcomeMeta"),
  info("allMids"),
]);
const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));
const nowMs = Date.now();
const knownCoins = new Set(registry.markets.map((m) => m.coinYes));

const expired = registry.markets.filter((m) => m.expiryMs <= nowMs);
const venueOf = new Map(outcomes.map((o) => [`#${o.outcome * 10}`, o.venue]));
let backfilled = 0;
const kept = registry.markets
  .filter((m) => m.expiryMs > nowMs)
  .map((m) => {
    const deployer = venueOf.get(m.coinYes);
    if (m.deployer || !deployer) return m;
    backfilled++;
    return { ...m, deployer };
  });
const picks = pickSports({ outcomes, questions, mids, knownCoins, nowMs });

// Retain metadata for settlement recovery of retired vaults.
const archived = [...(registry.archived ?? []), ...expired];
const writeRegistry = (markets) => writeFileSync(REGISTRY, JSON.stringify(rotatedRegistry(registry, markets, archived), null, 2) + "\n");

console.log(`registry: ${kept.length} live, ${expired.length} expired (dropped)`);
for (const m of expired) console.log(`  drop ${m.vault} — ${m.title}`);
if (picks.length === 0) {
  console.log("nothing to rotate — no fresh sports markets beyond what's wrapped");
  if ((expired.length || backfilled) && !dryRun) {
    writeRegistry(kept);
    console.log(`pruned ${expired.length} stranded vault(s), backfilled deployer on ${backfilled}`);
  }
  process.exit(0);
}
for (const p of picks) {
  const e = sportsRegistryEntry(p, "?");
  const spot = `${e.groupTitle} (${e.cluster}${e.question !== undefined ? `, q${e.question}` : ""}), kickoff in ${((p.startMs - nowMs) / 86400_000).toFixed(1)}d`;
  console.log(`pick: outcome ${p.outcome} — ${e.title} [${e.category}] mid ${mids[p.coinYes]} ${spot}, ${((p.expiryMs - nowMs) / 86400_000).toFixed(1)}d left`);
}
if (dryRun) {
  console.log("dry run — stopping before deploys");
  process.exit(0);
}

const deployed = [];
bigBlocks("on");
try {
  for (const pick of picks) {
    const vault = await deploy(pick);
    deployed.push(sportsRegistryEntry(pick, vault));
    console.log(`deployed ${vault} for outcome ${pick.outcome}`);
  }
} finally {
  // Record landed vaults even if resetting the block mode fails.
  try {
    bigBlocks("off");
  } finally {
    writeRegistry([...kept, ...deployed]);
  }
}

console.log(`\nrotated: +${deployed.length} markets, ${expired.length} pruned, registry now ${kept.length + deployed.length} entries`);
console.log("Now restart writer and keeper (both read registry/markets.json).");
