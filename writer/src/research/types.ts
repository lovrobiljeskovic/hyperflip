export interface SourceSession {
  timeZone: string;
  weekdays: number[];
  openLocal: string;
  closeLocal: string;
  closedDates: string[];
}

export type ResearchNetwork = "testnet" | "mainnet";

export type ResearchOperation = "collect" | "calibrate" | "replay" | "join" | "report" | "promote" | "backup" | "daily";

export interface OperationRunRecord {
  schemaVersion: 1;
  network: ResearchNetwork;
  runId: string;
  operation: ResearchOperation;
  phase: "start" | "terminal";
  startedAt: string;
  endedAt?: string;
  status?: "success" | "failure";
  stage?: string;
  detail?: Record<string, string | number | boolean | null>;
  error?: string;
}

const ENABLED_RESEARCH_NETWORKS = new Set<ResearchNetwork>(["testnet"]);

export function assertResearchNetworkEnabled(network: ResearchNetwork): void {
  if (!ENABLED_RESEARCH_NETWORKS.has(network)) throw new Error(`network ${network} is not enabled`);
}

export interface SourceEntry {
  schemaVersion: 1;
  underlying: string;
  sourceNetwork: ResearchNetwork;
  sourceCoin: string;
  cluster: "crypto" | "equity" | "commodity";
  calendar: "continuous" | "session";
  session?: SourceSession;
  measurementEnabled: boolean;
  fallbackEligible: boolean;
}

export interface SourceRegistry {
  schemaVersion: 2;
  network: ResearchNetwork;
  sources: SourceEntry[];
}

export interface CandleRecord {
  schemaVersion: 1;
  source: "hyperliquid-info";
  sourceNetwork: ResearchNetwork;
  underlying: string;
  sourceCoin: string;
  interval: "1h";
  openTimeMs: number;
  closeTimeMs: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  tradeCount: number;
  retrievedAtMs: number;
}

export interface CandleRequestJournal {
  schemaVersion: 2;
  sourceKey: string;
  network: ResearchNetwork;
  profileSha256: string | null;
  startTimeMs: number;
  endTimeMs: number;
  retrievedAtMs: number;
  httpStatus: number | null;
  error: string | null;
  returnedRows: number;
  ignoredBefore: number;
  ignoredAfter: number;
}

export interface CandleRawManifest {
  schemaVersion: 2;
  sourceRegistrySha256: string;
  network: ResearchNetwork;
  profileSha256: string;
  startTimeMs: number;
  endTimeMs: number;
  ignoredBefore: number;
  ignoredAfter: number;
}

export type ReturnMode = "hourly" | "daily";

export interface ReturnRecord {
  schemaVersion: 2;
  transformationVersion: "returns-v2";
  network: ResearchNetwork;
  underlying: string;
  interval: ReturnMode;
  timestampMs: number;
  observationCloseTimeMs: number;
  sessionDate: string;
  value: number;
  sourceKeys: string[];
}

export interface DerivedManifestV2 {
  schemaVersion: 2;
  network: ResearchNetwork;
  transformationVersion: "returns-v2";
  dataManifestSha256: string;
  sourceRegistrySha256: string;
  window: { asOfMs: number; lookbackMs: number };
  returns: { path: string; sha256: string; rows: number };
  exclusions: { path: string; sha256: string; rows: number };
}

export interface ExclusionRecord {
  schemaVersion: 1;
  stage: "collect" | "returns" | "calibration" | "replay";
  underlying: string;
  peerUnderlying: string | null;
  timestampMs: number | null;
  reason:
    | "missing-interval"
    | "non-positive-close"
    | "stale-session-bar"
    | "no-synchronized-peer"
    | "insufficient-sample"
    | "coverage-below-80pct"
    | "conflicting-observation"
    | "ineligible-source"
    | "insufficient-stress-sample"
    | "projection-failure"
    | "structurally-unavailable";
  sourceKeys: string[];
}

export interface DataManifest {
  schemaVersion: 2;
  network: ResearchNetwork;
  profileSha256: string;
  createdAt: string;
  sourceRegistrySha256: string;
  sourceRange: { fromMs: number; toMs: number };
  underlyings: Record<string, {
    rows: number;
    firstUsableObservationMs: number | null;
    lastUsableObservationMs: number | null;
    missingIntervals: number[];
  }>;
  files: { path: string; bytes: number; sha256: string; rows: number; schemaVersion: 1 }[];
}

export interface PairRecord {
  pair: [string, string];
  correlation: number;
  reason: "testnet-quality-passed" | "operator-reviewed-testnet-bootstrap";
}

export interface QuarantinedPairRecord {
  pair: [string, string];
  reason: string;
}

export interface LegacyFitPolicy {
  lookbackDays: 180;
  halfLifeDays: 45;
  diagnosticWindowsDays: [30, 90, 180];
  minHourly: 1000;
  minDaily: 90;
  minCoverage: 0.8;
  maxProjectionError: 0.10;
}

