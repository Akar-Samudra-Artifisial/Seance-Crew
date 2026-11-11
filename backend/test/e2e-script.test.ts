import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "e2e.mjs");

const run = (env: Record<string, string>) =>
  spawnSync(process.execPath, [script], {
    env: { PATH: process.env["PATH"] ?? "", ...env },
    encoding: "utf8",
    timeout: 20_000,
  });

describe("scripts/e2e.mjs", () => {
  it("prints skipped and exits 0 without SEANCE_E2E=1", () => {
    const result = run({});
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skipped");
  });

  it("stays skipped for any value other than 1", () => {
    const result = run({ SEANCE_E2E: "true" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skipped");
  });

  it("exits non-zero and names the missing variables (never values) when enabled without credentials", () => {
    const result = run({ SEANCE_E2E: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SEANCE_E2E_HOST");
    expect(result.stderr).toContain("SEANCE_E2E_NICK");
    expect(result.stderr).toContain("SEANCE_E2E_SECRET");
  });

  it("rejects a host that is not a bare hostname without echoing the secret", () => {
    const result = run({ SEANCE_E2E: "1", SEANCE_E2E_HOST: "https://evil.example/ws", SEANCE_E2E_NICK: "crew", SEANCE_E2E_SECRET: "top-secret-value" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain("top-secret-value");
    expect(result.stdout).not.toContain("top-secret-value");
  });
});
