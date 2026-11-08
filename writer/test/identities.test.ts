import assert from "node:assert/strict";
import { test } from "node:test";
import { identityDirectory } from "../src/identities.js";

const W1 = "0x1111111111111111111111111111111111111111", W2 = "0x2222222222222222222222222222222222222222";
const users = [
  { id: "a", linked_accounts: [
    { type: "twitter_oauth", username: "alice_x", name: "Alice", profile_picture_url: "https://pbs.twimg.com/a_normal.jpg", verified_at: 1 },
    { type: "wallet", chain_type: "ethereum", address: W1.toUpperCase().replace("0X", "0x"), verified_at: 1 },
    { type: "wallet", chain_type: "ethereum", address: W2, verified_at: 1 },
    { type: "wallet", chain_type: "solana", address: "So1ana", verified_at: 1 },
  ] },
  { id: "b", linked_accounts: [{ type: "wallet", chain_type: "ethereum", address: "0x3333333333333333333333333333333333333333", verified_at: 1 }] },
  { id: "c", linked_accounts: [{ type: "twitter_oauth", username: null, name: null, profile_picture_url: null, verified_at: 1 }] },
];

function fakeClient(pages: () => AsyncIterable<unknown>) {
  let calls = 0;
  return { calls: () => calls, client: { users: () => ({ list: () => { calls++; return pages(); } }) } as never };
}

test("maps every verified ethereum wallet of an X-linked user to the handle, caches for the TTL, serves stale on failure", async () => {
  let t = 0, fail = false;
  const { client, calls } = fakeClient(async function* () { if (fail) throw new Error("privy down"); yield* users; });
  const identities = identityDirectory(client, 1_000, () => t);
  const alice = { username: "alice_x", name: "Alice", avatar: "https://pbs.twimg.com/a_normal.jpg" };
  assert.deepEqual(await identities(), { [W1]: alice, [W2]: alice });
  t = 500;
  await identities();
  assert.equal(calls(), 1);
  t = 1_000;
  fail = true;
  assert.deepEqual(await identities(), { [W1]: alice, [W2]: alice });
  assert.equal(calls(), 2);
  await identities(); // failure backs off for a TTL as well
  assert.equal(calls(), 2);
});

test("returns an empty map when Privy fails before the first load", async () => {
  const { client } = fakeClient(async function* () { throw new Error("nope"); });
  assert.deepEqual(await identityDirectory(client)(), {});
});