/** Fixed candidate policy approved by the repository owner on 2026-09-03 (R0). Immutable artifact
 * evidence, not a runtime switch: changing any value requires fresh approval and a new candidate. */
export interface ApprovedFitPolicy extends LegacyFitPolicy {
  maxDirectResidual: 0.05;
  fisherCoverage: 0.95;
  fisherAdjustment: "bonferroni";
  omegaFallback: 30;
  fallbackResidualRange: 0.15;
  vMax: 0.99;
  underlyingBasis: "structural-underlying";
}

export const LEGACY_FIT_POLICY: LegacyFitPolicy = { lookbackDays: 180, halfLifeDays: 45, diagnosticWindowsDays: [30, 90, 180], minHourly: 1000, minDaily: 90, minCoverage: 0.8, maxProjectionError: 0.10 };
export const APPROVED_FIT_POLICY: ApprovedFitPolicy = { ...LEGACY_FIT_POLICY, maxDirectResidual: 0.05, fisherCoverage: 0.95, fisherAdjustment: "bonferroni", omegaFallback: 30, fallbackResidualRange: 0.15, vMax: 0.99, underlyingBasis: "structural-underlying" };

/** Per-pair immutable evidence for a fitted candidate: what the fit targeted, how much it was
 * trusted, the Fisher interval it had to land in, what it produced, and the gate verdict. */
export interface PairEvidenceRecord {
  pair: [string, string];
  evidence: "direct" | "fallback" | "quarantined";
  mode: ReturnMode | null;
  effectiveN: number | null;
  weight: number;
  target: number | null;
  interval: { lower: number; upper: number; adjustedLower: number; adjustedUpper: number; m: number } | null;
  fitted: number | null;
  residual: number | null;
  gate: { passed: boolean; reason: string };
}

interface CorrelationArtifactBase {
  network: ResearchNetwork;
  profileSha256: string;
  modelVersion: string;
  createdAt: string;
  dataAsOf: string;
  dataManifestSha256: string;
  sourceRegistrySha256: string;
  marketRegistrySha256: string;
  deploymentRegistrySha256: string;
  baselineCorrelationSha256: string;
  directPairs: PairRecord[];
  fallbackPairs: PairRecord[];
  quarantinedPairs: QuarantinedPairRecord[];
  quality: {
    matrixOrder: string[];
    eligibleUnderlyings: string[];
    quarantinedUnderlyings: { underlying: string; reason: string }[];
    pairEligibility: { pair: [string, string]; status: "direct" | "fallback" | "quarantined"; reason: string }[];
    lastUsableObservationMs: Record<string, number | null>;
    pairDiagnostics: {
      pair: [string, string]; mode: string; observations: number; expected: number;
      coverage: number; effectiveN: number | null; raw: number | null;
      shrinkTarget: number; shrinkLambda: number; target: number; implied: number;
      residual: number; fallbackUsed: boolean;
    }[];
    maxProjectionError: number;
    highamProjectionDelta: number;
    clippedNegativePairs: { pair: [string, string]; target: number }[];
    signedPsdTarget: number[][];
    diagnosticMatrices: Record<"30" | "90" | "180", (number | null)[][]>;
  };
  validation: { status: "pending" };
  clusters: Record<string, Record<string, {
    global: number;
    cluster: number;
    underlying: number;
    underlyingBasis: "structural-underlying";
  }>>;
}

/** Read-only historical evidence. Parses and reports, never activates. */
export interface LegacyCorrelationArtifact extends CorrelationArtifactBase {
  schemaVersion: 2;
  modelFamily: "hierarchical-gaussian-factor";
  policy: LegacyFitPolicy;
}

/** The only activation-eligible model. Signed loading ranges land with the R3 fitter. */
export interface FittedCorrelationArtifact extends CorrelationArtifactBase {
  schemaVersion: 3;
  modelFamily: "signed-asset-factor";
  policy: ApprovedFitPolicy;
  pairEvidence: PairEvidenceRecord[];
}

export type CorrelationArtifact = LegacyCorrelationArtifact | FittedCorrelationArtifact;

interface QuoteDecisionBase {
  network: ResearchNetwork;
  profileSha256: string;
  deploymentRegistrySha256: string;
  baselineCorrelationSha256: string;
  artifactKind: "champion" | "profile-baseline";
  artifactSha256: string;
  validationSha256: string | null;
  validationState: "Supported" | "Unavailable";
  pairDecisions: { pair: [string, string]; status: "direct" | "fallback" | "quarantined"; reason: string; correlation: number; evidenceCorrelation: number | null }[];
  recordedAtMs: number;
  quoteId: string;
  quoteDigest: string;
  chainId: number;
  parlayVault: string;
  taker: string;
  legs: { vault: string; isYes: boolean; underlying: string; cluster: string; direction: "up" | "down" | "band"; outcomeCoin: string }[];
  bookInputs: {
    priceWad: string;
    source: "l2Book" | "spotPx";
    observedAtMs: number;
    depthWad: string | null;
    vwapWad: string | null;
    freshnessMs: number | null;
  }[];
  modelVersion: string;
  dataAsOf: string;
  dataManifestSha256: string;
  sourceRegistrySha256: string;
  bestEstimateJointProbWad: string;
  riskAdjustedJointProbWad: string;
  rhoBandPct: number;
  edge: { baseBps: string; legBps: string; totalBps: string };
  premium: string;
  maxPayout: string;
  deadline: string;
  signatureHash: string;
}

