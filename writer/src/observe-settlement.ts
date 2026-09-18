import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { BaseError, ExecutionRevertedError, createPublicClient, decodeAbiParameters, encodeAbiParameters, http, type PublicClient } from "viem";

// S2b's existing, funded probe. This process only reads; it has no signing key.
const PROBE = "0x614992bbbe2BA4a35DC625b29FC66dCbCfe9FA6E";
const OUTCOME = 19467;
const uint64s = [{ type: "uint64" }, { type: "uint64" }, { type: "uint64" }] as const;

export function observationError(error: unknown): "revert" | "rpc-error" {
  const cause = error instanceof BaseError ? error.walk(e => e instanceof ExecutionRevertedError) : error;
  return cause instanceof ExecutionRevertedError ? "revert" : "rpc-error";
}

/** Sample live Core state. Never label a transport failure as protocol pruning. */
export async function observeSettlement(client: Pick<PublicClient, "call">) {
  const reads: object[] = [];
  const requests = [
    { name: "outcome", to: "0x0000000000000000000000000000000000000814" as const,
      data: encodeAbiParameters([{ type: "uint32" }], [OUTCOME]) },
    ...[0n, 100194670n, 100194671n].map(token => ({
      name: token.toString(), to: "0x0000000000000000000000000000000000000801" as const,
      data: encodeAbiParameters([{ type: "address" }, { type: "uint64" }], [PROBE, token]),
    })),
  ];
  for (const request of requests) {
    const startedAt = new Date().toISOString();
    try {
      const { data } = await client.call({ to: request.to, data: request.data });
      if (!data) throw new Error("empty response");
      const values = request.name === "outcome"
        ? decodeAbiParameters([{ type: "uint8" }, { type: "uint64" }, { type: "uint32" }], data)
        : decodeAbiParameters(uint64s, data);
      reads.push({ name: request.name, startedAt, observedAt: new Date().toISOString(), ok: true,
        ...(request.name === "outcome"
          ? { status: Number(values[0]), settledValue: String(values[1]), question: Number(values[2]) }
          : { total: String(values[0]), hold: String(values[1]), entryNtl: String(values[2]) }) });
    } catch (error) {
      // No raw RPC errors: viem errors can contain the private endpoint URL.
      reads.push({ name: request.name, startedAt, observedAt: new Date().toISOString(), ok: false, error: observationError(error) });
    }
  }
  return { event: "settlement-observation", at: new Date().toISOString(), chainId: 998, outcome: OUTCOME, probe: PROBE, reads };
}

export async function requireTestnet(client: Pick<PublicClient, "getChainId">) {
  if (await client.getChainId() !== 998) throw new Error("observer requires testnet chain 998");
}

async function main() {
  const url = process.env.WRITER_RPC?.split(",")[0].trim();
  if (!url) throw new Error("WRITER_RPC required");
  const client = createPublicClient({ transport: http(url, { timeout: 10_000, retryCount: 0 }) });
  await requireTestnet(client);
  console.log(JSON.stringify({ event: "observer-started", at: new Date().toISOString(), chainId: 998, outcome: OUTCOME, probe: PROBE }));
  // Continue after pruning to observe delayed credit and distinguish transient
  // RPC failures. systemd controls lifetime and persists JSONL output.
  while (true) {
    const start = Date.now();
    console.log(JSON.stringify(await observeSettlement(client)));
    await setTimeout(Math.max(1_000, 60_000 - (Date.now() - start)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(JSON.stringify({ event: "observer-startup-failed", at: new Date().toISOString(), error: "check testnet RPC configuration/connectivity" }));
    process.exitCode = 1;
  });
}
