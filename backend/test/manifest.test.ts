// Packaging checks: app.json, the agent file and the skill agree with each other (steward-agent Requirement 5).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../src/mcp/tools.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(root, rel), "utf8")) as Record<string, unknown>;

interface Manifest {
  name: string;
  agents: string[];
  skills: string[];
  mcpServers: Record<string, { url?: string }>;
  permissions?: Record<string, unknown> & { api?: string[] };
  setup?: { configSchema?: { properties?: Record<string, { default?: unknown }> }; onUpdate?: unknown } & Record<string, unknown>;
  credentialMasks?: string[];
}
interface Agent {
  name: string;
  model: string;
  description: string;
  prompt: string;
  tools: string[];
  allowedTools: string[];
  skills: string[];
}

const manifest = readJson("app.json") as unknown as Manifest;
const agentPath = manifest.agents[0] ?? "";
const agent = readJson(agentPath) as unknown as Agent;

/** The tool reference Kiro Crew resolves: the gateway registers the server as `<app>:<server>` (see steering/kirocrew.md). */
export const STEWARD_TOOL_REF = "@seance-crew:seance";

/** Parse the `---` front matter of a markdown file into flat key/value strings. */
function frontMatter(text: string): Record<string, string> | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (m === null) return null;
  const out: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv !== null) out[kv[1] as string] = (kv[2] ?? "").trim();
  }
  return out;
}