/** Quote written by the correlation-band runtime against one registry hash. */
export interface LegacyQuoteDecision extends QuoteDecisionBase {
  schemaVersion: 3;
  marketRegistrySha256: string;
}

/** Quote written by the point-model runtime (R5): records the champion's candidate-time registry
 * and the live registry separately so a later rotation never makes the quote ambiguous. */
export interface PointModelQuoteDecision extends QuoteDecisionBase {
  schemaVersion: 4;
  championMarketRegistrySha256: string;
  liveMarketRegistrySha256: string;
  pricingMode: "point-model";
}

export type QuoteDecision = LegacyQuoteDecision | PointModelQuoteDecision;

export function liveMarketRegistrySha256(quote: QuoteDecision): string {
  return quote.schemaVersion === 4 ? quote.liveMarketRegistrySha256 : quote.marketRegistrySha256;
}

export interface ChainLogRecord {
  schemaVersion: 2;
  network: ResearchNetwork;
  profileSha256: string;
  deploymentRegistrySha256: string;
  kind: "minted" | "resolved";
  eventKey: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  quoteId: string;
  parlayId: string;
  taker: string | null;
  premium: string | null;
  maxPayout: string | null;
  status: "open" | "won" | "dead" | "void" | null;
  legs: { vault: string; isYes: boolean; settled: boolean; settleFractionWad: string | null; result: "win" | "loss" | "void" | "pending" }[];
  recordedAtMs: number;
}

export interface StateObservationRecord {
  schemaVersion: 2;
  network: ResearchNetwork;
  profileSha256: string;
  deploymentRegistrySha256: string;
  kind: "leg-finalized";
  observationKey: string;
  observedBlockNumber: string;
  observedBlockHash: string;
  quoteId: string;
  parlayId: string;
  vault: string;
  settleFractionWad: string;
  result: "win" | "loss" | "void";
  recordedAtMs: number;
}

export interface OrphanCorrectionRecord {
  schemaVersion: 2;
  network: ResearchNetwork;
  profileSha256: string;
  deploymentRegistrySha256: string;
  kind: "orphaned";
  targetKind: "chain-log" | "state-observation";
  targetKey: string;
  detectedAtBlockNumber: string;
  canonicalBlockHash: string;
  recordedAtMs: number;
}

export type JoinedEventRecord = ChainLogRecord | StateObservationRecord | OrphanCorrectionRecord;

export function assertNever(value: never): never {
  throw new Error(`unexpected value: ${String(value)}`);
}

const SHA256 = /^[0-9a-f]{64}$/;

function assertSafeIntegerTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer millisecond timestamp`);
}

function assertSha256(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be a lowercase 64-character hex hash`);
}

export function assertCandleRecord(record: CandleRecord, expected?: Pick<SourceEntry, "sourceNetwork" | "underlying" | "sourceCoin">): void {
  if (record === null || typeof record !== "object" || Array.isArray(record)) throw new Error("invalid candle record");
  assertSafeIntegerTimestamp(record.openTimeMs, "openTimeMs");
  assertSafeIntegerTimestamp(record.closeTimeMs, "closeTimeMs");
  assertSafeIntegerTimestamp(record.retrievedAtMs, "retrievedAtMs");
  const keys = ["schemaVersion", "source", "sourceNetwork", "underlying", "sourceCoin", "interval", "openTimeMs", "closeTimeMs", "open", "high", "low", "close", "volume", "tradeCount", "retrievedAtMs"];
  if (record === null || typeof record !== "object" || Array.isArray(record)
    || Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))
    || record.schemaVersion !== 1 || record.source !== "hyperliquid-info"
    || typeof record.underlying !== "string" || !SAFE_FILENAME_ID.test(record.underlying)
    || typeof record.sourceCoin !== "string" || !record.sourceCoin || record.interval !== "1h") throw new Error("invalid candle record identity");
  if (record.sourceNetwork !== "testnet") throw new Error("invalid candle record network identity");
  if (expected && (record.sourceNetwork !== expected.sourceNetwork || record.underlying !== expected.underlying || record.sourceCoin !== expected.sourceCoin)) throw new Error("invalid candle record source identity");
  if (record.openTimeMs % 3_600_000 !== 0 || record.closeTimeMs - record.openTimeMs !== 3_600_000 - 1 || record.closeTimeMs >= record.retrievedAtMs) throw new Error("invalid candle record timestamps");
  const numeric = [record.open, record.high, record.low, record.close, record.volume];
  if (numeric.some((value) => typeof value !== "string" || !value.trim() || !Number.isFinite(Number(value)))
    || Number(record.volume) < 0 || Number(record.high) < Math.max(Number(record.open), Number(record.close))
    || Number(record.low) > Math.min(Number(record.open), Number(record.close))
    || !Number.isSafeInteger(record.tradeCount) || record.tradeCount < 0) throw new Error("invalid candle record values");
}

