import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteDigest, type ParlayQuote } from "../src/quotes.js";

// Vector from test/QuoteDigestVector.t.sol (forge test --match-test test_quoteDigestVector -vv).
const VAULT = "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f" as const;
const FORGE_DIGEST = "0x538daa513e74bc97f666f097c513700d7f35eec2c77c18e1da82259be34e07e8" as const;

const q: ParlayQuote = {
  taker: "0x3333333333333333333333333333333333333333",
  legs: [
    { vault: "0x1111111111111111111111111111111111111111", isYes: true },
    { vault: "0x2222222222222222222222222222222222222222", isYes: false },
  ],
  premium: 5_000_000n,
  maxPayout: 20_000_000n,
  deadline: 1_755_500_000n,
  quoteId: `0x${(42n).toString(16).padStart(64, "0")}`,
};

test("EIP-712 digest matches ParlayVault.quoteDigest forge vector", () => {
  assert.equal(quoteDigest(31337, VAULT, q), FORGE_DIGEST);
});
