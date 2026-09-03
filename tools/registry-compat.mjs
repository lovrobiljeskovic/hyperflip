// Pure market-registry compatibility check shared by writer startup (writer/src/config.ts) and
// rotation preflight (rotate-lib.mjs). No I/O; plain JS so the rotation tools can import it
// without a TypeScript loader. Tested by rotate-lib.test.mjs and the writer suite.

/** Compare live market entries against the taxonomy a champion was fitted on.
 *
 * `champion` is the parsed champion/candidate artifact (`clusters`, `quality.quarantinedUnderlyings`),
 * `sources` the parsed source registry it was calibrated against, `markets` the live registry
 * entries. Vault address, outcome coins, title, strike, and expiry never matter here: only the
 * underlying, its cluster, and the direction semantics the model understands. One verdict per
 * market, so an incompatible market is refused on its own tickets while the champion keeps
 * pricing every market that still matches. */
export function registryCompatibility(champion, sources, markets) {
  const championCluster = new Map();
  for (const [cluster, entries] of Object.entries(champion.clusters)) {
    for (const underlying of Object.keys(entries)) championCluster.set(underlying, cluster);
  }
  const sourceCluster = new Map(sources.sources.map((source) => [source.underlying, source.cluster]));
  const quarantined = new Set((champion.quality?.quarantinedUnderlyings ?? []).map((entry) => entry.underlying));
  return markets.map(({ vault, underlying, cluster, direction }) => {
    const reason = quarantined.has(underlying) ? "quarantined-underlying"
      : !championCluster.has(underlying) ? "unknown-underlying"
      : championCluster.get(underlying) !== cluster || sourceCluster.get(underlying) !== cluster ? "cluster-remapped"
      : direction !== "up" && direction !== "down" ? "direction-unsupported"
      : null;
    return { vault, underlying, cluster, direction, compatible: reason === null, reason };
  });
}
