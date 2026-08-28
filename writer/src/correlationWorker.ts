import { isMainThread, parentPort, Worker } from "node:worker_threads";
import { riskAdjustedJointProbWad, type CorrLeg, type CorrelationTable } from "./correlation.js";
import { TooComplexError } from "./copula.js";

const MAX_QUEUE = 16;
const TASK_TIMEOUT_MS = 1_000;

type Request = { id: number; legs: CorrLeg[]; table: CorrelationTable };
type Response = { id: number; value?: string; error?: "too-complex" | "pricing-unavailable"; cost?: number };

export class PricingUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "PricingUnavailableError"; }
}

interface Pending {
  resolve(value: bigint): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class CorrelationWorker {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly createWorker: () => Worker;

  constructor(createWorker: () => Worker = () => new Worker(`import("tsx/esm/api").then(({tsImport})=>tsImport(${JSON.stringify(import.meta.url)},${JSON.stringify(import.meta.url)}))`, { eval: true })) { this.createWorker = createWorker; }

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.unref();
    worker.on("message", (message: Response) => this.receive(message));
    worker.once("error", (error) => { if (this.worker === worker) this.failAll(new PricingUnavailableError(`worker error: ${error.message}`)); });
    worker.once("exit", (code) => { if (this.worker === worker) this.failAll(new PricingUnavailableError(`worker exited: ${code}`)); });
    this.worker = worker;
    return worker;
  }

  private receive(message: Response): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.value !== undefined) pending.resolve(BigInt(message.value));
    else if (message.error === "too-complex") pending.reject(new TooComplexError(message.cost ?? 4_000_001));
    else pending.reject(new PricingUnavailableError("worker pricing failed"));
  }

  private failAll(error: PricingUnavailableError): void {
    const worker = this.worker;
    this.worker = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (worker) void worker.terminate();
  }

  bestEstimate(legs: CorrLeg[], table: CorrelationTable): Promise<bigint> {
    if (this.pending.size >= MAX_QUEUE) return Promise.reject(new PricingUnavailableError("worker queue full"));
    const id = this.nextId++;
    return new Promise<bigint>((resolve, reject) => {
      const timer = setTimeout(() => this.failAll(new PricingUnavailableError("worker task timeout")), TASK_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try { this.start().postMessage({ id, legs, table } satisfies Request); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new PricingUnavailableError(`worker post failed: ${(error as Error).message}`));
      }
    });
  }

  close(): void { this.failAll(new PricingUnavailableError("worker closed")); }
}

if (!isMainThread) parentPort!.on("message", (request: Request) => {
  let response: Response;
  try { response = { id: request.id, value: riskAdjustedJointProbWad(request.legs, request.table, 0).toString() }; }
  catch (error) {
    response = error instanceof TooComplexError
      ? { id: request.id, error: "too-complex", cost: error.cost }
      : { id: request.id, error: "pricing-unavailable" };
  }
  parentPort!.postMessage(response);
});
