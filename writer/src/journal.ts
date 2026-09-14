import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { readOptionalFile, syncDirectory } from "../../services/files.mjs";

export class QuoteJournal {
  private failed = false;

  constructor(private file: string) {
    const contents = readOptionalFile(file);
    if (contents) {
      try {
        if (!contents.endsWith("\n")) throw new Error();
        for (const line of contents.slice(0, -1).split("\n")) {
          const record = JSON.parse(line);
          if (!record || Array.isArray(record) || !Number.isSafeInteger(record.schemaVersion) || record.schemaVersion < 1) throw new Error();
        }
      } catch { throw new Error("Invalid or truncated quote journal; preserve the file and repair it before restarting"); }
    }
    mkdirSync(dirname(file), { recursive: true });
    if (contents === undefined) {
      closeSync(openSync(file, "ax", 0o600));
      syncDirectory(dirname(file));
    }
  }

  append(record: unknown): void {
    if (this.failed) throw new Error("Quote journal failed; inspect the file and restart before quoting");
    try {
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, { flush: true });
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
}
