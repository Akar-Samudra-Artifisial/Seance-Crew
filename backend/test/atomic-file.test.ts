import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Wrap the fs calls the writer makes, so the test can see flags, modes and order. The real functions still run.
const calls: string[] = [];
const opened: Array<{ path: string; flag: unknown; mode: unknown }> = [];
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: ((p: string, flag: string, mode: number) => {
      calls.push("open");
      opened.push({ path: p, flag, mode });
      return actual.openSync(p, flag, mode);
    }) as typeof actual.openSync,
    fsyncSync: ((fd: number) => {
      calls.push("fsync");
      return actual.fsyncSync(fd);
    }) as typeof actual.fsyncSync,
    renameSync: ((a: string, b: string) => {
      calls.push("rename");
      return actual.renameSync(a, b);
    }) as typeof actual.renameSync,
  };
});

const { writeFileAtomic } = await import("../src/atomic-file.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "seance-atomic-"));
  calls.length = 0;
  opened.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("writeFileAtomic", () => {
  it("writes the content with mode 600 and leaves no temp file", () => {
    const file = path.join(dir, "x.json");
    writeFileAtomic(file, "hello\n");
    expect(readFileSync(file, "utf8")).toBe("hello\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });

  it("creates the temp file exclusively (wx) with mode 600", () => {
    writeFileAtomic(path.join(dir, "x.json"), "a");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.flag).toBe("wx");
    expect(opened[0]?.mode).toBe(0o600);
    expect(opened[0]?.path.endsWith(".tmp")).toBe(true);
  });

  it("flushes to disk (fsync) before the rename", () => {
    writeFileAtomic(path.join(dir, "x.json"), "a");
    expect(calls).toEqual(["open", "fsync", "rename"]);
  });

  it("uses a random suffix, not only the pid", () => {
    const file = path.join(dir, "x.json");
    writeFileAtomic(file, "a");
    writeFileAtomic(file, "b");
    const [first, second] = opened.map((o) => o.path);
    expect(first).not.toBe(second);
    for (const p of [first, second]) expect(p).toMatch(new RegExp(`\\.${process.pid}\\.[0-9a-f]{12}\\.tmp$`));
  });

  it("replaces an existing file whole", () => {
    const file = path.join(dir, "x.json");
    writeFileSync(file, "old content that is longer");
    writeFileAtomic(file, "new");
    expect(readFileSync(file, "utf8")).toBe("new");
  });

  it("removes the temp file and keeps the target when the rename fails", () => {
    const target = path.join(dir, "x.json");
    mkdirSync(target);
    writeFileSync(path.join(target, "keep"), "x"); // a non-empty directory cannot be replaced by a file
    expect(() => writeFileAtomic(target, "a")).toThrow();
    expect(readdirSync(dir)).toEqual(["x.json"]);
    expect(statSync(target).isDirectory()).toBe(true);
  });

  it("removes nothing else and throws when the directory is missing", () => {
    expect(() => writeFileAtomic(path.join(dir, "nope", "x.json"), "a")).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});