export function assertExclusionRecord(record: ExclusionRecord): void {
  const reasons = new Set<ExclusionRecord["reason"]>(["missing-interval", "non-positive-close", "stale-session-bar", "no-synchronized-peer", "insufficient-sample", "coverage-below-80pct", "conflicting-observation", "ineligible-source", "insufficient-stress-sample", "projection-failure", "structurally-unavailable"]);
  if (record.schemaVersion !== 1 || !["collect", "returns", "calibration", "replay"].includes(record.stage) || typeof record.underlying !== "string" || (record.peerUnderlying !== null && typeof record.peerUnderlying !== "string") || !reasons.has(record.reason) || !Array.isArray(record.sourceKeys) || record.sourceKeys.some((key) => typeof key !== "string")) throw new Error("invalid exclusion record");
  if (record.timestampMs !== null) assertSafeIntegerTimestamp(record.timestampMs, "timestampMs");
}

export function parseReturnRecord(value: unknown, expectedNetwork?: ResearchNetwork): ReturnRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid returns-v2 record: row must be an object");
  const row = value as Record<string, unknown>;
  const keys = ["schemaVersion", "transformationVersion", "network", "underlying", "interval", "timestampMs", "observationCloseTimeMs", "sessionDate", "value", "sourceKeys"];
  for (const key of Object.keys(row)) if (!keys.includes(key)) throw new Error(`invalid returns-v2 record: unknown field ${key}`);
  if (row.schemaVersion !== 2 || row.transformationVersion !== "returns-v2") throw new Error("invalid returns-v2 record: schemaVersion and transformationVersion are required");
  if (row.network !== "testnet" && row.network !== "mainnet") throw new Error("invalid returns-v2 record: network mismatch");
  assertResearchNetworkEnabled(row.network);
  if (expectedNetwork !== undefined && row.network !== expectedNetwork) throw new Error("invalid returns-v2 record: network mismatch");
  if (typeof row.underlying !== "string" || !SAFE_FILENAME_ID.test(row.underlying)) throw new Error("invalid returns-v2 record: underlying is invalid");
  if (row.interval !== "hourly" && row.interval !== "daily") throw new Error("invalid returns-v2 record: interval is invalid");
  if (!Number.isSafeInteger(row.timestampMs)) throw new Error("invalid returns-v2 record: timestampMs must be a safe integer");
  if (!Number.isSafeInteger(row.observationCloseTimeMs) || Number(row.observationCloseTimeMs) < Number(row.timestampMs)) throw new Error("invalid returns-v2 record: observationCloseTimeMs is required and must not precede timestampMs");
  if (typeof row.sessionDate !== "string" || !isCalendarDate(row.sessionDate)) throw new Error("invalid returns-v2 record: sessionDate is invalid");
  if (typeof row.value !== "number" || !Number.isFinite(row.value)) throw new Error("invalid returns-v2 record: value must be finite");
  if (!Array.isArray(row.sourceKeys) || row.sourceKeys.some((key) => typeof key !== "string")) throw new Error("invalid returns-v2 record: sourceKeys must be strings");
  return row as unknown as ReturnRecord;
}

