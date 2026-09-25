import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bigBlocks, deployPair, elysiumRpcs, info, pickSports, ROOT, rotatedRegistry, settledVaults, sportsRegistryEntry } from "./rotate-lib.mjs";

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

const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));
// A row is done when the address the ParlayVault reads is settled: the 998 vault on HyperEVM
// rows, the Elysium leg on Elysium rows. Retiring on the 998 sourceVault instead dropped the row
// from the keeper's watch before the relay landed and stranded every ticket on it (2026-09-25).
const legRows = registry.markets.filter((m) => m.sourceVault);
const [{ outcomes, questions }, mids, settledCore, settledLegs] = await Promise.all([
  info("outcomeMeta"),
  info("allMids"),
  settledVaults(registry.markets.filter((m) => !m.sourceVault).map((m) => m.vault)),
  settledVaults(legRows.map((m) => m.vault), elysiumRpcs()),
]);
const settled = new Set([...settledCore, ...settledLegs]);
const nowMs = Date.now();
const knownCoins = new Set(registry.markets.map((m) => m.coinYes));
// ROTATE_VENUES=flip,flp keeps the board to our own HIP-4 venues (Elysium legs are only deployed for
// what we list, so foreign venues would otherwise get legs too). Unset = every venue, as before.
const venues = process.env.ROTATE_VENUES?.split(",").map((v) => v.trim()).filter(Boolean);
const outcomesInScope = venues?.length ? outcomes.filter((o) => venues.includes(o.venue)) : outcomes;

// A settled row is done regardless of its deadline: off the board, into archived.
const retired = (m) => m.expiryMs <= nowMs || settled.has(m.vault.toLowerCase());
const expired = registry.markets.filter(retired);
const venueOf = new Map(outcomes.map((o) => [`#${o.outcome * 10}`, o.venue]));
let backfilled = 0;
const kept = registry.markets
  .filter((m) => !retired(m))
  .map((m) => {
    const deployer = venueOf.get(m.coinYes);
    if (m.deployer || !deployer) return m;
    backfilled++;
    return { ...m, deployer };
  });
const picks = pickSports({ outcomes: outcomesInScope, questions, mids, knownCoins, nowMs });

// Retain metadata for settlement recovery of retired vaults.
const archived = [...(registry.archived ?? []), ...expired];
const writeRegistry = (markets) => writeFileSync(REGISTRY, JSON.stringify(rotatedRegistry(registry, markets, archived), null, 2) + "\n");

console.log(`registry: ${kept.length} live, ${expired.length} expired (dropped)`);
for (const m of expired) console.log(`  drop ${m.vault} — ${m.title}${settled.has(m.vault.toLowerCase()) ? " (settled)" : ""}`);
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
    const { vault, sourceVault } = await deployPair(pick);
    deployed.push(sportsRegistryEntry(pick, vault, sourceVault));
    console.log(`deployed ${sourceVault ?? vault}${sourceVault ? ` (leg ${vault})` : ""} for outcome ${pick.outcome}`);
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
