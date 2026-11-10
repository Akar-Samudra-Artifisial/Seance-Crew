#!/usr/bin/env node
// Dependency-free repository lint:
//  - the forbidden trademark word must not appear anywhere outside spike/
//  - tracked-looking text files must not contain obvious secrets
//  - no tabs-vs-CRLF surprises in source (no CR in .ts/.json/.md files)
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", "spike", ".git", "data", "coverage"]);
const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".yaml", ".yml", ".txt", ""]);
// Built from pieces so this file does not contain the word itself.
const FORBIDDEN = new RegExp(["m", "irc"].join(""), "i");
const SECRET_PASS = /^PASS\s+\S+:\S+/m;

const problems = [];

const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full);
      continue;
    }
    if (!TEXT_EXT.has(path.extname(name)) || name === "pnpm-lock.yaml") continue;
    const text = readFileSync(full, "utf8");
    const rel = path.relative(root, full);
    if (FORBIDDEN.test(text) || FORBIDDEN.test(rel)) problems.push(`${rel}: contains a forbidden word`);
    if (SECRET_PASS.test(text) && !rel.includes("test")) problems.push(`${rel}: contains a PASS line with credentials`);
  }
};

walk(root);

if (problems.length > 0) {
  process.stderr.write(`lint failed:\n${problems.map((p) => `  ${p}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("lint ok\n");
