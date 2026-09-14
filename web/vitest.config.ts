import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { loadDeployment } from "./deployment/deployment.mts";

const deployment = loadDeployment({});

export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts"],
    // contracts.ts reads these at module load and throws when they are missing,
    // so anything importing it needs them present before the import runs.
    env: {
      DEPLOYMENT_FILE: fileURLToPath(new URL("./deployment/deployment.testnet.json", import.meta.url)),
      NEXT_PUBLIC_CHAIN_ID: String(deployment.chainId),
      NEXT_PUBLIC_PARLAY_VAULT: deployment.parlayVault,
      NEXT_PUBLIC_PARLAY_DEPLOY_BLOCK: String(deployment.deployBlock),
    },
  },
});
