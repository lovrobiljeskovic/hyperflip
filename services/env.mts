import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Resolves against the repo/box root (the parent of services/); absolute segments win. */
export const rootPath = (...segments: string[]): string => path.resolve(root, ...segments);

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

export function requireKey(name: string): `0x${string}` {
  const v = requireEnv(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
    // Never log the value itself — only that it's malformed.
    throw new Error(`${name} must be a 0x-prefixed 32-byte hex string`);
  }
  return v as `0x${string}`;
}

/** Comma-separated RPC list, trimmed, empties dropped. */
export const rpcUrls = (csv: string): string[] => csv.split(",").map((u) => u.trim()).filter(Boolean);