describe("app.json", () => {
  it("lists the agent file and the skill folder, and both exist", () => {
    expect(manifest.agents).toEqual(["agents/seance-steward.json"]);
    expect(manifest.skills).toEqual(["skills/seance-steward"]);
    for (const rel of manifest.agents) expect(existsSync(path.join(root, rel)), rel).toBe(true);
    for (const rel of manifest.skills) expect(existsSync(path.join(root, rel, "SKILL.md")), `${rel}/SKILL.md`).toBe(true);
  });

  it("registers the MCP server under the key `seance`", () => {
    expect(Object.keys(manifest.mcpServers)).toEqual(["seance"]);
    expect(manifest.mcpServers["seance"]?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it("lists every credential mask as a config schema key, with no default value", () => {
    const props = manifest.setup?.configSchema?.properties ?? {};
    expect(manifest.credentialMasks?.length ?? 0).toBeGreaterThan(0);
    for (const key of manifest.credentialMasks ?? []) {
      expect(Object.keys(props), key).toContain(key);
      expect(props[key]?.default, `${key} default`).toBeUndefined();
    }
  });

  it("has no setup.onUpdate hook", () => {
    expect(manifest.setup).toBeDefined();
    expect(manifest.setup).not.toHaveProperty("onUpdate");
  });

  it("has no secret-looking default anywhere in the config schema", () => {
    const props = manifest.setup?.configSchema?.properties ?? {};
    for (const [key, field] of Object.entries(props)) {
      const d = field.default;
      if (typeof d !== "string") continue;
      expect(d, key).not.toMatch(/^[A-Za-z0-9+/_-]{24,}$/); // long token-like string
      expect(d, key).not.toMatch(/secret|token|password|:[^/\s]{6,}$/i);
    }
  });

  it("declares no cron: no crons key, no cron permission", () => {
    expect(manifest).not.toHaveProperty("crons");
    expect(manifest).not.toHaveProperty("cron");
    expect(manifest.permissions ?? {}).not.toHaveProperty("cron");
    expect(manifest.permissions ?? {}).not.toHaveProperty("crons");
    expect(JSON.stringify(manifest)).not.toMatch(/"crons?"/);
  });

  it("lists /api/summary in permissions.api, under the proxy prefix", () => {
    expect(manifest.permissions?.api).toContain(`/apps/${manifest.name}/api/summary`);
  });
});

describe("app icon (dashboard-ui Requirement 8)", () => {
  const app = manifest as unknown as { iconPath?: string; ui?: { pages?: Array<{ iconUrl?: string; iconInactiveUrl?: string }> } };

  it("iconPath is a 512x512 PNG", () => {
    expect(app.iconPath).toBe("assets/icon.png");
    const file = path.join(root, app.iconPath ?? "");
    expect(existsSync(file)).toBe(true);
    const png = readFileSync(file);
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // The first chunk is IHDR: width and height are big-endian uint32 at bytes 16 and 20.
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(512);
    expect(png.readUInt32BE(20)).toBe(512);
  });

  it.each(["iconUrl", "iconInactiveUrl"] as const)("ui.pages[0].%s is a safe SVG under ui/", (key) => {
    const rel = app.ui?.pages?.[0]?.[key];
    expect(rel, key).toBeTruthy();
    // Relative to ui/, no leading ui/ and no way out of it.
    expect(rel).not.toMatch(/^(\/|ui\/|\.\.)/);
    const file = path.join(root, "ui", rel ?? "");
    expect(existsSync(file), file).toBe(true);
    const svg = readFileSync(file, "utf8");
    expect(svg.trimStart().startsWith("<svg")).toBe(true);
    expect(svg).toContain('viewBox="0 0 16 16"');
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/href\s*=/i);
    expect(svg).not.toMatch(/\son[a-z]+\s*=/i);
    // No full-size background box: it would draw a box inside the sidebar row.
    expect(svg).not.toMatch(/<rect[^>]*width="16"[^>]*height="16"/);
  });
});

describe("agents/seance-steward.json", () => {
  it("has the name, a model, a description and a prompt", () => {
    expect(agent.name).toBe("seance-steward");
    expect(agent.model).toBeTruthy();
    expect(agent.description.length).toBeGreaterThan(10);
    expect(agent.prompt.length).toBeGreaterThan(50);
  });

  it("pins the tool reference Kiro Crew resolves for the app MCP server", () => {
    // The gateway registers `<app name>:<server key>`; `@seance` alone would be dropped silently.
    expect(STEWARD_TOOL_REF).toBe(`@${manifest.name}:${Object.keys(manifest.mcpServers)[0]}`);
    expect(agent.tools).toEqual([STEWARD_TOOL_REF]);
  });

  it("auto-approves exactly the four read-only tools, never a write tool or the bare server", () => {
    // allowedTools is the host's auto-approve list. say, summon, grant_op and exorcise keep the host approval prompt:
    // a human check that channel text (prompt injection) cannot answer, unlike `confirm`.
    const prefix = `${STEWARD_TOOL_REF}/`;
    expect(agent.allowedTools).toEqual([`${prefix}list_channels`, `${prefix}read`, `${prefix}whois`, `${prefix}credits`]);
    expect(agent.allowedTools).not.toContain(STEWARD_TOOL_REF);
    for (const write of ["say", "summon", "grant_op", "exorcise"]) {
      expect(agent.allowedTools.some((t) => t.endsWith(`/${write}`)), write).toBe(false);
    }
    for (const t of agent.allowedTools) expect(t.startsWith(`${STEWARD_TOOL_REF}/`), t).toBe(true);
  });

  it("only auto-approves tools that exist", () => {
    for (const t of agent.allowedTools) expect(TOOL_NAMES).toContain(t.slice(STEWARD_TOOL_REF.length + 1));
  });

  it("references a skill that exists in the skills folder, by its folder name", () => {
    expect(agent.skills).toEqual(["seance-steward"]);
    for (const skill of agent.skills) {
      expect(manifest.skills).toContain(`skills/${skill}`);
      expect(existsSync(path.join(root, "skills", skill, "SKILL.md"))).toBe(true);
    }
  });
});

describe("skills/seance-steward/SKILL.md front matter", () => {
  const fm = frontMatter(readFileSync(path.join(root, "skills", "seance-steward", "SKILL.md"), "utf8"));

  it("parses and has a description", () => {
    expect(fm).not.toBeNull();
    expect(fm?.["description"]?.length ?? 0).toBeGreaterThan(10);
  });

  it("is not always-on", () => {
    expect(fm?.["always"]).toBe("false");
  });
});

describe("no scheduler or summary command-line mode in the backend", () => {
  it("backend/src never reads process.argv", () => {
    const files = ["server.ts", "app.ts", "port.ts", "config.ts"];
    for (const f of files) expect(readFileSync(path.join(root, "backend", "src", f), "utf8"), f).not.toContain("process.argv");
  });
});
