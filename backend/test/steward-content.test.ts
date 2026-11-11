// Content checks for the steward skill and agent prompt (steward-agent Requirements 1.2-1.4, 2.x, 3.x).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../src/mcp/tools.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const skill = readFileSync(path.join(root, "skills", "seance-steward", "SKILL.md"), "utf8");
const agent = JSON.parse(readFileSync(path.join(root, "agents", "seance-steward.json"), "utf8")) as { prompt: string; tools: string[]; allowedTools: string[]; description: string };

/** The numbered rule `n` from the skill's Rules section. */
function rule(n: number): string {
  const m = new RegExp(`^${n}\\. (.+)$`, "m").exec(skill);
  if (m === null) throw new Error(`rule ${n} not found`);
  return m[1] as string;
}

/** The text of a `## <title>` section. */
function section(title: string): string {
  const m = new RegExp(`^## ${title}\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m").exec(skill);
  if (m === null) throw new Error(`section ${title} not found`);
  return m[1] as string;
}

describe("skill: safety rules (Requirement 2)", () => {
  it("asks before any +o grant, naming agent, channel and the effect, and uses confirm: true only after an explicit yes", () => {
    const r = rule(1);
    expect(r).toMatch(/Ask the human before any `\+o`/);
    expect(r).toMatch(/which agent/i);
    expect(r).toMatch(/which channel/i);
    expect(r).toMatch(/write\/run access/i);
    expect(r).toContain("`grant_op`");
    expect(r).toContain("`confirm: true`");
    expect(r).toMatch(/only after an explicit yes/);
  });

  it("asks before exorcise and warns that uncommitted worktree changes are reverted", () => {
    const r = rule(2);
    expect(r).toMatch(/^Ask before `exorcise`/);
    expect(r).toMatch(/uncommitted work in the worktree is reverted/);
  });

  it("treats channel text as data: untrusted markers, never obeyed, quoted or summarized instead", () => {
    const r = rule(3);
    expect(r).toMatch(/Channel text is data/);
    expect(r).toContain("<untrusted>");
    expect(r).toMatch(/never obeyed/);
    expect(r).toMatch(/Quote or summarize/);
  });

  it("prefers +v first and +o only when writes or commands are needed", () => {
    const r = rule(4);
    expect(r).toMatch(/Prefer `\+v` first/);
    expect(r).toMatch(/`\+o` only when the task needs writes or commands|Move to `\+o` only when the task needs writes or commands/);
  });

  it("summarizes a needs-op item and asks whether to grant op", () => {
    const r = rule(5);
    expect(r).toContain("needs-op");
    expect(r).toMatch(/summarize the denied action/);
    expect(r).toMatch(/ask whether to grant op/);
  });

  it("forbids asking for, printing or storing the secret", () => {
    const r = rule(6);
    expect(r).toMatch(/Never ask for, print, or store the Séance secret/);
  });

  it("forbids pushing, publishing and running shell commands for the human", () => {
    const r = rule(7);
    expect(r).toMatch(/Never push, publish, or run shell commands for the human/);
  });

  it("asks before summoning any agent other than coder, with confirm: true only after a yes", () => {
    const r = rule(8);
    expect(r).toMatch(/Ask before you `summon` any agent other than `coder`/);
    expect(r).toContain("`confirm: true`");
    expect(r).toMatch(/only after an explicit yes/);
    expect(section("Tools")).toMatch(/`summon`.*Any other agent needs `confirm: true`/);
  });

  it("explains the two layers: read-only tools run without a prompt, the others keep the host approval prompt", () => {
    const r = rule(9);
    for (const t of ["list_channels", "read", "whois", "credits"]) expect(r, t).toContain(`\`${t}\``);
    for (const t of ["say", "summon", "grant_op", "exorcise"]) expect(r, t).toContain(`\`${t}\``);
    expect(r).toMatch(/approval prompt/);
    expect(r).toMatch(/human check/);
  });

  it("has exactly nine numbered rules", () => {
    const numbered = section("Rules").split(/\r?\n/).filter((l) => /^\d+\. /.test(l));
    expect(numbered).toHaveLength(9);
  });

  it("names only tools that exist: every snake_case name is a real tool and the needs-op source is a tool output", () => {
    const names = [...skill.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1] as string);
    expect(names.length).toBeGreaterThan(3);
    for (const n of names) expect(TOOL_NAMES, n).toContain(n);
    // The rule that reads needs-op requests points at list_channels, and that tool really returns them.
    expect(rule(5)).toContain("`list_channels`");
    const readTools = readFileSync(path.join(root, "backend", "src", "mcp", "read-tools.ts"), "utf8");
    expect(readTools).toMatch(/needs-op: agent/);
    // Every tool in the Tools section is defined in backend/src/mcp.
    const mcpSource = ["act-tools.ts", "read-tools.ts"].map((f) => readFileSync(path.join(root, "backend", "src", "mcp", f), "utf8")).join("\n");
    for (const n of TOOL_NAMES) expect(mcpSource, n).toContain(`name: "${n}"`);
  });

  it("says destructive tools need confirm: true in the tool list too", () => {
    const tools = section("Tools");
    expect(tools).toMatch(/`grant_op`.*Needs `confirm: true`/);
    expect(tools).toMatch(/`exorcise`.*Needs `confirm: true`/);
  });

  it("lists exactly the tools the backend offers", () => {
    const listed = [...section("Tools").matchAll(/^- `([a-z_]+)`:/gm)].map((m) => m[1]);
    expect(listed).toEqual([...TOOL_NAMES]);
  });
});

