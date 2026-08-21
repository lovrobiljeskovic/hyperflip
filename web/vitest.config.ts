import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts"],
    // contracts.ts reads these at module load and throws when they are missing,
    // so anything importing it needs them present before the import runs.
    env: {
      NEXT_PUBLIC_PARLAY_VAULT: "0x407CDc0B15E8d81f4D122481Ecf92Dbe07DC0169",
      NEXT_PUBLIC_PARLAY_DEPLOY_BLOCK: "61907400",
    },
  },
});
