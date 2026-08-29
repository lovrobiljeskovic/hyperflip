import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join, resolve } from "node:path";

export interface ResearchPersistence {
  read(relativePath: string): Buffer;
  readText(relativePath: string): string;
  exists(relativePath: string): boolean;
  list(relativePath: string): string[];
  append(relativePath: string, line: string): void;
  writeAtomic(relativePath: string, bytes: string | Buffer): void;
  writeNew(relativePath: string, bytes: string | Buffer): boolean;
}

interface Identity { dev: number | bigint; ino: number | bigint }

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const bytewise = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const identity = (value: { dev: number | bigint; ino: number | bigint }): Identity => ({ dev: value.dev, ino: value.ino });
const sameIdentity = (left: Identity, right: Identity): boolean => left.dev === right.dev && left.ino === right.ino;
const isCode = (error: unknown, code: string): boolean => (error as NodeJS.ErrnoException).code === code;

function segments(relativePath: string): string[] {
  if (!relativePath || relativePath.startsWith("/") || relativePath.endsWith("/") || relativePath.includes("//") || relativePath.includes("\\") || relativePath.includes("\0")) throw new Error("research path must be a canonical relative path");
  const values = relativePath.split("/");
  if (values.some((value) => !value || value === "." || value === "..")) throw new Error("research path must be a canonical relative path");
  return values;
}

function verifyDirectory(stat: Stats, label: string): void {
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${label} is not owned by the current user`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`${label} is group or world writable`);
}

function symbolicLink(label: string, error: unknown): never {
  if (isCode(error, "ELOOP")) throw new Error(`${label} is a symbolic link`);
  throw error;
}

function writeFully(fd: number, bytes: string | Buffer): void {
  const data = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  let offset = 0;
  while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
}

function openFile(path: string, flags: number, label: string, mode?: number): number {
  let fd: number;
  try {
    fd = openSync(path, flags, mode);
  } catch (error) {
    symbolicLink(label, error);
  }
  const stat = fstatSync(fd!);
  if (!stat.isFile()) {
    closeSync(fd!);
    throw new Error(`${label} is not a regular file`);
  }
  return fd!;
}

function openDirectory(path: string, label: string): number {
  let fd: number;
  try {
    fd = openSync(path, DIRECTORY_FLAGS);
  } catch (error) {
    symbolicLink(label, error);
  }
  try {
    verifyDirectory(fstatSync(fd!), label);
  } catch (error) {
    closeSync(fd!);
    throw error;
  }
  return fd!;
}

function rejectLeafSymlink(path: string, label: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`${label} is a symbolic link`);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
}

function anchoredPersistence(root: string, beforeLeafOpen?: () => void): ResearchPersistence {
  const rootFd = openDirectory(root, "research root");
  const procPath = (fd: number, name?: string): string => name === undefined ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${name}`;

  const withParent = <T>(relativePath: string, create: boolean, action: (parentFd: number, leaf: string) => T): T => {
    const parts = segments(relativePath);
    const opened: number[] = [];
    let parentFd = rootFd;
    try {
      verifyDirectory(fstatSync(rootFd), "research root");
      for (const part of parts.slice(0, -1)) {
        let child: number;
        try {
          child = openDirectory(procPath(parentFd, part), `research directory ${part}`);
        } catch (error) {
          if (!create || !isCode(error, "ENOENT")) throw error;
          mkdirSync(procPath(parentFd, part), { mode: 0o700 });
          fsyncSync(parentFd);
          child = openDirectory(procPath(parentFd, part), `research directory ${part}`);
        }
        opened.push(child);
        parentFd = child;
      }
      beforeLeafOpen?.();
      return action(parentFd, parts.at(-1)!);
    } finally {
      for (const fd of opened.reverse()) closeSync(fd);
    }
  };

  const read = (relativePath: string): Buffer => withParent(relativePath, false, (parentFd, leaf) => {
    const fd = openFile(procPath(parentFd, leaf), FILE_READ_FLAGS, `research file ${relativePath}`);
    try { return readFileSync(fd); } finally { closeSync(fd); }
  });

  const list = (relativePath: string): string[] => {
    try {
      return withParent(relativePath, false, (parentFd, leaf) => {
        const directory = openDirectory(procPath(parentFd, leaf), `research directory ${relativePath}`);
        const walk = (fd: number, prefix: string): string[] => readdirSync(procPath(fd), { withFileTypes: true }).flatMap((entry) => {
          const path = `${prefix}/${entry.name}`;
          if (entry.isSymbolicLink()) throw new Error(`research path ${path} is a symbolic link`);
          if (!entry.isDirectory()) return [path];
          const child = openDirectory(procPath(fd, entry.name), `research directory ${path}`);
          try { return walk(child, path); } finally { closeSync(child); }
        });
        try { return walk(directory, relativePath).sort(bytewise); } finally { closeSync(directory); }
      });
    } catch (error) {
      if (isCode(error, "ENOENT")) return [];
      throw error;
    }
  };

  const writeTemporary = (parentFd: number, leaf: string, bytes: string | Buffer): string => {
    const temporary = `.${leaf}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openFile(procPath(parentFd, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, `research temporary file ${temporary}`, 0o600);
    try {
      writeFully(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return temporary;
  };

  return {
    read,
    readText: (relativePath) => read(relativePath).toString("utf8"),
    exists: (relativePath) => {
      try {
        return withParent(relativePath, false, (parentFd, leaf) => {
          const stat = lstatSync(procPath(parentFd, leaf));
          if (stat.isSymbolicLink()) throw new Error(`research file ${relativePath} is a symbolic link`);
          return true;
        });
      } catch (error) {
        if (isCode(error, "ENOENT")) return false;
        throw error;
      }
    },
    list,
    append: (relativePath, line) => withParent(relativePath, true, (parentFd, leaf) => {
      const path = procPath(parentFd, leaf);
      rejectLeafSymlink(path, `research file ${relativePath}`);
      const fd = openFile(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, `research file ${relativePath}`, 0o600);
      try {
        writeFully(fd, `${line.replace(/\n+$/, "")}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fsyncSync(parentFd);
    }),
    writeAtomic: (relativePath, bytes) => withParent(relativePath, true, (parentFd, leaf) => {
      const temporary = writeTemporary(parentFd, leaf, bytes);
      try {
        rejectLeafSymlink(procPath(parentFd, leaf), `research file ${relativePath}`);
        renameSync(procPath(parentFd, temporary), procPath(parentFd, leaf));
        fsyncSync(parentFd);
      } catch (error) {
        rmSync(procPath(parentFd, temporary), { force: true });
        throw error;
      }
    }),
    writeNew: (relativePath, bytes) => withParent(relativePath, true, (parentFd, leaf) => {
      const temporary = writeTemporary(parentFd, leaf, bytes);
      try {
        rejectLeafSymlink(procPath(parentFd, leaf), `research file ${relativePath}`);
        try {
          linkSync(procPath(parentFd, temporary), procPath(parentFd, leaf));
        } catch (error) {
          if (isCode(error, "EEXIST")) {
            rejectLeafSymlink(procPath(parentFd, leaf), `research file ${relativePath}`);
            return false;
          }
          throw error;
        }
        fsyncSync(parentFd);
        return true;
      } finally {
        rmSync(procPath(parentFd, temporary), { force: true });
      }
    }),
  };
}