export function assertDataManifest(record: DataManifest): void {
  if (record === null || typeof record !== "object" || Array.isArray(record)) throw new Error("DataManifest must be an object");
  assertSha256(record.sourceRegistrySha256, "sourceRegistrySha256");
  if (record.schemaVersion !== 2) throw new Error("DataManifest schemaVersion must be 2");
  if (!("network" in record)) throw new Error("DataManifest network is required");
  if (!("profileSha256" in record)) throw new Error("DataManifest profileSha256 is required");
  const keys = ["schemaVersion", "network", "profileSha256", "createdAt", "sourceRegistrySha256", "sourceRange", "underlyings", "files"];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) throw new Error("DataManifest has invalid fields");
  if (record.network !== "testnet") throw new Error("DataManifest network must be testnet");
  assertResearchNetworkEnabled(record.network);
  assertSha256(record.profileSha256, "profileSha256");
  if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)) || new Date(Date.parse(record.createdAt)).toISOString() !== record.createdAt) throw new Error("DataManifest createdAt must be an exact ISO timestamp");
  if (record.sourceRange === null || typeof record.sourceRange !== "object" || Array.isArray(record.sourceRange)
    || Object.keys(record.sourceRange).length !== 2 || !("fromMs" in record.sourceRange) || !("toMs" in record.sourceRange)) throw new Error("DataManifest sourceRange is invalid");
  assertSafeIntegerTimestamp(record.sourceRange.fromMs, "sourceRange.fromMs");
  assertSafeIntegerTimestamp(record.sourceRange.toMs, "sourceRange.toMs");
  if (record.sourceRange.fromMs > record.sourceRange.toMs) throw new Error("DataManifest sourceRange is reversed");
  if (record.underlyings === null || typeof record.underlyings !== "object" || Array.isArray(record.underlyings)) throw new Error("DataManifest underlyings must be an object");
  for (const [underlying, observations] of Object.entries(record.underlyings)) {
    if (observations === null || typeof observations !== "object" || Array.isArray(observations)
      || Object.keys(observations).length !== 4 || !["rows", "firstUsableObservationMs", "lastUsableObservationMs", "missingIntervals"].every((key) => key in observations)
      || !SAFE_FILENAME_ID.test(underlying) || !Number.isSafeInteger(observations.rows) || observations.rows < 0 || !Array.isArray(observations.missingIntervals)) throw new Error(`DataManifest underlying ${underlying} is invalid`);
    if (observations.firstUsableObservationMs !== null) assertSafeIntegerTimestamp(observations.firstUsableObservationMs, `underlyings.${underlying}.firstUsableObservationMs`);
    if (observations.lastUsableObservationMs !== null) assertSafeIntegerTimestamp(observations.lastUsableObservationMs, `underlyings.${underlying}.lastUsableObservationMs`);
    for (const timestampMs of observations.missingIntervals) assertSafeIntegerTimestamp(timestampMs, `underlyings.${underlying}.missingIntervals`);
  }
  if (!Array.isArray(record.files)) throw new Error("DataManifest files must be an array");
  for (const file of record.files) {
    if (file === null || typeof file !== "object" || Array.isArray(file) || Object.keys(file).length !== 5
      || !["path", "bytes", "sha256", "rows", "schemaVersion"].every((key) => key in file)
      || typeof file.path !== "string" || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !Number.isSafeInteger(file.rows) || file.rows < 0 || file.schemaVersion !== 1) throw new Error("DataManifest file is invalid");
    assertSha256(file.sha256, "files.sha256");
  }
}

export function assertCorrelationArtifact(record: CorrelationArtifact): void {
  assertSha256(record.dataManifestSha256, "dataManifestSha256");
  assertSha256(record.profileSha256, "profileSha256");
  assertSha256(record.sourceRegistrySha256, "sourceRegistrySha256");
  assertSha256(record.marketRegistrySha256, "marketRegistrySha256");
  assertSha256(record.deploymentRegistrySha256, "deploymentRegistrySha256");
  assertSha256(record.baselineCorrelationSha256, "baselineCorrelationSha256");
  for (const [underlying, timestampMs] of Object.entries(record.quality.lastUsableObservationMs)) {
    if (timestampMs !== null) assertSafeIntegerTimestamp(timestampMs, `quality.lastUsableObservationMs.${underlying}`);
  }
}

