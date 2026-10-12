// Acceptance test for a candidate HyperEVM RPC endpoint. Four checks, each a past failure:
//   1. 0x814 precompile — the keeper reads outcome status through it. dRPC answers normal calls
//      fine but fails this one ("out of gas").
//   2. getLogs span — the official endpoint caps ranges at 1000 blocks.
//   3. burst tolerance — the official endpoint returns -32005 under a burst of getLogs.
//   4. 0x801 outcome asset id support at latest — the keeper's balance-verification path. FATAL
//      for keeper use: an endpoint that fails it must be dropped from TESTNET_RPC, since the
//      keeper cannot tell an executed op from a no-op there. Alongside it runs the 0x809
//      pinned-read honesty probe, informational only: it records whether pinned precompile reads
//      serve live state and never fails an endpoint.
//
// An endpoint passing all four lets WRITER_RPC collapse back into TESTNET_RPC.
//
// Usage: npx tsx rpc-check.ts <url> [<url> ...]

import { createPublicClient, http } from "viem";
import { readFileSync } from "node:fs";
import { encodedAssetId, readOutcomeStatus, readSpotBalanceWei } from "../services/precompiles.mjs";

const L1_BLOCK_PRECOMPILE = "0x0000000000000000000000000000000000000809";
const PARLAY_VAULT = "0x407CDc0B15E8d81f4D122481Ecf92Dbe07DC0169";
const KNOWN_OUTCOME = 13162;
const BURST = 20; // one tick of a modest catch-up scan

// A live outcome asset id, derived from the registry (nightly rotation would stale a hardcoded
// one): coinYes "#137340" -> 100000000 + 137340.
const registry = JSON.parse(readFileSync(new URL("../registry/markets.json", import.meta.url), "utf8"));
const OUTCOME_ASSET_ID = encodedAssetId(BigInt(registry.markets[0].coinYes.slice(1)));

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error("usage: npx tsx rpc-check.ts <url> [<url> ...]");
  process.exit(1);
}

const short = (err: unknown) => String(err).split("\n")[0].slice(0, 80);

// Per-endpoint latest 0x809 value, indexed by position (not by url — the same url can appear
// twice, e.g. when smoke-testing the comparison itself), filled in by the 0x809 probe below.
const latestL1: bigint[] = [];

async function check(url: string, idx: number) {
  // No retries: retries would mask exactly the rate limiting this is trying to measure.
  const client = createPublicClient({ transport: http(url, { retryCount: 0, timeout: 15_000 }) });
  const results: [string, boolean, string][] = [];

  let head;
  try {
    head = await client.getBlockNumber();
    results.push(["reachable", true, `head ${head}`]);
  } catch (err) {
    results.push(["reachable", false, short(err)]);
    return results;
  }

  // 1. precompile
  try {
    const { status, question } = await readOutcomeStatus(client, KNOWN_OUTCOME);
    results.push(["0x814 precompile", true, `status ${status}, question ${question}`]);
  } catch (err) {
    results.push(["0x814 precompile", false, short(err)]);
  }

  // 1b. 0x801 with an outcome-encoded asset id at latest — the keeper's balance-read path.
  try {
    const total = await readSpotBalanceWei(client, PARLAY_VAULT, OUTCOME_ASSET_ID);
    results.push(["0x801 outcome latest", true, `total ${total}`]);
  } catch (err) {
    results.push(["0x801 outcome latest", false, short(err)]);
  }

  // 1c. Pinned-read honesty probe (informational, never fails the endpoint): pin the L1 block
  // number precompile ~1000 blocks back and compare with latest. Every endpoint tested so far
  // serves LIVE Core state for pinned precompile calls — which is exactly why the keeper takes no
  // provenance from pinned reads. If an endpoint ever answers with a genuinely smaller (older)
  // value, historical precompile state has become real and a pinned-baseline keeper is viable.
  try {
    const [pinned, latest] = await Promise.all([
      client.call({ to: L1_BLOCK_PRECOMPILE, data: "0x", blockNumber: head - 1000n }),
      client.call({ to: L1_BLOCK_PRECOMPILE, data: "0x" }),
    ]);
    const p = BigInt(pinned.data!);
    const l = BigInt(latest.data!);
    latestL1[idx] = l;
    const historical = l - p > 500n; // ~1000 EVM blocks apart must differ by many L1 blocks if real
    results.push(["0x809 pinned honesty", true, historical ? `HISTORICAL STATE SERVED (pinned ${p}, latest ${l}) — pinned-baseline design viable!` : `live-state only (pinned ${p} ≈ latest ${l}), as expected`]);
  } catch (err) {
    results.push(["0x809 pinned honesty", false, short(err)]);
  }

  // 2. getLogs range. Every endpoint tested so far caps well below 5000, so the question is
  // whether the 1000-block chunk the poker already uses is accepted.
  for (const span of [1000n, 5000n]) {
    try {
      await client.getLogs({ address: PARLAY_VAULT, fromBlock: head - span, toBlock: head });
      results.push([`getLogs ${span} blocks`, true, "accepted"]);
    } catch (err) {
      results.push([`getLogs ${span} blocks`, false, short(err)]);
    }
  }

  // 3. Burst of the ACTUAL workload. getBlockNumber is far too cheap to trip a limiter — the
  // official endpoint passed 50 of those while it was busy rate-limiting the poker. What
  // matters is concurrent getLogs, which is what a catch-up scan is made of.
  try {
    const started = Date.now();
    const settled = await Promise.allSettled(
      Array.from({ length: BURST }, (_, i) =>
        client.getLogs({
          address: PARLAY_VAULT,
          fromBlock: head - BigInt((i + 1) * 1000),
          toBlock: head - BigInt(i * 1000) - 1n,
        }),
      ),
    );
    const failed = settled.filter((s) => s.status === "rejected");
    const limited = failed.filter((s) => /32005|rate limit|limit exceeded/i.test(String(s.reason)));
    const elapsed = Date.now() - started;
    results.push([
      `burst ${BURST} getLogs`,
      failed.length === 0,
      failed.length === 0
        ? `all ok in ${elapsed}ms`
        : `${failed.length}/${BURST} failed (${limited.length} rate-limited)`,
    ]);
  } catch (err) {
    results.push([`burst ${BURST} getLogs`, false, short(err)]);
  }

  return results;
}

for (let i = 0; i < urls.length; i++) {
  console.log(`\n${urls[i]}`);
  for (const [name, ok, detail] of await check(urls[i], i)) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(20)} ${detail}`);
  }
}

// Core-freshness cross-check (only meaningful with 2+ endpoints): balance reads via 0x801 can
// land on any endpoint in the fallback list, so an endpoint whose HyperCore view lags the rest by
// more than balanceTimeoutMs (60s ~ 60 L1 blocks) risks a false executed=false attestation. This
// is a report line, not a per-endpoint failure — an endpoint stays otherwise PASS/FAIL on its own
// merits above.
const known = latestL1.map((l, i) => [i, l] as const).filter(([, l]) => l !== undefined);
if (urls.length > 1 && known.length > 1) {
  const max = known.reduce((m, [, l]) => (l > m ? l : m), known[0][1]);
  const behind = known.filter(([, l]) => max - l > 60n);
  console.log(
    behind.length === 0
      ? `\nCore-freshness: all ${known.length} endpoints within 60 L1 blocks of the max (${max})`
      : `\nCore-freshness: ${behind
          .map(([i, l]) => `${urls[i]} (#${i}) is ${max - l} L1 blocks behind (latest ${l} vs max ${max})`)
          .join("; ")}`,
  );
}
