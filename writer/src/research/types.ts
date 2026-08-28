export interface SourceSession {
  timeZone: string;
  weekdays: number[];
  openLocal: string;
  closeLocal: string;
  closedDates: string[];
}

export interface SourceEntry {
  schemaVersion: 1;
  underlying: string;
  sourceNetwork: "mainnet";
  sourceCoin: string;
  cluster: "crypto" | "equity" | "commodity";
  calendar: "continuous" | "session";
  session?: SourceSession;
  eligible: boolean;
  fallbackEligible: boolean;
}

export interface SourceRegistry {
  schemaVersion: 1;
  sources: SourceEntry[];
}

export interface CandleRecord {
  schemaVersion: 1;
  source: "hyperliquid-info";
  sourceNetwork: "mainnet";
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
  schemaVersion: 1;
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

export interface CorrelationArtifact {
  schemaVersion: 1;
  modelVersion: string;
  modelFamily: "hierarchical-gaussian-factor";
  createdAt: string;
  dataAsOf: string;
  dataManifestSha256: string;
  sourceRegistrySha256: string;
  policy: {
    lookbackDays: 180;
    halfLifeDays: 45;
    diagnosticWindowsDays: [30, 90, 180];
    minHourly: 1000;
    minDaily: 90;
    minCoverage: 0.8;
    maxProjectionError: 0.10;
  };
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

export interface QuoteDecision {
  schemaVersion: 1;
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

export interface ChainLogRecord {
  schemaVersion: 1;
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
  schemaVersion: 1;
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
  schemaVersion: 1;
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

export function assertCandleRecord(record: CandleRecord): void {
  assertSafeIntegerTimestamp(record.openTimeMs, "openTimeMs");
  assertSafeIntegerTimestamp(record.closeTimeMs, "closeTimeMs");
  assertSafeIntegerTimestamp(record.retrievedAtMs, "retrievedAtMs");
}

export function assertExclusionRecord(record: ExclusionRecord): void {
  if (record.timestampMs !== null) assertSafeIntegerTimestamp(record.timestampMs, "timestampMs");
}

export function assertDataManifest(record: DataManifest): void {
  assertSha256(record.sourceRegistrySha256, "sourceRegistrySha256");
  assertSafeIntegerTimestamp(record.sourceRange.fromMs, "sourceRange.fromMs");
  assertSafeIntegerTimestamp(record.sourceRange.toMs, "sourceRange.toMs");
  for (const [underlying, observations] of Object.entries(record.underlyings)) {
    if (observations.firstUsableObservationMs !== null) assertSafeIntegerTimestamp(observations.firstUsableObservationMs, `underlyings.${underlying}.firstUsableObservationMs`);
    if (observations.lastUsableObservationMs !== null) assertSafeIntegerTimestamp(observations.lastUsableObservationMs, `underlyings.${underlying}.lastUsableObservationMs`);
    for (const timestampMs of observations.missingIntervals) assertSafeIntegerTimestamp(timestampMs, `underlyings.${underlying}.missingIntervals`);
  }
  for (const file of record.files) assertSha256(file.sha256, "files.sha256");
}

export function assertCorrelationArtifact(record: CorrelationArtifact): void {
  assertSha256(record.dataManifestSha256, "dataManifestSha256");
  assertSha256(record.sourceRegistrySha256, "sourceRegistrySha256");
  for (const [underlying, timestampMs] of Object.entries(record.quality.lastUsableObservationMs)) {
    if (timestampMs !== null) assertSafeIntegerTimestamp(timestampMs, `quality.lastUsableObservationMs.${underlying}`);
  }
}

export function assertQuoteDecision(record: QuoteDecision): void {
  assertSafeIntegerTimestamp(record.recordedAtMs, "recordedAtMs");
  for (const input of record.bookInputs) assertSafeIntegerTimestamp(input.observedAtMs, "bookInputs.observedAtMs");
  assertSha256(record.dataManifestSha256, "dataManifestSha256");
  assertSha256(record.sourceRegistrySha256, "sourceRegistrySha256");
  assertSha256(record.signatureHash, "signatureHash");
}

export function assertJoinedEventRecord(record: JoinedEventRecord): void {
  assertSafeIntegerTimestamp(record.recordedAtMs, "recordedAtMs");
}

const CLUSTERS = new Set<SourceEntry["cluster"]>(["crypto", "equity", "commodity"]);
const CALENDARS = new Set<SourceEntry["calendar"]>(["continuous", "session"]);
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

function parseSource(value: unknown): SourceEntry {
  const source = object(value, "source");
  exactKeys(source, "source", ["schemaVersion", "underlying", "sourceNetwork", "sourceCoin", "cluster", "calendar", "session", "eligible", "fallbackEligible"]);
  if (source.schemaVersion !== 1) fail("source.schemaVersion must be 1");
  const underlying = text(source.underlying, "source.underlying");
  const sourceCoin = text(source.sourceCoin, "source.sourceCoin");
  if (source.sourceNetwork !== "mainnet") fail("source.sourceNetwork must be mainnet");
  if (!CLUSTERS.has(source.cluster as SourceEntry["cluster"])) fail("source.cluster is invalid");
  if (!CALENDARS.has(source.calendar as SourceEntry["calendar"])) fail("source.calendar is invalid");
  if (typeof source.eligible !== "boolean" || typeof source.fallbackEligible !== "boolean") fail("source eligibility flags must be booleans");
  const calendar = source.calendar as SourceEntry["calendar"];
  if (calendar === "continuous") {
    if ("session" in source) fail("continuous source must omit session");
    return { schemaVersion: 1, underlying, sourceNetwork: "mainnet", sourceCoin, cluster: source.cluster as SourceEntry["cluster"], calendar, eligible: source.eligible, fallbackEligible: source.fallbackEligible };
  }
  if (!("session" in source)) fail("session source requires session");
  return { schemaVersion: 1, underlying, sourceNetwork: "mainnet", sourceCoin, cluster: source.cluster as SourceEntry["cluster"], calendar, session: parseSession(source.session), eligible: source.eligible, fallbackEligible: source.fallbackEligible };
}

export function parseSourceRegistry(raw: string): SourceRegistry {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("must be valid JSON");
  }
  const registry = object(value, "registry");
  exactKeys(registry, "registry", ["schemaVersion", "sources"]);
  if (registry.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (!Array.isArray(registry.sources)) fail("sources must be an array");
  if (registry.sources.length > 20) fail("at most 20 underlyings are allowed");
  const sources = registry.sources.map(parseSource);
  const underlyings = new Set<string>();
  const sourceCoins = new Set<string>();
  for (const source of sources) {
    if (underlyings.has(source.underlying)) fail(`duplicate underlying ${source.underlying}`);
    const sourceKey = `${source.sourceNetwork}:${source.sourceCoin}`;
    if (sourceCoins.has(sourceKey)) fail(`duplicate source coin ${source.sourceCoin}`);
    underlyings.add(source.underlying);
    sourceCoins.add(sourceKey);
  }
  return { schemaVersion: 1, sources };
}

export function sourceFor(registry: SourceRegistry, underlying: string): SourceEntry | undefined {
  return registry.sources.find((source) => source.underlying === underlying);
}