export function assertQuoteDecision(record: QuoteDecision): void {
  const value = record as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("quote decision must be an object");
  const object = value as Record<string, unknown>;
  if (object.schemaVersion !== 3 && object.schemaVersion !== 4) throw new Error("quote decision schemaVersion must be 3 (legacy) or 4");
  const keys = ["schemaVersion", "network", "profileSha256", "deploymentRegistrySha256", "baselineCorrelationSha256", "artifactKind", "artifactSha256", "validationSha256", "validationState", "pairDecisions", "recordedAtMs", "quoteId", "quoteDigest", "chainId", "parlayVault", "taker", "legs", "bookInputs", "modelVersion", "dataAsOf", "dataManifestSha256", "sourceRegistrySha256", "bestEstimateJointProbWad", "riskAdjustedJointProbWad", "rhoBandPct", "edge", "premium", "maxPayout", "deadline", "signatureHash",
    ...(object.schemaVersion === 4 ? ["championMarketRegistrySha256", "liveMarketRegistrySha256", "pricingMode"] : ["marketRegistrySha256"])];
  if (Object.keys(object).length !== keys.length || keys.some((key) => !(key in object))) throw new Error("quote decision has invalid fields");
  assertResearchNetworkEnabled(record.network);
  if (record.network !== "testnet") throw new Error("quote decision network must be testnet");
  assertSafeIntegerTimestamp(record.recordedAtMs, "recordedAtMs");
  if (!Number.isSafeInteger(record.chainId) || record.chainId < 1) throw new Error("chainId must be a positive safe integer");
  for (const key of ["quoteId", "quoteDigest", "parlayVault", "taker", "modelVersion", "dataAsOf", "bestEstimateJointProbWad", "riskAdjustedJointProbWad", "premium", "maxPayout", "deadline"] as const) {
    if (typeof record[key] !== "string" || !record[key]) throw new Error(`${key} must be a non-empty string`);
  }
  const dataAsOfMs = Date.parse(record.dataAsOf);
  if (!Number.isFinite(dataAsOfMs) || new Date(dataAsOfMs).toISOString() !== record.dataAsOf) throw new Error("dataAsOf must be an exact ISO timestamp");
  if (!Array.isArray(record.legs) || !Array.isArray(record.bookInputs) || !Array.isArray(record.pairDecisions)) throw new Error("quote decision arrays are invalid");
  for (const leg of record.legs) {
    if (leg === null || typeof leg !== "object" || Array.isArray(leg) || Object.keys(leg).length !== 6
      || !["vault", "isYes", "underlying", "cluster", "direction", "outcomeCoin"].every((key) => key in leg)
      || typeof leg.vault !== "string" || !leg.vault || typeof leg.isYes !== "boolean" || typeof leg.underlying !== "string" || !leg.underlying
      || (leg.cluster !== "crypto" && leg.cluster !== "equity" && leg.cluster !== "commodity")
      || (leg.direction !== "up" && leg.direction !== "down" && leg.direction !== "band") || typeof leg.outcomeCoin !== "string" || !leg.outcomeCoin) throw new Error("quote decision leg is invalid");
  }
  for (const input of record.bookInputs) {
    if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 6
      || !["priceWad", "source", "observedAtMs", "depthWad", "vwapWad", "freshnessMs"].every((key) => key in input)
      || typeof input.priceWad !== "string" || !input.priceWad || (input.source !== "l2Book" && input.source !== "spotPx")
      || (input.depthWad !== null && typeof input.depthWad !== "string") || (input.vwapWad !== null && typeof input.vwapWad !== "string")
      || (input.freshnessMs !== null && (!Number.isSafeInteger(input.freshnessMs) || input.freshnessMs < 0))) throw new Error("quote decision book input is invalid");
    assertSafeIntegerTimestamp(input.observedAtMs, "bookInputs.observedAtMs");
  }
  if (record.edge === null || typeof record.edge !== "object" || Array.isArray(record.edge) || Object.keys(record.edge).length !== 3
    || !["baseBps", "legBps", "totalBps"].every((key) => key in record.edge)
    || Object.values(record.edge).some((entry) => typeof entry !== "string" || !entry)) throw new Error("quote decision edge is invalid");
  if (typeof record.rhoBandPct !== "number" || !Number.isFinite(record.rhoBandPct)) throw new Error("rhoBandPct must be finite");
  assertSha256(record.profileSha256, "profileSha256");
  assertSha256(record.dataManifestSha256, "dataManifestSha256");
  assertSha256(record.sourceRegistrySha256, "sourceRegistrySha256");
  if (record.schemaVersion === 4) {
    assertSha256(record.championMarketRegistrySha256, "championMarketRegistrySha256");
    assertSha256(record.liveMarketRegistrySha256, "liveMarketRegistrySha256");
    if (record.pricingMode !== "point-model") throw new Error("pricingMode must be point-model");
    if (record.rhoBandPct !== 0) throw new Error("point-model rhoBandPct must be 0");
  } else {
    assertSha256(record.marketRegistrySha256, "marketRegistrySha256");
  }
  assertSha256(record.deploymentRegistrySha256, "deploymentRegistrySha256");
  assertSha256(record.baselineCorrelationSha256, "baselineCorrelationSha256");
  if (record.artifactKind !== "champion" && record.artifactKind !== "profile-baseline") throw new Error("artifactKind is invalid");
  assertSha256(record.artifactSha256, "artifactSha256");
  if (record.artifactKind === "champion") {
    if (record.validationState !== "Supported" || record.validationSha256 === null) throw new Error("champion validationState must be Supported");
    assertSha256(record.validationSha256, "validationSha256");
  } else if (record.validationState !== "Unavailable" || record.validationSha256 !== null || record.artifactSha256 !== record.baselineCorrelationSha256
    || (record.schemaVersion === 4 && record.championMarketRegistrySha256 !== record.liveMarketRegistrySha256)) {
    throw new Error("profile baseline decision identity is invalid");
  }
  const expectedPairs: string[] = [];
  const underlyings = [...new Set(record.legs.map((leg) => leg.underlying))].sort();
  for (let left = 0; left < underlyings.length; left++) for (let right = left + 1; right < underlyings.length; right++) expectedPairs.push(`${underlyings[left]}:${underlyings[right]}`);
  const recordedPairs: string[] = [];
  for (const pair of record.pairDecisions) {
    if (pair === null || typeof pair !== "object" || Array.isArray(pair) || Object.keys(pair).length !== 5
      || !["pair", "status", "reason", "correlation", "evidenceCorrelation"].every((key) => key in pair)
      || !Array.isArray(pair.pair) || pair.pair.length !== 2 || pair.pair.some((underlying) => typeof underlying !== "string" || !underlying) || pair.pair[0] >= pair.pair[1]) throw new Error("pairDecisions must use canonical pairs");
    if (pair.status !== "direct" && pair.status !== "fallback" && pair.status !== "quarantined") throw new Error("pairDecisions status is invalid");
    if (!pair.reason || typeof pair.correlation !== "number" || !Number.isFinite(pair.correlation)
      || (pair.status === "quarantined" ? pair.evidenceCorrelation !== null : typeof pair.evidenceCorrelation !== "number" || !Number.isFinite(pair.evidenceCorrelation))) throw new Error("pairDecisions evidence is invalid");
    recordedPairs.push(pair.pair.join(":"));
  }
  if (JSON.stringify(recordedPairs.sort()) !== JSON.stringify(expectedPairs)) throw new Error("pairDecisions must record every quoted underlying pair exactly once");
  assertSha256(record.signatureHash, "signatureHash");
}