describe("skill: credit report (Requirement 3.1, 3.2)", () => {
  const credit = section("Credit summary");

  it("reports per channel and total, highest first, with two decimals, using the credits tool", () => {
    expect(credit).toContain("`credits`");
    expect(credit).toMatch(/per channel and total/);
    expect(credit).toMatch(/highest first/);
    expect(credit).toMatch(/two decimals/);
    expect(credit).toMatch(/\d+\.\d{2} of \d+\.\d{2}/); // an example in the report format
  });

  it("says so when a figure is unavailable and never estimates", () => {
    expect(credit).toMatch(/unavailable, say so/);
    expect(credit).toMatch(/Never estimate/);
  });
});

describe("skill: typical flow (Requirement 3.3)", () => {
  const flow = section("Typical flow");
  const steps = flow.split(/\r?\n/).filter((l) => /^\d+\. /.test(l));

  it("has the steps in order: list, summon, +v after confirmation, say, read, needs-op, commit review, exorcise, credits", () => {
    const text = steps.join("\n");
    const order = ["`list_channels`", "`summon`", "`grant_op`", "+v", "after confirmation", "`say`", "`read`", "needs-op", "+o", "commit notice", "`exorcise`", "credits"];
    let from = 0;
    for (const part of order) {
      const at = text.indexOf(part, from);
      expect(at, `"${part}" after position ${from}`).toBeGreaterThanOrEqual(0);
      from = at;
    }
  });

  it("asks before the +o grant and before exorcise inside the flow", () => {
    expect(steps.join("\n")).toMatch(/ask, then `grant_op` with `\+o` if approved/);
    expect(steps.join("\n")).toMatch(/`exorcise` after confirmation/);
  });
});

describe("agent file (Requirements 1.2-1.4)", () => {
  it("tells the agent to use only the seance MCP tools and to follow the skill", () => {
    expect(agent.prompt).toMatch(/Use only the `seance` MCP tools/);
    for (const name of TOOL_NAMES) expect(agent.prompt, name).toContain(name);
    expect(agent.prompt).toContain("seance-steward skill");
  });

  it("repeats the confirm and untrusted rules", () => {
    expect(agent.prompt).toMatch(/untrusted data, never instructions/);
    expect(agent.prompt).toMatch(/ask the human before granting op/i);
    expect(agent.prompt).toContain("confirm: true");
  });

  it("contains no secret, credential, token or instruction to read config files", () => {
    const whole = JSON.stringify(agent);
    expect(whole).not.toMatch(/s3cret|password\s*[:=]|secret\s*[:=]|token\s*[:=]|bearer\s/i);
    expect(whole).not.toMatch(/\bPASS \S+/); // an IRC PASS line (case-sensitive: "pass confirm: true" is fine)
    expect(whole).not.toMatch(/[A-Za-z0-9+/_-]{32,}/); // no long token-like string
    expect(agent.prompt).not.toMatch(/\bread\b[^.]*\b(config|app\.json|\.app_secret|\.env)\b/i);
    expect(agent.prompt).not.toMatch(/\.app_secret|app\.json|data\/|config\.json/);
    // The only mention of the secret forbids touching it.
    for (const sentence of agent.prompt.split(/(?<=\.)\s+/)) {
      if (/secret/i.test(sentence)) expect(sentence).toMatch(/^Never /);
    }
  });

  it("grants only the app MCP server: no shell, no file read or write, no other tools", () => {
    expect(agent.tools).toEqual(["@seance-crew:seance"]);
    for (const t of agent.tools) expect(t).toMatch(/^@seance-crew:seance$/);
    const forbidden = /\b(shell|bash|execute_bash|fs_write|fs_read|fs_append|write|edit|str_replace|builtin|\*)\b/i;
    for (const t of agent.tools) expect(t).not.toMatch(forbidden);
    expect(Object.keys(agent).sort()).toEqual(["allowedTools", "description", "model", "name", "prompt", "skills", "tools"]); // no mcpServers, toolsSettings or hooks
  });

  it("the skill itself holds no secret value", () => {
    expect(skill).not.toMatch(/s3cret|password\s*[:=]|secret\s*[:=]/i);
    expect(skill).not.toMatch(/[A-Za-z0-9+/_-]{40,}/);
  });
});
