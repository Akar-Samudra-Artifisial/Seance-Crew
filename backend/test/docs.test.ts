// steward-agent task 7 (README: trust, enable, steward, in-backend summary) and demo-writeup tasks 1 to 5
// (DEMO.md, WRITEUP.md and README stay true to the code).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../src/mcp/tools.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(path.join(root, rel), "utf8");

const readme = read("README.md");
const demo = read("docs/DEMO.md");
const writeup = read("docs/WRITEUP.md");
const manifest = JSON.parse(read("app.json")) as { permissions: { api: string[] } };
const agent = JSON.parse(read("agents/seance-steward.json")) as { allowedTools: string[] };

const DOCS: readonly { readonly rel: string; readonly text: string }[] = [
  { rel: "README.md", text: readme },
  { rel: "docs/DEMO.md", text: demo },
  { rel: "docs/WRITEUP.md", text: writeup },
];

// Built from pieces so this file does not contain the word itself (scripts/lint.mjs scans it).
const FORBIDDEN = new RegExp(["m", "irc"].join(""), "i");

const headings = (text: string): string[] => [...text.matchAll(/^#{1,3} (.+)$/gm)].map((m) => m[1]!.trim());
const SCREENSHOTS = ["dashboard-overview.png", "needs-op-inbox.png", "grant-op-confirm.png", "commit-and-credits.png", "crew-chat-summon.png", "exorcise-confirm.png"];

describe("README", () => {
  it("documents trusting and enabling the app", () => {
    expect(readme).toMatch(/^## Trust$/m);
    expect(readme).toContain("kirocrew config set agent.apps_trusted '[\"seance-crew\"]'");
    expect(readme).toMatch(/^## Enable$/m);
    expect(readme).toContain("kirocrew app enable seance-crew");
  });

  it("has the required sections", () => {
    const h = headings(readme);
    for (const name of ["Install", "Trust", "Enable", "Configure", "Develop", "Security", "Links", "License"]) expect(h, name).toContain(name);
    expect(h.some((x) => x.startsWith("Use"))).toBe(true);
    expect(h.some((x) => x.startsWith("Screenshots"))).toBe(true);
    expect(readme).toContain("kirocrew app install");
    expect(readme).toContain("kirocrew app dev seance-crew");
  });

  it("has the configuration table", () => {
    for (const key of ["host", "nick", "secret"]) expect(readme).toContain(`| \`${key}\` |`);
  });

  it("describes what the steward does and that it asks first", () => {
    expect(readme).toMatch(/^## Use the steward$/m);
    expect(readme).toContain("seance-steward");
    expect(readme).toMatch(/asks you before it grants `\+o`, exorcises an agent, or summons any agent other than `coder`/);
    expect(readme).toMatch(/read-only tools \(`list_channels`, `read`, `whois`, `credits`\) without a prompt/);
    expect(readme).toMatch(/`say`, `summon`, `grant_op` and `exorcise` still go through the Kiro Crew approval prompt/);
    expect(readme).toContain("confirm: true");
  });

  it("says the daily summary runs inside the backend, with no model call and no cron", () => {
    expect(readme).toMatch(/^## Daily credit summary$/m);
    expect(readme).toMatch(/timer inside the backend process/);
    expect(readme).toMatch(/no model call/);
    expect(readme).toMatch(/no cron/i);
    expect(readme).toContain("data/summary.json");
    expect(readme).toContain("data/credits.json");
  });

  it("never offers a cron: every mention of cron is a negation", () => {
    const mentions = readme.split(/\r?\n/).filter((line) => /cron/i.test(line));
    expect(mentions.length).toBeGreaterThan(0);
    for (const line of mentions) {
      expect(line, line).toMatch(/\bno cron\b|\bnot (a )?cron\b|\bwithout (a )?cron\b/i);
      expect(line, line).not.toMatch(/\bcrontab\b|\*\/\d+|"crons"|add(s|ed)? a cron/i);
    }
  });

  it("does not claim the summary runs through a command-line mode or a second process", () => {
    expect(readme).not.toMatch(/--summary|summary command|node .*summary/i);
  });

  it("states the security rules and the accepted risk", () => {
    expect(readme).toContain("Accepted risk: any local process of the same user can call /mcp; destructive tools still need confirm:true");
    expect(readme).toMatch(/never logged/);
    expect(readme).toMatch(/untrusted data/);
    expect(readme).toContain("`confirm: true`");
  });

  it("says the app SDK is not on npm and the UI installs with --legacy-peer-deps", () => {
    expect(readme).toContain("@kirocrew/app-sdk");
    expect(readme).toMatch(/not on npm/);
    expect(readme).toContain("npm install --legacy-peer-deps");
  });

  it("lists the six screenshots and embeds each one", () => {
    for (const name of SCREENSHOTS) {
      expect(readme, name).toContain(`\`${name}\``);
      expect(readme, name).toContain(`(docs/img/${name})`);
    }
  });

  it("links to both documents", () => {
    expect(readme).toContain("(docs/DEMO.md)");
    expect(readme).toContain("(docs/WRITEUP.md)");
  });
});

describe("docs/DEMO.md", () => {
  it("has the required sections", () => {
    const h = headings(demo);
    for (const name of ["What you will see", "Prerequisites", "Script", "Recovery", "Cleanup"]) expect(h, name).toContain(name);
  });

  it("contains both chat prompts verbatim", () => {
    expect(demo).toContain("summon coder into #crew-live and ask it to fix the failing test");
    expect(demo).toContain("exorcise coder");
  });

  it("has eight script steps in order", () => {
    const rows = demo.split(/\r?\n/).filter((line) => /^\| \d+ \|/.test(line));
    expect(rows.map((r) => Number(/^\| (\d+) \|/.exec(r)![1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const row of rows) expect(row.split("|").length, row).toBe(7); // five cells plus the two outer pipes
  });

  it("shows the dashboard events in the required order", () => {
    const order = ["worktree ready", "was denied", "Grant op", "committed", "Credits used", "worktree reset to"].map((s) => demo.indexOf(s, demo.indexOf("## Script")));
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("copies the confirmation dialog strings from the UI", () => {
    expect(demo).toContain("Grant +o to coder in #crew-live?");
    expect(demo).toContain("Exorcise coder from #crew-live?");
    expect(demo).toContain("Session closed in #crew-live; worktree reset to <sha>.");
  });

  it("asks for a channel that was never used, and for another unused channel on a retake", () => {
    // A reused channel keeps its worktree and the agent's memory, and sends no `worktree ready` notice.
    expect(demo).toMatch(/`#crew-live` has never been used on the Séance server/);
    expect(demo).toMatch(/fresh worktree/);
    expect(demo).toMatch(/no memory of earlier sessions/);
    expect(demo).toMatch(/For a retake, use another unused channel name \(for example `#crew-live2`\) in every step/);
    // The old, used channel name (built from pieces so a search for it finds nothing here).
    expect(demo).not.toContain(["crew", "demo"].join("-"));
  });

  it("lists the prerequisites", () => {
    expect(demo).toContain("kirocrew config set agent.apps_trusted '[\"seance-crew\"]'");
    expect(demo).toContain("SEANCE_INVITERS");
    expect(demo).toMatch(/`crew` nick is a member of `#crew-live`/);
    expect(demo).toMatch(/does not need `\+o` to see the needs-op item/);
    expect(demo).toMatch(/ask the steward to `say` the task again/);
    expect(demo).toMatch(/exactly one failing test/);
  });

  it("reflects that only the read-only tools are auto-approved", () => {
    expect(demo).toMatch(/`list_channels`, `read`, `whois` and `credits` without a prompt/);
    expect(demo).toMatch(/`say`, `summon`, `grant_op` and `exorcise` each show the Kiro Crew approval prompt/);
    expect(agent.allowedTools.map((t) => t.split("/").pop())).toEqual(["list_channels", "read", "whois", "credits"]);
  });
});

describe("docs/WRITEUP.md", () => {
  it("has the required sections", () => {
    const h = headings(writeup);
    for (const name of ["Summary", "Features", "Architecture", "Security model", "How Kiro built it", "Try it", "Links"]) expect(h, name).toContain(name);
  });

  it("has the Mermaid diagram and a text version", () => {
    expect(writeup).toMatch(/```mermaid\nflowchart LR[\s\S]*?```/);
    for (const part of ["MCP /mcp", "one WSS connection", "Séance ircd", "Podman sandbox"]) expect(writeup, part).toContain(part);
    expect(writeup).toMatch(/^Text version: /m);
  });

  it("links the Séance repository and the Kiro Crew documentation", () => {
    expect(writeup).toContain("https://github.com/Akar-Samudra-Artifisial/Seance");
    expect(writeup).toContain("https://kiro.dev/docs/crew/");
  });

  it("names every MCP tool, and every tool in the tool list exists in the catalog", () => {
    for (const name of TOOL_NAMES) expect(writeup, name).toContain(`\`${name}\``);
    const line = writeup.split(/\r?\n/).find((l) => l.startsWith("- MCP tools"));
    expect(line).toBeDefined();
    const listed = [...line!.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!);
    expect(listed).toEqual([...TOOL_NAMES]);
  });

  it("states the security model items", () => {
    for (const part of ["never logged", "Untrusted channel text", "`confirm: true`", "512 bytes", "One connection", "X-KiroCrew-Proxy", "Origin", "Accepted risk"]) expect(writeup, part).toContain(part);
  });

  // Kiroween 2026 rules, section 4: disclose any pre-existing code or work incorporated into the project.
  it("discloses the vendored code in a Pre-existing code section between How Kiro built it and Try it", () => {
    const h = headings(writeup);
    expect(h).toContain("Pre-existing code");
    expect(h.indexOf("Pre-existing code")).toBe(h.indexOf("How Kiro built it") + 1);
    expect(h.indexOf("Try it")).toBe(h.indexOf("Pre-existing code") + 1);
    const section = /^## Pre-existing code\r?\n([\s\S]*?)(?=^## )/m.exec(writeup)?.[1] ?? "";
    expect(section).toContain("backend/vendor/irc-protocol");
    expect(section).toContain("https://github.com/Akar-Samudra-Artifisial/Seance");
    expect(section).toContain("MIT");
    expect(section).toMatch(/unchanged/);
    expect(section).toContain("../backend/vendor/irc-protocol/NOTICE");
    expect(existsSync(path.join(root, "backend/vendor/irc-protocol/NOTICE"))).toBe(true);
  });

  it("points to real specs, steering files and hooks", () => {
    for (const spec of ["irc-bridge", "mcp-tools", "dashboard-ui", "steward-agent", "demo-writeup"]) {
      expect(writeup, spec).toContain(`\`${spec}\``);
      for (const file of ["requirements.md", "design.md", "tasks.md"]) expect(existsSync(path.join(root, ".kiro/specs", spec, file)), `${spec}/${file}`).toBe(true);
    }
    for (const file of ["product", "tech", "kirocrew", "irc-seance", "security"]) {
      expect(writeup, file).toContain(`\`${file}.md\``);
      expect(existsSync(path.join(root, ".kiro/steering", `${file}.md`)), file).toBe(true);
    }
    for (const hook of ["guard-shell", "verify-after-task"]) {
      expect(writeup, hook).toContain(`\`${hook}`);
      expect(existsSync(path.join(root, ".kiro/hooks", `${hook}.json`)), hook).toBe(true);
    }
  });
});

describe("all documents", () => {
  it("mention only dashboard API paths that are in permissions.api", () => {
    let seen = 0;
    for (const { rel, text } of DOCS) {
      for (const m of text.matchAll(/\/api\/[a-z][a-z/-]*[a-z]/g)) {
        seen += 1;
        expect(
          manifest.permissions.api.some((p) => p.endsWith(m[0])),
          `${rel}: ${m[0]}`,
        ).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(0);
    for (const p of manifest.permissions.api) expect(writeup, p).toContain(p.slice(p.indexOf("/api/")));
  });

  it("mention only MCP tool names that exist", () => {
    // Backticked snake_case words that look like tool names (contain an underscore) must be in the catalog.
    const allowed = new Set([...TOOL_NAMES, "apps_trusted", "node_modules"]);
    for (const { rel, text } of DOCS) {
      for (const m of text.matchAll(/`([a-z]+_[a-z_]+)`/g)) expect(allowed.has(m[1]!), `${rel}: ${m[1]}`).toBe(true);
    }
  });

  it("have relative links that resolve, screenshots included", () => {
    let checked = 0;
    for (const { rel, text } of DOCS) {
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1]!;
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
        const file = path.resolve(root, path.dirname(rel), target.split("#")[0]!);
        checked += 1;
        expect(existsSync(file), `${rel}: ${target}`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("hold no secret and not the forbidden word", () => {
    for (const { rel, text } of DOCS) {
      expect(text, rel).not.toMatch(/^PASS\s+\S+:\S+/m);
      expect(text, rel).not.toMatch(/irc-secret|s3cret/i);
      expect(text, rel).not.toMatch(/\bsecret["']?\s*[:=]\s*["'][^"']+["']/i);
      expect(FORBIDDEN.test(text), rel).toBe(false);
    }
  });
});