export function assertJoinedEventRecord(record: JoinedEventRecord): void {
  const value = record as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("joined event record must be an object");
  const object = value as Record<string, unknown>;
  if (object.schemaVersion !== 2) throw new Error("joined event record schemaVersion must be 2");
  if (object.network !== "testnet" && object.network !== "mainnet") throw new Error("joined event record network is invalid");
  assertResearchNetworkEnabled(object.network);
  assertSha256(String(object.profileSha256), "profileSha256");
  assertSha256(String(object.deploymentRegistrySha256), "deploymentRegistrySha256");
  const kind = object.kind;
  if (kind === "minted" || kind === "resolved") {
    assertJoinedExactKeys(object, ["schemaVersion", "network", "profileSha256", "deploymentRegistrySha256", "kind", "eventKey", "blockNumber", "blockHash", "transactionHash", "logIndex", "quoteId", "parlayId", "taker", "premium", "maxPayout", "status", "legs", "recordedAtMs"]);
    assertJoinedString(object.eventKey, "eventKey");
    assertJoinedString(object.blockNumber, "blockNumber");
    assertJoinedString(object.blockHash, "blockHash");
    assertJoinedString(object.transactionHash, "transactionHash");
    if (!Number.isInteger(object.logIndex)) throw new Error("logIndex must be an integer");
    assertJoinedString(object.quoteId, "quoteId");
    assertJoinedString(object.parlayId, "parlayId");
    assertJoinedStringOrNull(object.taker, "taker");
    assertJoinedStringOrNull(object.premium, "premium");
    assertJoinedStringOrNull(object.maxPayout, "maxPayout");
    if (object.status !== null && object.status !== "open" && object.status !== "won" && object.status !== "dead" && object.status !== "void") throw new Error("status is invalid");
    if (!Array.isArray(object.legs)) throw new Error("legs must be an array");
    object.legs.forEach((leg) => {
      if (leg === null || typeof leg !== "object" || Array.isArray(leg)) throw new Error("leg must be an object");
      const legObject = leg as Record<string, unknown>;
      assertJoinedExactKeys(legObject, ["vault", "isYes", "settled", "settleFractionWad", "result"]);
      assertJoinedString(legObject.vault, "legs.vault");
      if (typeof legObject.isYes !== "boolean") throw new Error("legs.isYes must be a boolean");
      if (typeof legObject.settled !== "boolean") throw new Error("legs.settled must be a boolean");
      assertJoinedStringOrNull(legObject.settleFractionWad, "legs.settleFractionWad");
      if (legObject.result !== "win" && legObject.result !== "loss" && legObject.result !== "void" && legObject.result !== "pending") throw new Error("legs.result is invalid");
    });
  } else if (kind === "leg-finalized") {
    assertJoinedExactKeys(object, ["schemaVersion", "network", "profileSha256", "deploymentRegistrySha256", "kind", "observationKey", "observedBlockNumber", "observedBlockHash", "quoteId", "parlayId", "vault", "settleFractionWad", "result", "recordedAtMs"]);
    for (const key of ["observationKey", "observedBlockNumber", "observedBlockHash", "quoteId", "parlayId", "vault", "settleFractionWad"]) assertJoinedString(object[key], key);
    if (object.result !== "win" && object.result !== "loss" && object.result !== "void") throw new Error("result is invalid");
  } else if (kind === "orphaned") {
    assertJoinedExactKeys(object, ["schemaVersion", "network", "profileSha256", "deploymentRegistrySha256", "kind", "targetKind", "targetKey", "detectedAtBlockNumber", "canonicalBlockHash", "recordedAtMs"]);
    if (object.targetKind !== "chain-log" && object.targetKind !== "state-observation") throw new Error("targetKind is invalid");
    for (const key of ["targetKey", "detectedAtBlockNumber", "canonicalBlockHash"]) assertJoinedString(object[key], key);
  } else {
    throw new Error("joined event record kind is invalid");
  }
  assertJoinedTimestamp(object.recordedAtMs, "recordedAtMs");
}

function assertJoinedExactKeys(value: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) if (!(key in value)) throw new Error(`joined event record missing ${key}`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`joined event record has unknown field ${key}`);
}

function assertJoinedString(value: unknown, label: string): void {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
}

function assertJoinedStringOrNull(value: unknown, label: string): void {
  if (value !== null && typeof value !== "string") throw new Error(`${label} must be a string or null`);
}

function assertJoinedTimestamp(value: unknown, label: string): void {
  if (typeof value !== "number") throw new Error(`${label} must be a number`);
  assertSafeIntegerTimestamp(value, label);
}

