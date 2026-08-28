import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { test } from "node:test";
import { jointProbWad, parseCorrelations, riskAdjustedJointProbWad, type CorrLeg } from "../src/correlation.js";
import { CorrelationWorker, PricingUnavailableError } from "../src/correlationWorker.js";
import { TooComplexError } from "../src/copula.js";

const WAD = 10n ** 18n;
const TABLE = parseCorrelations(readFileSync(new URL("../../registry/correlations.json", import.meta.url), "utf8"));
let vault = 0;
const leg = (p: number, cluster: string, underlying: string): CorrLeg => ({
  vault: `0x${(++vault).toString(16).padStart(40, "0")}`,
  isYes: true,
  probWad: BigInt(Math.round(p * Number(WAD))),
  cluster,
  underlying,
  bullish: true,
});

test("CorrelationWorker best estimate is byte-identical to the existing scale-one joint probability", async (context) => {
  const worker = new CorrelationWorker();
  context.after(() => worker.close());
  const legs = [leg(0.132, "equity", "NVDA"), leg(0.44, "equity", "SP500")];
  assert.equal(await worker.bestEstimate(legs, TABLE), jointProbWad(legs, TABLE, 0));
  assert.equal(riskAdjustedJointProbWad(legs, TABLE, 0.2), jointProbWad(legs, TABLE, 0.2));
});

test("CorrelationWorker keeps the single-integration four-million-point refusal", async (context) => {
  const worker = new CorrelationWorker();
  context.after(() => worker.close());
  const legs = ["BTC", "ETH"].flatMap((underlying) => [leg(0.5, "crypto", underlying), leg(0.45, "crypto", underlying)])
    .concat(["NVDA", "SP500"].flatMap((underlying) => [leg(0.4, "equity", underlying), leg(0.35, "equity", underlying)]));
  await assert.rejects(worker.bestEstimate(legs, TABLE), TooComplexError);
});

test("near-budget tickets keep two live risk integrations plus one unbiased worker integration", async (context) => {
  const worker = new CorrelationWorker();
  context.after(() => worker.close());
  const legs = [leg(0.5, "crypto", "BTC"), leg(0.45, "crypto", "BTC"), leg(0.55, "crypto", "ETH"), leg(0.4, "equity", "NVDA"), leg(0.44, "equity", "SP500")];
  assert.ok(riskAdjustedJointProbWad(legs, TABLE, 0.2) > 0n);
  assert.equal(await worker.bestEstimate(legs, TABLE), jointProbWad(legs, TABLE, 0));
});

test("CorrelationWorker bounds its queue at sixteen and cleans up timed-out work", async (context) => {
  let calls = 0;
  const workerUrl = new URL("../src/correlationWorker.ts", import.meta.url).href;
  const factory = () => ++calls === 1
    ? new Worker("setInterval(() => {}, 1000)", { eval: true })
    : new Worker(`import("tsx/esm/api").then(({tsImport})=>tsImport(${JSON.stringify(workerUrl)},${JSON.stringify(workerUrl)}))`, { eval: true });
  const worker = new CorrelationWorker(factory);
  context.after(() => worker.close());
  const legs = [leg(0.5, "crypto", "BTC"), leg(0.5, "crypto", "ETH")];
  const stuck = Array.from({ length: 16 }, () => worker.bestEstimate(legs, TABLE));
  await assert.rejects(worker.bestEstimate(legs, TABLE), (error: unknown) => error instanceof PricingUnavailableError && /queue full/.test(error.message));
  await assert.rejects(stuck[0], (error: unknown) => error instanceof PricingUnavailableError && /timeout/.test(error.message));
  await Promise.allSettled(stuck.slice(1));
  assert.equal(await worker.bestEstimate(legs, TABLE), jointProbWad(legs, TABLE, 0));
});
