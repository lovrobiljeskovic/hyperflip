import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Abi } from "viem";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../../out");

function loadAbi(solFile: string, contractName: string): Abi {
  const p = path.join(outDir, solFile, `${contractName}.json`);
  const artifact = JSON.parse(readFileSync(p, "utf8")) as { abi: Abi };
  return artifact.abi;
}

export const parlayVaultAbi = loadAbi("ParlayVault.sol", "ParlayVault");
export const outcomeVaultAbi = loadAbi("OutcomeVault.sol", "OutcomeVault");
