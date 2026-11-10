#!/usr/bin/env node
// Opt-in end-to-end check against a real Séance server.
// Plain ESM JavaScript: Node 22.12 does not strip TypeScript types by default.
// Runs only when SEANCE_E2E=1; otherwise prints "skipped" and exits 0.
// The real flow is specified in .kiro/specs/irc-bridge/tasks.md (task 15).
if (process.env.SEANCE_E2E !== "1") {
  process.stdout.write("e2e: skipped (set SEANCE_E2E=1 to run against a real server)\n");
  process.exit(0);
}

process.stderr.write("e2e: not implemented yet, see .kiro/specs/irc-bridge/tasks.md task 15\n");
process.exit(1);
