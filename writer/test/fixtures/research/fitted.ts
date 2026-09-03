import { pairEvidence } from "../../../src/research/matrix.js";
import { APPROVED_FIT_POLICY } from "../../../src/research/types.js";
import type { CorrelationArtifact, FittedCorrelationArtifact, PairEvidenceRecord } from "../../../src/research/types.js";

// Upgrades a legacy (schemaVersion 2) fixture to the activation-eligible schemaVersion 3 shape.
// Evidence is fixture evidence: fitted equals target, so every admitted gate passes. Intervals and
// weights come from the real R2 estimators; the R4 calibrator supplies real fitted values.
export function fittedArtifact(legacy: CorrelationArtifact): FittedCorrelationArtifact {
  const { schemaVersion: _schemaVersion, modelFamily: _modelFamily, policy: _policy, ...rest } = legacy as CorrelationArtifact & { pairEvidence?: unknown };
  delete (rest as { pairEvidence?: unknown }).pairEvidence;
  const directCount = legacy.quality.pairEligibility.filter((entry) => entry.status === "direct").length;
  const correlationFor = (pair: [string, string]): number | null =>
    [...legacy.directPairs, ...legacy.fallbackPairs].find((entry) => entry.pair[0] === pair[0] && entry.pair[1] === pair[1])?.correlation ?? null;
  const evidence: PairEvidenceRecord[] = legacy.quality.pairEligibility.map(({ pair, status, reason }) => {
    const target = correlationFor(pair);
    if (status === "direct" && target !== null) {
      return pairEvidence({ evidence: "direct", pair, mode: "hourly", target, effectiveN: 2_749, fitted: target, m: directCount });
    }
    if (status === "fallback" && target !== null) {
      return pairEvidence({ evidence: "fallback", pair, target, fitted: target });
    }
    return pairEvidence({ evidence: "quarantined", pair, reason });
  });
  const clusters: FittedCorrelationArtifact["clusters"] = {};
  for (const [cluster, entries] of Object.entries(legacy.clusters)) {
    clusters[cluster] = Object.fromEntries(Object.entries(entries).map(([underlying, loading]) => [underlying, {
      ...loading, underlying: Math.sqrt(APPROVED_FIT_POLICY.vMax - loading.global ** 2 - loading.cluster ** 2),
    }]));
  }
  return { ...rest, schemaVersion: 3, modelFamily: "signed-asset-factor", policy: structuredClone(APPROVED_FIT_POLICY), clusters, pairEvidence: evidence };
}
