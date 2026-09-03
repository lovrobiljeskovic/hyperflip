// Rotate the testnet market board: discover fresh HIP-4 markets via the info
// API, deploy an OutcomeVault per pick, rewrite registry/markets.json.
// Run from repo root:
//
//   ROTATE_MODE=sports node tools/rotate-markets.mjs [--dry-run]
//
// ROTATE_MODE=crypto (default) wraps price binaries and needs the correlation
// source registry; ROTATE_MODE=sports wraps fixtures (questions whole) and is
// what the sports beta runs with PRICING_MODE=independent on the writer.
//
// Needs: .env with PRIVATE_KEY + TESTNET_RPC + KEEPER_ADDRESS, forge, uv
// (big-block toggle). Restart writer + keeper afterwards — this script does
// not touch processes.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { filterMappedPicks, pickBinaries, pickSports, registryEntry, sportsRegistryEntry, marketSymbol, sportsMarketSymbol, rotatedRegistry } from "./rotate-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INFO_URL = "https://api.hyperliquid-testnet.xyz/info";
// Deploys rotate through these per attempt. Official first: it landed all 28
// sports vaults on 2026-09-03 within one big block each. Chainlink Labs
// (free, no key) is great for reads but 429s forge's simulation burst; dRPC
// drops upstreams mid-run ("failed to get account ... no available upstreams").
const DEPLOY_RPCS = ["https://rpc.hyperliquid-testnet.xyz/evm", "https://rpcs.chain.link/hyperevm/testnet", "https://hyperliquid-testnet.drpc.org"];
const REGISTRY = path.join(ROOT, "registry/markets.json");
const SOURCES = path.join(ROOT, "registry/correlation-sources.json");
const ENV_FILE = path.join(ROOT, ".env");
// Constants from the 2026-08-19 deploys (broadcast/Deploy.s.sol/998).
// KEEPER_ADDRESS is deliberately NOT pinned here — it comes from .env, because
// OutcomeVault stores the keeper immutably and a stale value permanently breaks
// the keeper-only pruned-settlement relay path for that market.
const DEPLOY_ENV = {
  QUOTE_TOKEN_ADDRESS: "0x2B3370eE501B4a559b57D449569354196457D8Ab",
  CORE_SYSTEM_ADDRESS: "0x2000000000000000000000000000000000000000",
  QUOTE_TOKEN_CORE_INDEX: "0",
  VERIFIER_ADDRESS: "0xc19d502255852C3D2564C027b61556EB2E89e431",
  QUESTION_ID: String(0xffffffff), // standalone-binary sentinel
};

const dryRun = process.argv.includes("--dry-run");
const mode = process.env.ROTATE_MODE ?? "crypto";
if (mode !== "crypto" && mode !== "sports") {
  console.error("ROTATE_MODE must be crypto or sports");
  process.exit(1);
}
const sports = mode === "sports";

process.loadEnvFile(ENV_FILE);
for (const key of ["PRIVATE_KEY", "TESTNET_RPC", "KEEPER_ADDRESS"]) {
  if (!process.env[key]) {
    console.error(`${key} must be set in .env`);
    process.exit(1);
  }
}
console.log(`keeper: ${process.env.KEEPER_ADDRESS} (must be KEEPER_PRIVATE_KEY's address)`);

async function info(type, extra = {}) {
  const res = await fetch(INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, ...extra }),
  });
  if (!res.ok) throw new Error(`info ${type}: HTTP ${res.status}`);
  return res.json();
}

// Strike sanity needs each underlying's own mid. Crypto perps are in the
// default allMids; tokenized equities/commodities only in the `xyz` dex one.
const [{ outcomes, questions }, mids, xyzMids] = await Promise.all([
  info("outcomeMeta"),
  info("allMids"),
  info("allMids", { dex: "xyz" }),
]);
Object.assign(mids, xyzMids);
const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));
const nowMs = Date.now();
const knownCoins = new Set(registry.markets.map((m) => m.coinYes));

