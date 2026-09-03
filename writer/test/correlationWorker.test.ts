import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { test } from "node:test";
import { jointProbWad, parseCorrelations, type CorrLeg } from "../src/correlation.js";
import { CorrelationWorker, PricingUnavailableError } from "../src/correlationWorker.js";
import { TooComplexError } from "../src/copula.js";

const WAD = 10n ** 18n;
const TABLE = parseCorrelations(readFileSync(new URL("../../registry/correlations.json", import.meta.url), "utf8"));
let vault = 0;
const leg = (p: number, cluster: string, underlying: string, bullish = true): CorrLeg => ({
  vault: `0x${(++vault).toString(16).padStart(40, "0")}`,
  isYes: bullish,
  probWad: BigInt(Math.round(p * Number(WAD))),
  cluster,
  underlying,
  bullish,
});
const workerUrl = new URL("../src/correlationWorker.ts", import.meta.url).href;
const realWorker = () => new Worker(`import("tsx/esm/api").then(({tsImport})=>tsImport(${JSON.stringify(workerUrl)},${JSON.stringify(workerUrl)}))`, { eval: true });

test("CorrelationWorker returns the point-model joint probability byte-for-byte", async (context) => {
  const worker = new CorrelationWorker();
  context.after(() => worker.close());
  for (const legs of [
    [leg(0.132, "equity", "NVDA"), leg(0.44, "equity", "SP500")],
    [leg(0.85, "crypto", "BTC"), leg(0.5, "crypto", "ETH"), leg(0.3, "equity", "NVDA", false)],
    // Repeated underlying: the deepest tree shape, still priced off the loop.
    [leg(0.5, "crypto", "BTC"), leg(0.45, "crypto", "BTC"), leg(0.55, "crypto", "ETH"), leg(0.4, "equity", "NVDA"), leg(0.44, "equity", "SP500")],
    // Same-underlying-only ticket: no longer a main-thread special case.
    [leg(0.5, "crypto", "BTC"), leg(0.45, "crypto", "BTC", false)],
    [leg(0.37, "crypto", "BTC")],
  ]) assert.equal(await worker.jointProbWad(legs, TABLE), jointProbWad(legs, TABLE));
});

test("CorrelationWorker refuses an over-budget repeated-underlying shape with the cost", async (context) => {
  const worker = new CorrelationWorker();
  context.after(() => worker.close());
  const legs = ["BTC", "ETH"].flatMap((underlying) => [leg(0.5, "crypto", underlying), leg(0.45, "crypto", underlying)])
    .concat(["NVDA", "SP500"].flatMap((underlying) => [leg(0.4, "equity", underlying), leg(0.35, "equity", underlying)]));
  const t0 = performance.now();
  await assert.rejects(worker.jointProbWad(legs, TABLE), (error: unknown) => error instanceof TooComplexError && error.cost > 4_000_000);
  assert.ok(performance.now() - t0 < 500, "refusal must be a cost estimate, not an integration");
  // The worker is still healthy for the next request.
  const cheap = [leg(0.5, "crypto", "BTC"), leg(0.5, "crypto", "ETH")];
  assert.equal(await worker.jointProbWad(cheap, TABLE), jointProbWad(cheap, TABLE));
});

test("CorrelationWorker bounds its queue at sixteen and rejects timed-out work", async (context) => {
  let calls = 0;
  const factory = () => ++calls === 1 ? new Worker("setInterval(() => {}, 1000)", { eval: true }) : realWorker();
  const worker = new CorrelationWorker(factory);
  context.after(() => worker.close());
  const legs = [leg(0.5, "crypto", "BTC"), leg(0.5, "crypto", "ETH")];
  const stuck = Array.from({ length: 16 }, () => worker.jointProbWad(legs, TABLE));
  await assert.rejects(worker.jointProbWad(legs, TABLE), (error: unknown) => error instanceof PricingUnavailableError && /queue full/.test(error.message));
  await assert.rejects(stuck[0], (error: unknown) => error instanceof PricingUnavailableError && /timeout/.test(error.message));
  await Promise.allSettled(stuck.slice(1));
});

test("CorrelationWorker refuses overlap until a timed-out worker has terminated", async (context) => {
  let calls = 0;
  let finishTermination!: () => void;
  const factory = () => {
    calls++;
    if (calls > 1) return realWorker();
    const stuck = new EventEmitter() as unknown as Worker;
    stuck.unref = () => stuck;
    stuck.postMessage = () => undefined;
    stuck.terminate = () => new Promise<number>((resolve) => { finishTermination = () => resolve(1); });
    return stuck;
  };
  const worker = new CorrelationWorker(factory);
  context.after(() => worker.close());
  const legs = [leg(0.5, "crypto", "BTC"), leg(0.5, "crypto", "ETH")];
  await assert.rejects(worker.jointProbWad(legs, TABLE), /timeout/);
  await assert.rejects(worker.jointProbWad(legs, TABLE), /cleanup pending/);
  assert.equal(calls, 1);
  finishTermination();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await worker.jointProbWad(legs, TABLE), jointProbWad(legs, TABLE));
  assert.equal(calls, 2);
});

test("a worker crash rejects in-flight work and the next request is served by a fresh worker", async (context) => {
  let calls = 0;
  const factory = () => ++calls === 1 ? new Worker("process.exit(3)", { eval: true }) : realWorker();
  const worker = new CorrelationWorker(factory);
  context.after(() => worker.close());
  const legs = [leg(0.5, "crypto", "BTC"), leg(0.5, "crypto", "ETH")];
  await assert.rejects(worker.jointProbWad(legs, TABLE), (error: unknown) => error instanceof PricingUnavailableError && /worker exited: 3/.test(error.message));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await worker.jointProbWad(legs, TABLE), jointProbWad(legs, TABLE));
});
