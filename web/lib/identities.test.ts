import { expect, test } from "vitest";
import { parseIdentities } from "./identities";

const w = `0x${"a".repeat(40)}`;

test("keeps well-formed handles and X-hosted avatars, drops everything else", () => {
  expect(parseIdentities({
    [w]: { username: "alice_x", name: "Alice", avatar: "https://pbs.twimg.com/a_normal.jpg" },
    [`0x${"b".repeat(40)}`]: { username: "bob", name: 7, avatar: "https://evil.example/x.png" },
    [`0x${"c".repeat(40)}`]: { username: "way_too_long_for_x_1", avatar: null },
    [`0x${"d".repeat(40)}`]: { username: "<img>", avatar: null },
    "not-an-address": { username: "ok", avatar: null },
    [`0x${"e".repeat(40)}`]: null,
  })).toEqual({
    [w]: { username: "alice_x", name: "Alice", avatar: "https://pbs.twimg.com/a_normal.jpg" },
    [`0x${"b".repeat(40)}`]: { username: "bob", name: null, avatar: null },
  });
  expect(parseIdentities(null)).toEqual({});
  expect(parseIdentities([])).toEqual({});
});