const expired = registry.markets.filter((m) => m.expiryMs <= nowMs);
const kept = registry.markets.filter((m) => m.expiryMs > nowMs);
let picks;
if (sports) {
  picks = pickSports({ outcomes, questions, mids, knownCoins, nowMs });
} else {
  const sources = JSON.parse(readFileSync(SOURCES, "utf8"));
  const candidates = pickBinaries({ outcomes, mids, questions, knownCoins, nowMs });
  try {
    picks = filterMappedPicks(candidates, sources, new Set(kept.map((market) => market.underlying)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  const mappedUnderlyings = new Set(sources.sources.map((source) => source.underlying));
  for (const pick of candidates) if (!mappedUnderlyings.has(pick.perp)) console.log(`skip unmapped ${pick.perp}`);
}
const entryFor = sports ? sportsRegistryEntry : registryEntry;
const symbolFor = sports ? sportsMarketSymbol : marketSymbol;

// Expired entries move to `archived` rather than vanishing: writer quoting and
// the keeper only read `.markets`, but the frontend still needs titles for
// settled vaults on old tickets — without this they render as raw addresses.
const archived = [...(registry.archived ?? []), ...expired];
const writeRegistry = (markets) => writeFileSync(REGISTRY, JSON.stringify(rotatedRegistry(registry, markets, archived), null, 2) + "\n");

console.log(`registry: ${kept.length} live, ${expired.length} expired (dropped)`);
for (const m of expired) console.log(`  drop ${m.vault} — ${m.title}`);
if (picks.length === 0) {
  console.log("nothing to rotate — no fresh binaries beyond what's wrapped");
  // Prune anyway. Core settles then prunes an expired outcome within ~10 minutes,
  // so an expired vault left in the registry is one the keeper can never relay —
  // it only alerts "manual recovery needed" on every start.
  if (expired.length && !dryRun) {
    writeRegistry(kept);
    console.log(`pruned ${expired.length} stranded vault(s) from the registry`);
  }
  process.exit(0);
}
for (const p of picks) {
  const e = entryFor(p, "?");
  const spot = sports ? `${e.groupTitle} (${e.cluster}${e.question !== undefined ? `, q${e.question}` : ""}), kickoff in ${((p.startMs - nowMs) / 86400_000).toFixed(1)}d` : `vs ${p.perp} ${mids[p.venue ? `${p.venue}:${p.perp}` : p.perp]}`;
  console.log(`pick: outcome ${p.outcome} — ${e.title} [${e.category}] mid ${mids[p.coinYes]} ${spot}, ${((p.expiryMs - nowMs) / 86400_000).toFixed(1)}d left`);
}
if (dryRun) {
  console.log("dry run — stopping before deploys");
  process.exit(0);
}

function bigBlocks(flag) {
  execFileSync("uv", ["run", "tools/bigblocks.py", flag], { cwd: ROOT, stdio: "inherit" });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Did this pick's deploy tx land, even if forge gave up polling for the
 * receipt? Reads run-latest.json and asks both RPCs directly. Returns the
 * vault address or null. Prevents duplicate deploys on receipt-poll flake. */
async function landedVault(pick, polls = 6) {
  let tx;
  try {
    const broadcast = JSON.parse(readFileSync(path.join(ROOT, "broadcast/Deploy.s.sol/998/run-latest.json"), "utf8"));
    tx = broadcast.transactions.find((t) => t.contractName === "OutcomeVault" && t.arguments?.[4] === String(pick.outcome));
  } catch {
    return null;
  }
  if (!tx) return null;
  for (let i = 0; i < polls; i++) {
    for (const rpc of DEPLOY_RPCS) {
      try {
        const res = await fetch(rpc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [tx.hash] }),
        });
        const receipt = (await res.json()).result;
        if (receipt?.status === "0x1") return tx.contractAddress;
        if (receipt) return null; // landed but reverted
      } catch {} // RPC flake — try the other / next poll
    }
    await sleep(20_000); // big blocks tick ~60s; give a pending tx time
  }
  return null;
}

async function deploy(pick, attempts = 4) {
  // A previous run may have landed the tx but died before recording it.
  const prior = await landedVault(pick, 1);
  if (prior) {
    console.log(`reusing already-landed vault ${prior} for outcome ${pick.outcome}`);
    return prior;
  }
  for (let i = 0; i < attempts; i++) {
    try {
      execFileSync(
        "forge",
        // PRIVATE_KEY reaches forge through the environment (Deploy.s.sol reads
        // it), never argv — command lines are visible to every user on the box.
        ["script", "script/Deploy.s.sol", "--rpc-url", DEPLOY_RPCS[i % DEPLOY_RPCS.length], "--broadcast", "--legacy", "--sig", "run()", "--retries", "12", "--delay", "10"],
        {
          cwd: ROOT,
          stdio: "inherit",
          env: {
            ...process.env,
            ...DEPLOY_ENV,
            // A question member must settle against its real question id
            // (OutcomeVault checks the 0x814 binding); standalone keeps the sentinel.
            ...(pick.question != null ? { QUESTION_ID: String(pick.question) } : {}),
            OUTCOME_ID: String(pick.outcome),
            MARKET_SYMBOL: symbolFor(pick),
          },
        },
      );
    } catch (err) {
      console.log(`forge exited non-zero for outcome ${pick.outcome} (attempt ${i + 1}) — checking chain for a landed tx...`);
    }
    const vault = await landedVault(pick);
    if (vault) return vault;
    if (i + 1 < attempts) {
      console.log(`no landed tx for outcome ${pick.outcome}, retrying on other RPC in 15s...`);
      await sleep(15_000);
    }
  }
  throw new Error(`deploy failed for outcome ${pick.outcome} after ${attempts} attempts`);
}

const deployed = [];
bigBlocks("on");
try {
  for (const pick of picks) {
    const vault = await deploy(pick);
    deployed.push(entryFor(pick, vault));
    console.log(`deployed ${vault} for outcome ${pick.outcome}`);
  }
} finally {
  bigBlocks("off");
  // Write in the finally so a partial run still records what landed and still
  // prunes — a throw halfway through must not leave the stranded vaults behind.
  writeRegistry([...kept, ...deployed]);
}

// VAULT_ADDRESSES in .env is intentionally left alone: it is an override that
// makes the keeper ignore the registry entirely, so writing it back here would
// re-pin the very vaults this rotation just pruned.
console.log(`\nrotated: +${deployed.length} markets, ${expired.length} pruned, registry now ${kept.length + deployed.length} entries`);
console.log("Now restart writer and keeper (both read registry/markets.json).");
