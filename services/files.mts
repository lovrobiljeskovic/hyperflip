import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readOptionalFile(file: string): string | undefined {
  try { return readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function syncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function replaceFile(file: string, contents: string): void {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: "wx", mode: 0o600, flush: true });
    renameSync(temporary, file);
    syncDirectory(directory);
  } finally { rmSync(temporary, { force: true }); }
}
