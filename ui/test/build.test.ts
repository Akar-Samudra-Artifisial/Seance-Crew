import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const bundlePath = path.join(root, "ui", "dist", "index.mjs");

describe("ui build", () => {
  beforeAll(() => {
    execFileSync(process.execPath, [path.join(root, "scripts", "build.mjs"), "ui"], { cwd: root, stdio: "pipe" });
  });

  it("produces ui/dist/index.mjs", () => {
    expect(existsSync(bundlePath)).toBe(true);
  });

  it("is an ES module with a default export", () => {
    const text = readFileSync(bundlePath, "utf8");
    expect(text).toMatch(/^\s*(import|export|var|function|\/\/)/m);
    expect(text).toMatch(/export\s*\{[^}]*\bas default\b[^}]*\}|export default/);
  });

  it("keeps React, the SDK and lucide-react external", () => {
    const text = readFileSync(bundlePath, "utf8");
    expect(text).toMatch(/from\s*"react\/jsx-runtime"/);
    expect(text).toMatch(/from\s*"@kirocrew\/app-sdk\/ui"/);
    // No bundled copy of React or the SDK: their internals never appear in the output.
    expect(text).not.toContain("__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED");
    expect(text).not.toContain("react.element");
    expect(text).not.toContain("react.transitional.element");
    expect(text).not.toContain("createElement(");
    expect(text.length).toBeLessThan(200_000);
  });

  it("matches app.json: ui.entry and the page route", () => {
    const app = JSON.parse(readFileSync(path.join(root, "app.json"), "utf8")) as {
      ui: { entry: string; pages: Array<{ route: string }> };
    };
    expect(path.join(root, "ui", app.ui.entry)).toBe(bundlePath);
    expect(app.ui.pages[0]?.route).toBe("/apps/seance-crew");
  });
});
