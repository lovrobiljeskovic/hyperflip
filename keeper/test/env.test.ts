import assert from "node:assert/strict";
import test from "node:test";
import { requireEnv, requireKey, rpcUrls } from "../../services/env.mjs";

test("requireEnv throws on a missing or empty var", () => {
  delete process.env.ENV_TEST_VAR;
  assert.throws(() => requireEnv("ENV_TEST_VAR"), { message: "missing required env var ENV_TEST_VAR" });
  process.env.ENV_TEST_VAR = "";
  assert.throws(() => requireEnv("ENV_TEST_VAR"), { message: "missing required env var ENV_TEST_VAR" });
  process.env.ENV_TEST_VAR = "x";
  assert.equal(requireEnv("ENV_TEST_VAR"), "x");
});

test("requireKey accepts 32-byte hex and rejects anything else without echoing it", () => {
  const good = `0x${"ab".repeat(32)}`;
  process.env.ENV_TEST_KEY = good;
  assert.equal(requireKey("ENV_TEST_KEY"), good);
  process.env.ENV_TEST_KEY = "0x1234";
  assert.throws(() => requireKey("ENV_TEST_KEY"), { message: "ENV_TEST_KEY must be a 0x-prefixed 32-byte hex string" });
});

test("rpcUrls trims and drops empties", () => {
  assert.deepEqual(rpcUrls(" http://a , ,http://b,"), ["http://a", "http://b"]);
});
