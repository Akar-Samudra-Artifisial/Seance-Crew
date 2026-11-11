import fc from "fast-check";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireLock, BOOT_TOLERANCE_MS, processIsAlive, registerLockRelease, type LockInfo, type ProcessLike } from "../src/lock.js";
import { appPaths, type AppPaths } from "../src/paths.js";
import { makeBridge } from "./helpers.js";

const tmp: string[] = [];
const makePaths = (): AppPaths => {
  const root = mkdtempSync(path.join(os.tmpdir(), "seance-lock-"));
  tmp.push(root);
  return appPaths(root);
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BOOT = 1_000_000;
const deps = (over: { pid?: number; alive?: (pid: number) => boolean; now?: number } = {}) => ({
  pid: over.pid ?? 4242,
  now: () => over.now ?? BOOT + 60_000,
  isAlive: over.alive ?? (() => true),
  bootTime: () => BOOT,
});
const writeLock = (paths: AppPaths, text: string): void => {
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(paths.lockFile, text);
};
const readLock = (paths: AppPaths): LockInfo => JSON.parse(readFileSync(paths.lockFile, "utf8")) as LockInfo;

describe("acquireLock", () => {
  it("acquires a missing lock and writes { pid, startedAt, port } with mode 600", () => {
    const paths = makePaths();
    const result = acquireLock(paths, deps());
    expect(result.kind).toBe("acquired");
    expect(readLock(paths)).toEqual({ pid: 4242, startedAt: BOOT + 60_000, port: null, nonce: expect.any(String) });
    expect(statSync(paths.lockFile).mode & 0o777).toBe(0o600);
  });

  it("reports duplicate-instance for a live lock and leaves it untouched", () => {
    const paths = makePaths();
    const holder: LockInfo = { pid: 111, startedAt: BOOT + 10_000, port: 9100, nonce: "other" };
    writeLock(paths, JSON.stringify(holder));
    const result = acquireLock(paths, deps());
    expect(result).toEqual({ kind: "duplicate", holder });
    expect(readLock(paths)).toEqual(holder);
  });

  it("opens no connection when the lock is held: the bridge is told duplicate-instance", () => {
    const paths = makePaths();
    writeLock(paths, JSON.stringify({ pid: 111, startedAt: BOOT + 10_000, port: 9100 }));
    const { bridge, ircd, store } = makeBridge();
    const result = acquireLock(paths, deps());
    if (result.kind === "duplicate") bridge.setDuplicateInstance();
    bridge.start({ host: "irc.example.org", nick: "crew", secret: "s3cret" });
    ircd.run();
    expect(store.state).toBe("duplicate-instance");
    expect(ircd.totalConnections).toBe(0);
  });

  it("replaces a stale lock whose pid is dead", () => {
    const paths = makePaths();
    writeLock(paths, JSON.stringify({ pid: 111, startedAt: BOOT + 10_000, port: 9100 }));
    const result = acquireLock(paths, deps({ alive: (pid) => pid !== 111 }));
    expect(result.kind).toBe("acquired");
    expect(readLock(paths).pid).toBe(4242);
  });

  it.each([["empty file", ""], ["garbage", "not json"], ["wrong shape", JSON.stringify({ pid: "x" })], ["null", "null"], ["bad pid", JSON.stringify({ pid: -4, startedAt: 1 })]])(
    "replaces a stale lock with invalid content (%s)",
    (_name, text) => {
      const paths = makePaths();
      writeLock(paths, text);
      expect(acquireLock(paths, deps()).kind).toBe("acquired");
      expect(readLock(paths).pid).toBe(4242);
    },
  );

  it("replaces a stale lock that is older than the system boot even if its pid looks alive", () => {
    const paths = makePaths();
    writeLock(paths, JSON.stringify({ pid: 111, startedAt: BOOT - BOOT_TOLERANCE_MS - 1, port: null }));
    expect(acquireLock(paths, deps()).kind).toBe("acquired");
  });

  it("keeps a live lock whose startedAt is within the boot tolerance", () => {
    const paths = makePaths();
    writeLock(paths, JSON.stringify({ pid: 111, startedAt: BOOT - BOOT_TOLERANCE_MS + 1, port: null }));
    expect(acquireLock(paths, deps()).kind).toBe("duplicate");
  });

  it("creates the data directory when it is missing", () => {
    const paths = makePaths();
    expect(existsSync(paths.data)).toBe(false);
    acquireLock(paths, deps());
    expect(existsSync(paths.data)).toBe(true);
  });
});

describe("Lock", () => {
  it("release removes the file only if it still holds our pid", () => {
    const paths = makePaths();
    const result = acquireLock(paths, deps());
    if (result.kind !== "acquired") throw new Error("expected acquired");
    // Somebody else took the file over (for example after we were considered stale).
    writeLock(paths, JSON.stringify({ pid: 999, startedAt: BOOT + 1, port: null }));
    result.lock.release();
    expect(readLock(paths).pid).toBe(999);
    // Our own lock is removed, and a second release is harmless.
    rmSync(paths.lockFile);
    const again = acquireLock(paths, deps());
    if (again.kind !== "acquired") throw new Error("expected acquired");
    again.lock.release();
    expect(existsSync(paths.lockFile)).toBe(false);
    again.lock.release();
  });

  it("can be acquired again after release", () => {
    const paths = makePaths();
    const first = acquireLock(paths, deps());
    if (first.kind !== "acquired") throw new Error("expected acquired");
    expect(acquireLock(paths, deps({ pid: 5555 })).kind).toBe("duplicate");
    first.lock.release();
    expect(acquireLock(paths, deps({ pid: 5555 })).kind).toBe("acquired");
  });

  it("setPort records the port atomically and keeps pid and startedAt", () => {
    const paths = makePaths();
    const result = acquireLock(paths, deps());
    if (result.kind !== "acquired") throw new Error("expected acquired");
    result.lock.setPort(9101);
    expect(readLock(paths)).toEqual({ pid: 4242, startedAt: BOOT + 60_000, port: 9101, nonce: expect.any(String) });
    expect(result.lock.info.port).toBe(9101);
    expect(readdirSync(paths.data).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("setPort does nothing once the lock belongs to somebody else", () => {
    const paths = makePaths();
    const result = acquireLock(paths, deps());
    if (result.kind !== "acquired") throw new Error("expected acquired");
    writeLock(paths, JSON.stringify({ pid: 999, startedAt: BOOT + 1, port: null }));
    result.lock.setPort(9101);
    expect(readLock(paths)).toEqual({ pid: 999, startedAt: BOOT + 1, port: null });
  });
});

describe("processIsAlive", () => {
  it("is true for this process and false for ESRCH", () => {
    expect(processIsAlive(process.pid)).toBe(true);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    expect(processIsAlive(99_999_999)).toBe(false);
  });

  it("counts EPERM as alive", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    expect(processIsAlive(1)).toBe(true);
  });
});

describe("registerLockRelease", () => {
  const fakeProcess = () => {
    const listeners = new Map<string, Array<() => void>>();
    const exits: number[] = [];
    const proc: ProcessLike = {
      on: (event, listener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return proc;
      },
      listenerCount: (event) => (listeners.get(event) ?? []).length,
      exit: ((code?: number) => {
        exits.push(code ?? 0);
        return undefined as never;
      }) as ProcessLike["exit"],
    };
    return { proc, listeners, exits };
  };

  it("releases on exit", () => {
    const paths = makePaths();
    const result = acquireLock(paths, deps());
    if (result.kind !== "acquired") throw new Error("expected acquired");
    const { proc, listeners } = fakeProcess();
    registerLockRelease(result.lock, proc);
    listeners.get("exit")?.forEach((l) => l());
    expect(existsSync(paths.lockFile)).toBe(false);
  });

  it.each(["SIGINT", "SIGTERM", "SIGHUP"])("releases on %s and exits when it is the only listener", (signal) => {
    const paths = makePaths();
    const result = acquireLock(paths, deps());
    if (result.kind !== "acquired") throw new Error("expected acquired");
    const { proc, listeners, exits } = fakeProcess();
    registerLockRelease(result.lock, proc);
    listeners.get(signal)?.forEach((l) => l());
    expect(existsSync(paths.lockFile)).toBe(false);
    expect(exits).toHaveLength(1);
  });

  it("releases but does not exit when another handler owns the shutdown", () => {
    const paths = makePaths();
    const result = acquireLock(paths, deps());
    if (result.kind !== "acquired") throw new Error("expected acquired");
    const { proc, listeners, exits } = fakeProcess();
    registerLockRelease(result.lock, proc);
    proc.on("SIGTERM", () => undefined);
    listeners.get("SIGTERM")?.[0]?.();
    expect(existsSync(paths.lockFile)).toBe(false);
    expect(exits).toHaveLength(0);
  });
});

describe("Property 9: lock has at most one holder", () => {
  it("a live lock is never replaced and a stale lock always is", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.integer({ min: -20_000, max: 20_000 }), fc.constantFrom("valid", "invalid"), (alive, offset, validity) => {
        const paths = makePaths();
        const holder = { pid: 111, startedAt: BOOT + offset, port: null };
        writeLock(paths, validity === "valid" ? JSON.stringify(holder) : "{{{");
        const live = validity === "valid" && alive && holder.startedAt >= BOOT - BOOT_TOLERANCE_MS;
        const result = acquireLock(paths, deps({ alive: (pid) => (pid === 111 ? alive : true) }));
        expect(result.kind).toBe(live ? "duplicate" : "acquired");
        if (live) expect(readLock(paths).pid).toBe(111);
        else expect(readLock(paths).pid).toBe(4242);
      }),
      { numRuns: 100 },
    );
  });
});

