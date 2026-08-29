import { randomUUID } from "node:crypto";
import { canonicalJson } from "./store.js";
import type { ResearchPersistence } from "./persistence.js";
import { assertResearchNetworkEnabled, type OperationRunRecord, type ResearchNetwork, type ResearchOperation } from "./types.js";

const OPERATIONS = new Set<ResearchOperation>(["collect", "calibrate", "replay", "join", "report", "promote", "backup", "daily"]);
const RUN_ID = /^[0-9]{8}T[0-9]{9}Z-[0-9a-f-]{36}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const SECRET = /(?:api[-_ ]?key|authorization|cookie|password|private[-_ ]?key|secret|token|\b(?:env|process)\.[A-Z_]+)/i;
const VALUE_LIMIT = 256;
const ERROR_LIMIT = 1_000;
const DETAIL_KEYS: Record<ResearchOperation, readonly string[]> = {
  collect: ["accepted", "conflicts", "failures"], calibrate: ["modelVersion", "dataManifestSha256", "candidatePath"], replay: ["modelVersion", "decision", "validationPath"],
  join: ["appended", "resolutions", "nextBlock"], report: ["path", "sha256"], promote: ["modelVersion", "dataAgeMs", "dataManifestSha256", "validationState", "championSha256"],
  backup: ["uploaded", "skipped", "verified", "lastVerifiedObjectHash"], daily: [],
};

function timestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) throw new Error(`operation ${label} is invalid`);
}

function publicText(value: string, label: string, limit: number): void {
  if (!value || value.length > limit) throw new Error(`operation ${label} is invalid`);
  if (CONTROL.test(value)) throw new Error(`operation ${label} contains control characters`);
  if (SECRET.test(value)) throw new Error(`operation ${label} contains a secret`);
}

function validateDetail(operation: ResearchOperation, detail: unknown): asserts detail is Record<string, string | number | boolean | null> {
  if (detail === undefined) return;
  if (detail === null || typeof detail !== "object" || Array.isArray(detail) || Object.keys(detail).length > 12) throw new Error("operation detail is invalid");
  for (const [key, value] of Object.entries(detail)) {
    if (!DETAIL_KEYS[operation].includes(key)) throw new Error("operation detail key is invalid");
    publicText(key, "detail key", 64);
    if (typeof value === "string") publicText(value, "detail", VALUE_LIMIT);
    else if (typeof value === "number" && !Number.isFinite(value)) throw new Error("operation detail is invalid");
    else if (typeof value !== "number" && typeof value !== "boolean" && value !== null) throw new Error("operation detail is invalid");
  }
}

export function operationRunPath(record: Pick<OperationRunRecord, "runId" | "startedAt" | "phase">): string {
  timestamp(record.startedAt, "startedAt");
  if (!RUN_ID.test(record.runId)) throw new Error("operation runId is invalid");
  const [year, month, day] = record.startedAt.slice(0, 10).split("-");
  return `journal/operations/${year}/${month}/${day}/${record.runId}.${record.phase}.json`;
}

export function assertOperationRunRecord(record: unknown): asserts record is OperationRunRecord {
  if (record === null || typeof record !== "object" || Array.isArray(record)) throw new Error("operation record is invalid");
  const row = record as Record<string, unknown>;
  const allowed = ["schemaVersion", "network", "runId", "operation", "phase", "startedAt", "endedAt", "status", "stage", "detail", "error"];
  if (Object.keys(row).some((key) => !allowed.includes(key)) || row.schemaVersion !== 1 || (row.network !== "testnet" && row.network !== "mainnet") || typeof row.runId !== "string" || !OPERATIONS.has(row.operation as ResearchOperation) || (row.phase !== "start" && row.phase !== "terminal")) throw new Error("operation record is invalid");
  assertResearchNetworkEnabled(row.network);
  timestamp(row.startedAt, "startedAt");
  operationRunPath(row as Pick<OperationRunRecord, "runId" | "startedAt" | "phase">);
  validateDetail(row.operation as ResearchOperation, row.detail);
  if (row.stage !== undefined) {
    if (typeof row.stage !== "string") throw new Error("operation stage is invalid");
    publicText(row.stage, "stage", 64);
  }
  if (row.error !== undefined) {
    if (typeof row.error !== "string") throw new Error("operation error is invalid");
    publicText(row.error, "error", ERROR_LIMIT);
  }
  if (row.phase === "start") {
    if ("endedAt" in row || "status" in row || "stage" in row || "detail" in row || "error" in row) throw new Error("operation start record is invalid");
  } else {
    timestamp(row.endedAt, "endedAt");
    if (row.status !== "success" && row.status !== "failure") throw new Error("operation terminal status is invalid");
    if (Date.parse(row.endedAt) < Date.parse(row.startedAt)) throw new Error("operation endedAt precedes startedAt");
    if (row.status === "failure" && row.error === undefined) throw new Error("operation failure error is required");
    if (row.status === "success" && row.error !== undefined) throw new Error("operation success cannot have an error");
  }
}

export function writeOperationRecord(storage: ResearchPersistence, record: OperationRunRecord): void {
  assertOperationRunRecord(record);
  const path = operationRunPath(record);
  const bytes = `${canonicalJson(record)}\n`;
  if (!storage.writeNew(path, bytes)) throw new Error("operation record already exists");
}

export function startOperation(storage: ResearchPersistence, network: ResearchNetwork, operation: ResearchOperation, nowMs = Date.now()): OperationRunRecord {
  const startedAt = new Date(nowMs).toISOString();
  const runId = `${startedAt.replace(/[-:.]/g, "")}-${randomUUID()}`;
  const record: OperationRunRecord = { schemaVersion: 1, network, runId, operation, phase: "start", startedAt };
  writeOperationRecord(storage, record);
  return record;
}

export function finishOperation(storage: ResearchPersistence, start: OperationRunRecord, terminal: { status: "success" | "failure"; endedAt?: string; stage?: string; detail?: OperationRunRecord["detail"]; error?: string }): OperationRunRecord {
  const record: OperationRunRecord = { ...start, phase: "terminal", endedAt: terminal.endedAt ?? new Date().toISOString(), status: terminal.status };
  if (terminal.stage !== undefined) record.stage = terminal.stage;
  if (terminal.detail !== undefined) record.detail = terminal.detail;
  if (terminal.error !== undefined) record.error = terminal.error;
  writeOperationRecord(storage, record);
  return record;
}

export function terminalOperationHistory(storage: ResearchPersistence, network: ResearchNetwork): OperationRunRecord[] {
  return storage.list("journal/operations").map((path) => {
    const record = JSON.parse(storage.readText(path)) as unknown;
    assertOperationRunRecord(record);
    if (record.network !== network) throw new Error("operation record network mismatch");
    if (record.phase === "start") return null;
    if (path !== operationRunPath(record)) throw new Error("operation record path mismatch");
    return record;
  }).filter((record): record is OperationRunRecord => record !== null);
}
