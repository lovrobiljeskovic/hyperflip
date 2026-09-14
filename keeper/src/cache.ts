import { readOptionalFile, replaceFile } from "../../services/files.mjs";
import { decodeFractionCache, encodeFractionCache } from "./pure.js";

export function loadFractionCache(file: string): Map<string, bigint> {
  const json = readOptionalFile(file);
  return json === undefined ? new Map() : decodeFractionCache(json);
}

export function saveFraction(cache: Map<string, bigint>, file: string, vault: string, fraction: bigint): void {
  // Keep the observation available to this process even if the disk fails.
  cache.set(vault.toLowerCase(), fraction);
  replaceFile(file, encodeFractionCache(cache));
}