describe("stale lock races", () => {
  const STALE = JSON.stringify({ pid: 111, startedAt: BOOT + 10_000, port: null, nonce: "old" });
  const staleDeps = (pid: number, extra: Partial<Parameters<typeof acquireLock>[1]> = {}) => ({
    ...deps({ pid, alive: (p) => p !== 111 }),
    ...extra,
  });

  it("writes the lock through a private temp file and leaves none behind", () => {
    const paths = makePaths();
    writeLock(paths, STALE);
    expect(acquireLock(paths, staleDeps(4242)).kind).toBe("acquired");
    expect(readdirSync(paths.data).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(statSync(paths.lockFile).mode & 0o777).toBe(0o600);
    expect(typeof readLock(paths).nonce).toBe("string");
    expect(readLock(paths).nonce.length).toBeGreaterThan(8);
  });

  it("two acquirers on a stale lock: exactly one wins, even when the second runs inside the first one's window", () => {
    const paths = makePaths();
    writeLock(paths, STALE);
    let inner: ReturnType<typeof acquireLock> | undefined;
    const outer = acquireLock(
      paths,
      staleDeps(4242, {
        beforeReplace: () => {
          // The second process finishes its whole acquire between the first one's staleness check and its replace.
          inner = acquireLock(paths, staleDeps(5555));
        },
      }),
    );
    expect(inner?.kind).toBe("acquired");
    expect(outer.kind).toBe("duplicate");
    expect(readLock(paths).pid).toBe(5555);
    const winners = [outer, inner].filter((r) => r?.kind === "acquired");
    expect(winners).toHaveLength(1);
  });

  it("two acquirers one after the other: the first wins and the second sees a live lock", () => {
    const paths = makePaths();
    writeLock(paths, STALE);
    const a = acquireLock(paths, staleDeps(4242));
    const b = acquireLock(paths, staleDeps(5555));
    expect([a.kind, b.kind]).toEqual(["acquired", "duplicate"]);
  });

  it("reports duplicate-instance when another process replaced the lock and our nonce is not in the file", () => {
    const paths = makePaths();
    writeLock(paths, STALE);
    const result = acquireLock(paths, { ...staleDeps(4242), randomId: () => "same-id-for-all" });
    // Sanity: with fixed ids the single acquirer still works (temp file removed after the rename).
    expect(result.kind).toBe("acquired");
    expect(readLock(paths).nonce).toBe("same-id-for-all");
    const other = acquireLock(paths, { ...staleDeps(5555), randomId: () => "second-id" });
    expect(other.kind).toBe("duplicate");
  });

  it("release only removes a lock that carries our nonce", () => {
    const paths = makePaths();
    const result = acquireLock(paths, deps());
    if (result.kind !== "acquired") throw new Error("expected acquired");
    writeLock(paths, JSON.stringify({ pid: 4242, startedAt: BOOT + 60_000, port: null, nonce: "someone-else" }));
    result.lock.release();
    expect(existsSync(paths.lockFile)).toBe(true);
  });

  it("treats a lock with our own pid that was written before this process started as stale", () => {
    const paths = makePaths();
    writeLock(paths, JSON.stringify({ pid: 4242, startedAt: BOOT + 1_000, port: null, nonce: "old" }));
    const result = acquireLock(paths, { ...deps({ pid: 4242 }), processStart: () => BOOT + 50_000 });
    expect(result.kind).toBe("acquired");
  });

  it("keeps a lock with our own pid that was written after this process started", () => {
    const paths = makePaths();
    writeLock(paths, JSON.stringify({ pid: 4242, startedAt: BOOT + 55_000, port: null, nonce: "live" }));
    const result = acquireLock(paths, { ...deps({ pid: 4242 }), processStart: () => BOOT + 50_000 });
    expect(result.kind).toBe("duplicate");
  });

  it("treats a lock file older than the system boot as stale even when its content looks fresh", () => {
    const paths = makePaths();
    const boot = BOOT + 86_400_000;
    // startedAt is after the boot, so only the file's mtime (1970) can show that the lock is older than the system.
    writeLock(paths, JSON.stringify({ pid: 111, startedAt: boot + 10_000, port: null, nonce: "old" }));
    const old = new Date(BOOT);
    utimesSync(paths.lockFile, old, old);
    expect(acquireLock(paths, { ...deps(), bootTime: () => boot }).kind).toBe("acquired");
  });
});
