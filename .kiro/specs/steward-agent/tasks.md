# Implementation Plan: steward-agent

## Overview

Depends on `irc-bridge` (tasks 1 to 13) for the store and paths, and on `mcp-tools` for the tool names. After each task `pnpm typecheck && pnpm test` must be green. No network in tests. Tasks run in the order listed. Verify each task with `pnpm typecheck && pnpm test && pnpm lint` and by running the tests named in the task before ticking it.

## Tasks

- [ ] 1. Verify the agent tool reference for the app MCP server
  - Prerequisite of the agent file task (task 2). Check against the Kiro Crew source which form resolves: `~/.kiro/crew-venv/lib/python3.12/site-packages/kiro_crew/apps/bridges_mcp.py:1022` (server registered as `seance-crew:seance`) and `bridges_agents.py:546` and `:573-615` (`@server` refs resolved against the agent's `mcpServers` plus the global `mcp.json`). Expected result: `@seance-crew:seance`, not `@seance`.
  - Then confirm on a live gateway (`kirocrew app dev seance-crew` with a built backend from `irc-bridge` task 13): the steward lists the eight tools. Record the form that works in `.kiro/steering/kirocrew.md`.
  - Manual check with the result written to the steering file; the test in task 2 pins the value.
  - _Requirements: 1.5_

- [ ] 2. Agent file and manifest consistency tests
  - Update `agents/seance-steward.json` `tools` to the form verified in task 1. `backend/test/manifest.test.ts`: parse `app.json`, the agent file and the skill front matter; check references, the pinned tool reference, `credentialMasks` ⊆ config schema keys, no `setup.onUpdate`, no secret-looking default, no `crons` key, no cron permission, `permissions.api` contains `/api/summary`.
  - _Requirements: 1.1, 1.5, 4.1, 5.1, 5.2_

- [ ] 3. Skill and prompt content checks
  - Tests assert the skill mentions `+o` confirmation, `confirm: true`, "untrusted", the exorcise warning, the secret rule, the credit report format, and the typical flow; the agent prompt contains no secret and no shell/file tools.
  - Adjust the wording of `SKILL.md` or the agent prompt if a test shows a gap.
  - _Requirements: 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3_

- [ ] 4. Credits snapshot writer and loader
  - `src/credits-snapshot.ts`: subscribe to store credit changes, coalesce to ≤ 1 write per 10 s, atomic temp+rename, mode 600, paths from `appPaths`; loader seeds stale values at start.
  - Tests with fake clock and temp dir: coalescing, final write on shutdown, file mode, content has no secret, malformed file ignored, loaded values marked stale.
  - _Requirements: 4.8, 4.10_

- [ ] 5. Daily summary service
  - `src/summary.ts`: `createSummaryService` per the design: schedule, catch-up on start, 24 h re-arm, WHOIS refresh through the send queue, stale fallback, `summary.json` atomic write with history ≤ 30, `stop()`.
  - Tests (fake clock, fake timers, temp dir, fake ircd): first run when missing; catch-up at 25 h; no catch-up at 2 h with the timer armed for the remainder; runs 24 h apart; `stale` when not registered; 10-minute fallback; history cap; mode 600; no secret in the file; `stop()` clears the timer; zero extra sockets or processes created; no summary command-line flag or CLI mode exists (grep over `backend/src`).
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.10, 4.11_

- [ ] 6. Wire the summary into the API and the MCP `credits` tool
  - Provide `SummaryProvider` from the service to `GET /api/summary` (`dashboard-ui` task 4) and the `credits` tool (`mcp-tools` task 8); start and stop the service in `server.ts`.
  - Tests: both surfaces return the same summary, or `null` before the first run; shutdown stops the timer.
  - _Requirements: 4.9_

- [ ] 7. README and docs
  - README sections: trust and enable, what the steward does, what the daily summary does (inside the backend, no model call, no cron, files in `data/`).
  - Test: `pnpm lint` passes (no forbidden word, no secrets) and a docs test asserts the README mentions the in-backend summary and does not mention a cron.
  - _Requirements: 5.3_

## Notes

- Depends on `irc-bridge` tasks 1 to 13 (store, send queue, paths) and on `mcp-tools` tasks 8 and 10 to 11 for the tool names. Task 6 wires the summary into `dashboard-ui` task 4 (`/api/summary`) and `mcp-tools` task 8 (`credits`).
- Never add a cron entry, a cron permission or a command-line mode, and never open a second connection or process for the summary.
- Task 1 gates the agent file: if the live gateway needs a different tool reference than `@seance-crew:seance`, change both the file and the design.
- Verify each task with `pnpm typecheck && pnpm test && pnpm lint`; no network in tests.

## Task Dependency Graph

```json
{
  "waves": [
    {
      "id": 0,
      "tasks": [
        "1",
        "4"
      ]
    },
    {
      "id": 1,
      "tasks": [
        "2",
        "5"
      ]
    },
    {
      "id": 2,
      "tasks": [
        "3",
        "6"
      ]
    },
    {
      "id": 3,
      "tasks": [
        "7"
      ]
    }
  ]
}
```
