import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_BASE, APP_NAME, ROUTES, stateUrl } from "../src/api.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(path.join(root, "app.json"), "utf8")) as { name: string; permissions: { api: string[] } };

describe("API paths", () => {
  it("builds the prefix from the app name in app.json", () => {
    expect(APP_NAME).toBe(manifest.name);
    expect(API_BASE).toBe(`/apps/${manifest.name}/api`);
  });

  it("every route carries the prefix and is listed in permissions.api", () => {
    for (const route of Object.values(ROUTES)) {
      expect(route.startsWith(`${API_BASE}/`)).toBe(true);
      expect(manifest.permissions.api).toContain(route);
    }
    expect([...manifest.permissions.api].sort()).toEqual(Object.values(ROUTES).sort());
  });

  it("keeps the query string after the path (the permission check matches the pathname)", () => {
    expect(stateUrl(null)).toBe(`${API_BASE}/state`);
    expect(stateUrl(7)).toBe(`${API_BASE}/state?since=7`);
  });

  it("no source file other than api.ts writes an /api path by hand", () => {
    const dir = path.join(root, "ui", "src");
    for (const name of readdirSync(dir)) {
      if (name === "api.ts" || name.endsWith(".d.ts")) continue;
      const text = readFileSync(path.join(dir, name), "utf8");
      expect(/["'`]\/(apps\/[^"'`]*\/)?api\//.test(text), name).toBe(false);
    }
  });
});
