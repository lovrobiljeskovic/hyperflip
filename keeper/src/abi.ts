import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Abi } from "viem";

// ABIs come from forge build artifacts, never hand-copied — one JSON per
// contract under <repo root>/out/<File>.sol/<Contract>.json, with an `.abi` field.
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../../out");

function loadAbi(solFile: string, contractName: string): Abi {
  const p = path.join(outDir, solFile, `${contractName}.json`);
  const artifact = JSON.parse(readFileSync(p, "utf8")) as { abi: Abi };
  return artifact.abi;
}

export const outcomeVaultAbi = loadAbi("OutcomeVault.sol", "OutcomeVault");
export const keeperVerifierAbi = loadAbi("KeeperVerifier.sol", "KeeperVerifier");
