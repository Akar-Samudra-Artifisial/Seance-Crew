import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_PATHS, API_ROUTES } from "../src/api/routes.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(path.join(root, "app.json"), "utf8")) as Record<string, unknown> & {
  name: string;
  permissions?: Record<string, unknown> & { api?: string[] };
};

/** The page reaches the backend only through the gateway proxy: /apps/<name>/api/<route>. */
const proxied = (backendPath: string): string => `/apps/${manifest.name}${backendPath}`;

describe("permissions.api", () => {
  it("lists every backend route with the /apps/<name> proxy prefix, exactly (six, explicit, no wildcard)", () => {
    expect(manifest.permissions?.api).toBeDefined();
    expect([...(manifest.permissions?.api ?? [])].sort()).toEqual(API_PATHS.map(proxied).sort());
    expect(API_PATHS).toHaveLength(6);
    expect(new Set(API_PATHS).size).toBe(6);
    for (const entry of manifest.permissions?.api ?? []) {
      expect(entry.startsWith(`/apps/${manifest.name}/api/`)).toBe(true);
      expect(entry).not.toContain("*");
    }
  });

  it("names every route in the design: state and summary are GET, the four actions are POST", () => {
    const table = Object.fromEntries(API_ROUTES.map((r) => [r.path, r.method]));
    expect(table).toEqual({
      "/api/state": "GET",
      "/api/summary": "GET",
      "/api/summon": "POST",
      "/api/grant-op": "POST",
      "/api/exorcise": "POST",
      "/api/inbox/dismiss": "POST",
    });
  });

  it("declares no cron: no crons key and no cron permission", () => {
    expect(Object.hasOwn(manifest, "crons")).toBe(false);
    expect(Object.hasOwn(manifest.permissions ?? {}, "cron")).toBe(false);
  });
});
