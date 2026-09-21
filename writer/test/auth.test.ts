import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { privyAuthenticator } from "../src/auth.js";

test("Privy verifies signatures, app, expiry and current verified links before admission", async t => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const token = (claims: Record<string, unknown> = {}) => {
    const data = `${encode({ alg: "ES256", typ: "JWT", kid: "test-key" })}.${encode({ iss: "privy.io", aud: "test-app", sub: "did:privy:verified", sid: "session", iat: now, exp: now + 300, ...claims })}`;
    return `${data}.${sign("sha256", Buffer.from(data), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  };
  const wallet = "0x1111111111111111111111111111111111111111";
  let linked_accounts: object[] = [
    { type: "email", address: " Approved@Example.com ", verified_at: now },
    { type: "email", address: "unverified@example.com", verified_at: null },
    { type: "wallet", address: wallet, chain_type: "ethereum", verified_at: now },
    { type: "wallet", address: "0x2222222222222222222222222222222222222222", chain_type: "ethereum", verified_at: null },
    { type: "wallet", address: wallet, chain_type: "solana", verified_at: now },
  ];
  let userId = "did:privy:verified", isGuest = false, fail = false, lookups = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (url.endsWith("/jwks.json")) return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "ES256", use: "sig" }] });
    assert(url.endsWith("/users/did%3Aprivy%3Averified") || url.endsWith("/users/did:privy:verified"));
    lookups++;
    if (fail) return Response.json({ error: "unavailable" }, { status: 503 });
    return Response.json({ id: userId, is_guest: isGuest, created_at: now, linked_accounts });
  });
  const authenticate = privyAuthenticator("test-app", "test-secret");
  assert.deepEqual(await authenticate(token()), { userId, emails: ["approved@example.com"], wallets: [wallet] });
  linked_accounts = [];
  assert.deepEqual(await authenticate(token()), { userId, emails: [], wallets: [] });
  const before = lookups;
  for (const invalid of ["legacy-code", token({ aud: "different-app" }), token({ iss: "forged" }), token({ exp: now - 60 }), token().slice(0, -10) + "AAAAAAAAAA"]) {
    assert.equal(await authenticate(invalid), null);
  }
  assert.equal(lookups, before);
  isGuest = true;
  assert.equal(await authenticate(token()), null);
  isGuest = false;
  userId = "did:privy:wrong";
  assert.equal(await authenticate(token()), null);
  fail = true;
  await assert.rejects(authenticate(token()), /^Error: Authentication unavailable$/);
});
