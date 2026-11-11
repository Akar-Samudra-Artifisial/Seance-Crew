// steward-agent task 7: the README documents trust, enable, the steward and the in-backend summary (Requirement 5.3).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readme = readFileSync(path.join(root, "README.md"), "utf8");

describe("README", () => {
  it("documents trusting and enabling the app", () => {
    expect(readme).toMatch(/^## Trust$/m);
    expect(readme).toContain("kirocrew config set agent.apps_trusted");
    expect(readme).toMatch(/^## Enable$/m);
    expect(readme).toContain("kirocrew app enable seance-crew");
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

  it("holds no secret", () => {
    expect(readme).not.toMatch(/^PASS\s+\S+:\S+/m);
    expect(readme).not.toMatch(/irc-secret|s3cret/i);
  });
});
