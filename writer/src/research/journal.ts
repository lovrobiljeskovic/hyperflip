import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { canonicalJson, durableAppend } from "./store.js";
import type { QuoteDecision } from "./types.js";

export interface PublicQuoteDecision extends Omit<QuoteDecision, "taker" | "quoteDigest" | "signatureHash" | "bookInputs" | "modelVersion" | "dataAsOf" | "dataManifestSha256" | "sourceRegistrySha256" | "bestEstimateJointProbWad" | "riskAdjustedJointProbWad" | "rhoBandPct" | "edge"> {
  taker: string;
  resolution: { status: "open" | "won" | "dead" | "void"; allLegsFinal: boolean };
  quoteDigest?: string;
  signatureHash?: string;
  bookInputs?: QuoteDecision["bookInputs"];
  modelVersion?: string;
  dataAsOf?: string;
  dataManifestSha256?: string;
  sourceRegistrySha256?: string;
  bestEstimateJointProbWad?: string;
  riskAdjustedJointProbWad?: string;
  rhoBandPct?: number;
  edge?: QuoteDecision["edge"];
}

function quoteJournalDir(root: string): string {
  return join(root, "journal", "quotes");
}

export function initializeQuoteJournal(root: string): void {
  const directory = quoteJournalDir(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

export function appendQuoteDecision(root: string, decision: QuoteDecision): void {
  initializeQuoteJournal(root);
  const date = new Date(decision.recordedAtMs);
  const file = join(quoteJournalDir(root), String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, "0"), `${String(date.getUTCDate()).padStart(2, "0")}.jsonl`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  const fd = openSync(file, "a", 0o600);
  closeSync(fd);
  chmodSync(file, 0o600);
  durableAppend(file, canonicalJson(decision));
  chmodSync(file, 0o600);
  const directory = openSync(dirname(file), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function redactQuoteDecision(
  decision: QuoteDecision,
  resolution: PublicQuoteDecision["resolution"],
  salt: string,
): PublicQuoteDecision {
  if (!salt) throw new Error("export salt is required");
  const { taker, quoteDigest, signatureHash, bookInputs, modelVersion, dataAsOf, dataManifestSha256, sourceRegistrySha256, bestEstimateJointProbWad, riskAdjustedJointProbWad, rhoBandPct, edge, ...publicDecision } = decision;
  const redacted: PublicQuoteDecision = {
    ...publicDecision,
    taker: createHash("sha256").update(`${salt}:${taker.toLowerCase()}`).digest("hex"),
    resolution,
  };
  if (!resolution.allLegsFinal) return redacted;
  return {
    ...redacted,
    quoteDigest,
    signatureHash,
    bookInputs,
    modelVersion,
    dataAsOf,
    dataManifestSha256,
    sourceRegistrySha256,
    bestEstimateJointProbWad,
    riskAdjustedJointProbWad,
    rhoBandPct,
    edge,
  };
}
