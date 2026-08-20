// Acceptance test for a candidate HyperEVM RPC endpoint.
//
// Three things have actually bitten this project, so all three are checked:
//   1. 0x814 precompile — the keeper reads outcome status through it. dRPC answers normal calls
//      fine but fails this one ("out of gas"), which is why the keeper is still pinned to the
//      official endpoint while only the writer moved off it.
//   2. getLogs span — the official endpoint caps ranges at 1000 blocks, which forced the poker's
//      chunked scan.
//   3. burst tolerance — the official endpoint returns -32005 under a burst, which is what left
//      the poker unable to finish a catch-up scan at all.
//
// An endpoint passing all three lets WRITER_RPC collapse back into TESTNET_RPC.
//
// Usage: node rpc-check.mjs <url> [<url> ...]

import { createPublicClient, http, encodeAbiParameters, decodeAbiParameters } from "viem";

const OUTCOME_STATUS_PRECOMPILE = "0x0000000000000000000000000000000000000814";
const PARLAY_VAULT = "0x407CDc0B15E8d81f4D122481Ecf92Dbe07DC0169";
const KNOWN_OUTCOME = 13162;
const BURST = 20; // one tick of a modest catch-up scan

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error("usage: node rpc-check.mjs <url> [<url> ...]");
  process.exit(1);
}

const short = (err) => String(err).split("\n")[0].slice(0, 80);

async function check(url) {
  // No retries: retries would mask exactly the rate limiting this is trying to measure.
  const client = createPublicClient({ transport: http(url, { retryCount: 0, timeout: 15_000 }) });
  const results = [];

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
    const { data } = await client.call({
      to: OUTCOME_STATUS_PRECOMPILE,
      data: encodeAbiParameters([{ type: "uint32" }], [KNOWN_OUTCOME]),
    });
    const [status, , question] = decodeAbiParameters(
      [{ type: "uint8" }, { type: "uint64" }, { type: "uint32" }],
      data,
    );
    results.push(["0x814 precompile", true, `status ${status}, question ${question}`]);
  } catch (err) {
    results.push(["0x814 precompile", false, short(err)]);
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

for (const url of urls) {
  console.log(`\n${url}`);
  for (const [name, ok, detail] of await check(url)) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(20)} ${detail}`);
  }
}
