#!/usr/bin/env node
// Bundles a workspace package with esbuild. Usage: node scripts/build.mjs <backend|ui>
// Skips (exit 0) while the package has no entry file yet, so `pnpm build` is green
// on the bare scaffold.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];

const targets = {
  backend: {
    entry: "backend/src/server.ts",
    options: {
      platform: "node",
      format: "esm",
      target: "node22",
      outfile: "backend/dist/server.js",
    },
  },
  ui: {
    entry: "ui/src/App.tsx",
    options: {
      platform: "browser",
      format: "esm",
      target: "es2022",
      jsx: "automatic",
      outfile: "ui/dist/index.mjs",
      external: ["react", "react-dom", "react/jsx-runtime", "@kirocrew/app-sdk", "@kirocrew/app-sdk/ui", "lucide-react"],
    },
  },
};

const spec = targets[target];
if (spec === undefined) {
  process.stderr.write(`build: unknown target "${String(target)}" (expected backend or ui)\n`);
  process.exit(1);
}

const entry = path.join(root, spec.entry);
if (!existsSync(entry)) {
  process.stdout.write(`build: ${spec.entry} does not exist yet, skipping ${target}\n`);
  process.exit(0);
}

await build({
  absWorkingDir: root,
  entryPoints: [entry],
  bundle: true,
  legalComments: "none",
  logLevel: "info",
  ...spec.options,
});
