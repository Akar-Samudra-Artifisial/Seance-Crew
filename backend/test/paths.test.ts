import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { appPaths, AppRootError, ensureDataDir, resolveAppRoot } from "../src/paths.js";

const tmp: string[] = [];
const makeRoot = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "seance-paths-"));
  tmp.push(dir);
  writeFileSync(path.join(dir, "app.json"), "{}");
  return dir;
};
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolveAppRoot", () => {
  it("finds the root from the installed bundle location", () => {
    const root = makeRoot();
    mkdirSync(path.join(root, "backend", "dist"), { recursive: true });
    const url = pathToFileURL(path.join(root, "backend", "dist", "server.js")).href;
    expect(resolveAppRoot(url)).toBe(root);
  });

  it("finds the root from the development layout", () => {
    const root = makeRoot();
    mkdirSync(path.join(root, "backend", "src", "irc"), { recursive: true });
    const url = pathToFileURL(path.join(root, "backend", "src", "irc", "client.ts")).href;
    expect(resolveAppRoot(url)).toBe(root);
  });

  it("throws an error naming the start directory when there is no app.json", () => {
    const url = pathToFileURL("/nowhere/backend/dist/server.js").href;
    expect(() => resolveAppRoot(url, () => false)).toThrow(AppRootError);
    expect(() => resolveAppRoot(url, () => false)).toThrow("/nowhere/backend/dist");
  });

  it("ignores process.cwd() and environment variables", () => {
    const root = makeRoot();
    const other = makeRoot();
    mkdirSync(path.join(root, "backend", "dist"), { recursive: true });
    const url = pathToFileURL(path.join(root, "backend", "dist", "server.js")).href;
    const cwd = process.cwd();
    const saved = process.env["KIROCREW_HOME"];
    process.env["KIROCREW_HOME"] = other;
    process.chdir(other);
    try {
      expect(resolveAppRoot(url)).toBe(root);
    } finally {
      process.chdir(cwd);
      if (saved === undefined) delete process.env["KIROCREW_HOME"];
      else process.env["KIROCREW_HOME"] = saved;
    }
  });
});

describe("appPaths and ensureDataDir", () => {
  it("derives every path from the root", () => {
    const p = appPaths("/app");
    expect(p).toEqual({
      root: "/app",
      data: "/app/data",
      secretFile: "/app/.app_secret",
      lockFile: "/app/data/bridge.lock",
      creditsFile: "/app/data/credits.json",
      summaryFile: "/app/data/summary.json",
    });
  });

  it("creates data/ with mode 700 and tightens an existing directory", () => {
    const root = makeRoot();
    const p = appPaths(root);
    ensureDataDir(p);
    expect(statSync(p.data).mode & 0o777).toBe(0o700);
    rmSync(p.data, { recursive: true });
    mkdirSync(p.data, { mode: 0o755 });
    ensureDataDir(p);
    expect(statSync(p.data).mode & 0o777).toBe(0o700);
  });
});