const CLUSTERS = new Set<SourceEntry["cluster"]>(["crypto", "equity", "commodity"]);
const CALENDARS = new Set<SourceEntry["calendar"]>(["continuous", "session"]);
const SAFE_FILENAME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(message: string): never {
  throw new Error(`invalid source registry: ${message}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, label: string, keys: string[]): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label} has unknown field ${key}`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return value;
}

function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

function parseSession(value: unknown): SourceSession {
  const session = object(value, "session");
  exactKeys(session, "session", ["timeZone", "weekdays", "openLocal", "closeLocal", "closedDates"]);
  const timeZone = text(session.timeZone, "session.timeZone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    fail("session.timeZone must be an IANA time zone");
  }
  if (!Array.isArray(session.weekdays) || session.weekdays.length === 0 || session.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    fail("session.weekdays must contain weekday numbers 0 through 6");
  }
  if (new Set(session.weekdays).size !== session.weekdays.length) fail("session.weekdays must not contain duplicates");
  const openLocal = text(session.openLocal, "session.openLocal");
  const closeLocal = text(session.closeLocal, "session.closeLocal");
  if (!LOCAL_TIME.test(openLocal) || !LOCAL_TIME.test(closeLocal) || openLocal >= closeLocal) fail("session open/close must be ordered HH:MM values");
  if (!Array.isArray(session.closedDates) || session.closedDates.some((date) => typeof date !== "string" || !isCalendarDate(date))) {
    fail("session.closedDates must contain ISO calendar dates");
  }
  if (new Set(session.closedDates).size !== session.closedDates.length) fail("session.closedDates must not contain duplicates");
  return { timeZone, weekdays: [...session.weekdays], openLocal, closeLocal, closedDates: [...session.closedDates] };
}

function parseSource(value: unknown, network: ResearchNetwork): SourceEntry {
  const source = object(value, "source");
  exactKeys(source, "source", ["schemaVersion", "underlying", "sourceNetwork", "sourceCoin", "cluster", "calendar", "session", "measurementEnabled", "fallbackEligible"]);
  if (source.schemaVersion !== 1) fail("source.schemaVersion must be 1");
  const underlying = text(source.underlying, "source.underlying");
  if (!SAFE_FILENAME_ID.test(underlying)) fail("source.underlying must be a safe filename ID");
  const sourceCoin = text(source.sourceCoin, "source.sourceCoin");
  if (source.sourceNetwork !== network) fail(`source.sourceNetwork must be ${network}`);
  if (!CLUSTERS.has(source.cluster as SourceEntry["cluster"])) fail("source.cluster is invalid");
  if (!CALENDARS.has(source.calendar as SourceEntry["calendar"])) fail("source.calendar is invalid");
  if (typeof source.measurementEnabled !== "boolean" || typeof source.fallbackEligible !== "boolean") fail("source eligibility flags must be booleans");
  const calendar = source.calendar as SourceEntry["calendar"];
  if (calendar === "continuous") {
    if ("session" in source) fail("continuous source must omit session");
    return { schemaVersion: 1, underlying, sourceNetwork: network, sourceCoin, cluster: source.cluster as SourceEntry["cluster"], calendar, measurementEnabled: source.measurementEnabled, fallbackEligible: source.fallbackEligible };
  }
  if (!("session" in source)) fail("session source requires session");
  return { schemaVersion: 1, underlying, sourceNetwork: network, sourceCoin, cluster: source.cluster as SourceEntry["cluster"], calendar, session: parseSession(source.session), measurementEnabled: source.measurementEnabled, fallbackEligible: source.fallbackEligible };
}

export function parseSourceRegistry(raw: string): SourceRegistry {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("must be valid JSON");
  }
  const registry = object(value, "registry");
  exactKeys(registry, "registry", ["schemaVersion", "network", "sources"]);
  if (registry.schemaVersion !== 2) fail("schemaVersion must be 2");
  if (registry.network !== "testnet" && registry.network !== "mainnet") fail("network must be testnet or mainnet");
  if (!Array.isArray(registry.sources)) fail("sources must be an array");
  if (registry.sources.length > 20) fail("at most 20 underlyings are allowed");
  const network = registry.network;
  const sources = registry.sources.map((source) => parseSource(source, network));
  const underlyings = new Set<string>();
  const sourceCoins = new Set<string>();
  for (const source of sources) {
    if (underlyings.has(source.underlying)) fail(`duplicate underlying ${source.underlying}`);
    const sourceKey = `${source.sourceNetwork}:${source.sourceCoin}`;
    if (sourceCoins.has(sourceKey)) fail(`duplicate source coin ${source.sourceCoin}`);
    underlyings.add(source.underlying);
    sourceCoins.add(sourceKey);
  }
  return { schemaVersion: 2, network, sources };
}

export function sourceFor(registry: SourceRegistry, underlying: string): SourceEntry | undefined {
  return registry.sources.find((source) => source.underlying === underlying);
}
