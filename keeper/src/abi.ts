import { readFileSync } from "node:fs";
import type { Abi } from "viem";

function loadAbi(name: string): Abi {
  return JSON.parse(readFileSync(new URL(`../abi/${name}.json`, import.meta.url), "utf8"));
}

export const outcomeVaultAbi = loadAbi("OutcomeVault");
export const keeperVerifierAbi = loadAbi("KeeperVerifier");
