export type RegistryIncompatibility = "unknown-underlying" | "quarantined-underlying" | "cluster-remapped" | "direction-unsupported";

export interface RegistryCompatibilityVerdict {
  vault: string;
  underlying: string;
  cluster: string;
  direction: string;
  compatible: boolean;
  reason: RegistryIncompatibility | null;
}

export function registryCompatibility(
  champion: { clusters: Record<string, Record<string, unknown>>; quality: { quarantinedUnderlyings: { underlying: string }[] } },
  sources: { sources: { underlying: string; cluster: string }[] },
  markets: { vault: string; underlying: string; cluster: string; direction: string }[],
): RegistryCompatibilityVerdict[];
