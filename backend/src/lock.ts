// Single-instance lock: data/bridge.lock holding { pid, startedAt, port, nonce }.
// The file is always written to a private temp file first (flag "wx", random name) and then published, so a reader
// never sees a half-written lock. A fresh lock is published with link (fails if it exists); a stale one is replaced
// with rename and the nonce is read back to see who won.
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppPaths } from "./paths.js";

export interface LockInfo {
  readonly pid: number;
  readonly startedAt: number;
  /** Informational only; nothing ever connects to this port. */
  readonly port: number | null;
  /** Random value that identifies the holder; used to see who won a race for a stale lock. */
  readonly nonce: string;
}

export interface LockDeps {
  readonly now?: () => number;
  readonly pid?: number;
  readonly isAlive?: (pid: number) => boolean;
  /** Milliseconds since the epoch at which the system booted. */
  readonly bootTime?: () => number;
  /** Milliseconds since the epoch at which this process started. */
  readonly processStart?: () => number;
  /** Source of the random nonce and temp file names. */
  readonly randomId?: () => string;
  /** Test hook: runs after a stale lock was judged stale and before it is replaced. */
  readonly beforeReplace?: () => void;
}

export interface Lock {
  readonly info: LockInfo;
  /** Record the HTTP port once the server is listening (atomic write). */
  setPort(port: number): void;
  /** Remove the lock file if it still holds our nonce. Idempotent. */
  release(): void;
}

export type LockResult =
  | { readonly kind: "acquired"; readonly lock: Lock }
  | { readonly kind: "duplicate"; readonly holder: LockInfo | null };

/** Tolerance when comparing startedAt with the boot time, in milliseconds. */
export const BOOT_TOLERANCE_MS = 5_000;

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const defaultBootTime = (): number => Date.now() - os.uptime() * 1000;

const parseInfo = (text: string): LockInfo | null => {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const v = value as Record<string, unknown>;
    if (typeof v["pid"] !== "number" || !Number.isInteger(v["pid"]) || v["pid"] <= 0) return null;
    if (typeof v["startedAt"] !== "number" || !Number.isFinite(v["startedAt"])) return null;
    const port = typeof v["port"] === "number" ? v["port"] : null;
    const nonce = typeof v["nonce"] === "string" ? v["nonce"] : "";
    return { pid: v["pid"], startedAt: v["startedAt"], port, nonce };
  } catch {
    return null;
  }
};

interface ReadResult {
  readonly exists: boolean;
  readonly raw: string | null;
  readonly info: LockInfo | null;
}

const readLockFile = (file: string): ReadResult => {
  try {
    const raw = readFileSync(file, "utf8");
    return { exists: true, raw, info: parseInfo(raw) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, raw: null, info: null };
    return { exists: true, raw: null, info: null };
  }
};

/** Write `text` to a new private file next to `file` (exclusive create, mode 600) and return its path. */
const writeTemp = (file: string, text: string, id: string): string => {
  const tmp = `${file}.${id}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return tmp;
};

const removeQuietly = (file: string): void => {
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
};

export function acquireLock(paths: AppPaths, deps: LockDeps = {}): LockResult {
  const now = deps.now ?? Date.now;
  const pid = deps.pid ?? process.pid;
  const isAlive = deps.isAlive ?? processIsAlive;
  const bootTime = deps.bootTime ?? defaultBootTime;
  const randomId = deps.randomId ?? randomUUID;
  const processStart = deps.processStart ?? ((): number => now() - process.uptime() * 1000);
  const file = paths.lockFile;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

  const fileTime = (): number => {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };

  const isStale = (info: LockInfo | null): boolean => {
    if (info === null) return true; // invalid JSON or shape
    // Our own pid, but written before this process started: left over from an earlier process that had the same pid.
    if (info.pid === pid && info.startedAt < processStart() - BOOT_TOLERANCE_MS) return true;
    if (!isAlive(info.pid)) return true; // dead pid
    // A live pid that cannot be the one that wrote the lock: the lock is older than the system itself.
    const boot = bootTime() - BOOT_TOLERANCE_MS;
    return info.startedAt < boot || fileTime() < boot;
  };

  const mine: LockInfo = { pid, startedAt: now(), port: null, nonce: randomId() };

  const makeLock = (): Lock => {
    let current = mine;
    const ours = (): boolean => readLockFile(file).info?.nonce === mine.nonce;
    return {
      get info() {
        return current;
      },
      setPort(port: number) {
        if (!ours()) return;
        current = { ...current, port };
        const tmp = writeTemp(file, JSON.stringify(current), randomId());
        try {
          renameSync(tmp, file);
        } catch (err) {
          removeQuietly(tmp);
          throw err;
        }
      },
      release() {
        if (!ours()) return;
        try {
          unlinkSync(file);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      },
    };
  };

  /** Publish a lock when none exists. Returns false when somebody else created one first. */
  const createFresh = (): boolean => {
    const tmp = writeTemp(file, JSON.stringify(mine), randomId());
    try {
      linkSync(tmp, file);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      // A file system without hard links: fall back to an exclusive create of the lock itself.
      if (code === "EPERM" || code === "ENOTSUP" || code === "EXDEV" || code === "ENOSYS") {
        try {
          const fd = openSync(file, "wx", 0o600);
          try {
            writeSync(fd, JSON.stringify(mine));
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          return true;
        } catch (inner) {
          if ((inner as NodeJS.ErrnoException).code === "EEXIST") return false;
          throw inner;
        }
      }
      throw err;
    } finally {
      removeQuietly(tmp);
    }
  };

  if (createFresh()) return { kind: "acquired", lock: makeLock() };

  const existing = readLockFile(file);
  if (existing.exists && !isStale(existing.info)) return { kind: "duplicate", holder: existing.info };

  // Stale (or vanished): replace it, but only if it is still the file we judged stale.
  deps.beforeReplace?.();
  if (!existing.exists) {
    return createFresh() ? { kind: "acquired", lock: makeLock() } : { kind: "duplicate", holder: readLockFile(file).info };
  }
  if (readLockFile(file).raw !== existing.raw) return { kind: "duplicate", holder: readLockFile(file).info };
  const tmp = writeTemp(file, JSON.stringify(mine), randomId());
  try {
    renameSync(tmp, file);
  } catch (err) {
    removeQuietly(tmp);
    throw err;
  }
  // Read it back: if another process replaced the stale lock after us, its nonce is in the file.
  const after = readLockFile(file);
  if (after.info?.nonce === mine.nonce) return { kind: "acquired", lock: makeLock() };
  return { kind: "duplicate", holder: after.info };
}

export interface ProcessLike {
  on(event: string, listener: () => void): unknown;
  listenerCount(event: string): number;
  exit(code?: number): never;
}

const SIGNAL_CODES: Readonly<Record<string, number>> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };

/**
 * Release the lock on SIGINT, SIGTERM, SIGHUP and exit. When this module's handler is the only listener for a
 * signal, it also exits the process (otherwise adding a handler would stop the default termination).
 */
export function registerLockRelease(lock: Lock, proc: ProcessLike = process): void {
  proc.on("exit", () => {
    lock.release();
  });
  for (const [signal, code] of Object.entries(SIGNAL_CODES)) {
    proc.on(signal, () => {
      lock.release();
      if (proc.listenerCount(signal) <= 1) proc.exit(128 + code);
    });
  }
}