function compatibilityPersistence(root: string, beforeLeafOpen?: () => void): ResearchPersistence {
  const openedRoot = lstatSync(root);
  if (openedRoot.isSymbolicLink()) throw new Error("research root is a symbolic link");
  verifyDirectory(openedRoot, "research root");
  const rootIdentity = identity(openedRoot);
  const realRoot = realpathSync(root);

  const verifyRoot = (): void => {
    const current = lstatSync(root);
    if (current.isSymbolicLink()) throw new Error("research root is a symbolic link");
    verifyDirectory(current, "research root");
    if (!sameIdentity(rootIdentity, identity(current)) || realpathSync(root) !== realRoot) throw new Error("research root changed after it was opened");
  };

  const verifyParent = (parts: string[], create: boolean): { path: string; identity: Identity } => {
    verifyRoot();
    let path = root;
    for (const part of parts) {
      path = join(path, part);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(path);
      } catch (error) {
        if (!create || !isCode(error, "ENOENT")) throw error;
        mkdirSync(path, { mode: 0o700 });
        const parent = join(path, "..");
        const parentFd = openDirectory(parent, `research directory ${part}`);
        try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
        stat = lstatSync(path);
      }
      if (stat.isSymbolicLink()) throw new Error(`research directory ${part} is a symbolic link`);
      verifyDirectory(stat, `research directory ${part}`);
      const realPath = realpathSync(path);
      if (realPath !== realRoot && !realPath.startsWith(`${realRoot}/`)) throw new Error("research path escapes real root");
    }
    return { path, identity: identity(lstatSync(path)) };
  };

  const withParent = <T>(relativePath: string, create: boolean, action: (parent: string, parentIdentity: Identity, leaf: string) => T): T => {
    const parts = segments(relativePath);
    const initial = verifyParent(parts.slice(0, -1), create);
    beforeLeafOpen?.();
    const current = verifyParent(parts.slice(0, -1), false);
    if (!sameIdentity(initial.identity, current.identity)) throw new Error("research directory changed before leaf open");
    return action(current.path, current.identity, parts.at(-1)!);
  };

  const read = (relativePath: string): Buffer => withParent(relativePath, false, (parent, _parentIdentity, leaf) => {
    const path = join(parent, leaf);
    rejectLeafSymlink(path, `research file ${relativePath}`);
    const fd = openFile(path, FILE_READ_FLAGS, `research file ${relativePath}`);
    try { return readFileSync(fd); } finally { closeSync(fd); }
  });

  const fsyncParent = (parent: string, expected: Identity): void => {
    const fd = openDirectory(parent, "research parent directory");
    try {
      if (!sameIdentity(identity(fstatSync(fd)), expected)) throw new Error("research directory changed before fsync");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };

  const safeRemove = (parent: string, expected: Identity, temporary: string): void => {
    try {
      if (sameIdentity(identity(lstatSync(parent)), expected)) rmSync(join(parent, temporary), { force: true });
    } catch { /* best-effort cleanup without following a replaced directory */ }
  };

  const writeTemporary = (parent: string, leaf: string, bytes: string | Buffer): string => {
    const temporary = `.${leaf}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openFile(join(parent, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, `research temporary file ${temporary}`, 0o600);
    try {
      writeFully(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return temporary;
  };

  return {
    read,
    readText: (relativePath) => read(relativePath).toString("utf8"),
    exists: (relativePath) => {
      try {
        return withParent(relativePath, false, (parent, _parentIdentity, leaf) => {
          const stat = lstatSync(join(parent, leaf));
          if (stat.isSymbolicLink()) throw new Error(`research file ${relativePath} is a symbolic link`);
          return true;
        });
      } catch (error) {
        if (isCode(error, "ENOENT")) return false;
        throw error;
      }
    },
    list: (relativePath) => {
      try {
        return withParent(relativePath, false, (parent, _parentIdentity, leaf) => {
          const start = join(parent, leaf);
          const startStat = lstatSync(start);
          if (startStat.isSymbolicLink()) throw new Error(`research directory ${relativePath} is a symbolic link`);
          verifyDirectory(startStat, `research directory ${relativePath}`);
          const walk = (path: string, prefix: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
            const child = join(path, entry.name);
            const relative = `${prefix}/${entry.name}`;
            const childStat = lstatSync(child);
            if (entry.isSymbolicLink() || childStat.isSymbolicLink()) throw new Error(`research path ${relative} is a symbolic link`);
            if (!entry.isDirectory()) return [relative];
            verifyDirectory(childStat, `research directory ${relative}`);
            return walk(child, relative);
          });
          return walk(start, relativePath).sort(bytewise);
        });
      } catch (error) {
        if (isCode(error, "ENOENT")) return [];
        throw error;
      }
    },
    append: (relativePath, line) => withParent(relativePath, true, (parent, parentIdentity, leaf) => {
      const path = join(parent, leaf);
      rejectLeafSymlink(path, `research file ${relativePath}`);
      const fd = openFile(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, `research file ${relativePath}`, 0o600);
      try {
        writeFully(fd, `${line.replace(/\n+$/, "")}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fsyncParent(parent, parentIdentity);
    }),
    writeAtomic: (relativePath, bytes) => withParent(relativePath, true, (parent, parentIdentity, leaf) => {
      const temporary = writeTemporary(parent, leaf, bytes);
      try {
        rejectLeafSymlink(join(parent, leaf), `research file ${relativePath}`);
        renameSync(join(parent, temporary), join(parent, leaf));
        fsyncParent(parent, parentIdentity);
      } catch (error) {
        safeRemove(parent, parentIdentity, temporary);
        throw error;
      }
    }),
    writeNew: (relativePath, bytes) => withParent(relativePath, true, (parent, parentIdentity, leaf) => {
      const temporary = writeTemporary(parent, leaf, bytes);
      try {
        rejectLeafSymlink(join(parent, leaf), `research file ${relativePath}`);
        try {
          linkSync(join(parent, temporary), join(parent, leaf));
        } catch (error) {
          if (isCode(error, "EEXIST")) {
            rejectLeafSymlink(join(parent, leaf), `research file ${relativePath}`);
            return false;
          }
          throw error;
        }
        fsyncParent(parent, parentIdentity);
        return true;
      } finally {
        safeRemove(parent, parentIdentity, temporary);
      }
    }),
  };
}

export function openResearchPersistence(
  rootInput: string,
  options: { requireAnchored?: boolean; beforeLeafOpen?: () => void } = {},
): ResearchPersistence {
  const root = resolve(rootInput);
  if (process.platform === "linux" && existsSync("/proc/self/fd")) return anchoredPersistence(root, options.beforeLeafOpen);
  if (options.requireAnchored === true) throw new Error("Anchored research persistence requires Linux and /proc/self/fd");
  return compatibilityPersistence(root, options.beforeLeafOpen);
}
