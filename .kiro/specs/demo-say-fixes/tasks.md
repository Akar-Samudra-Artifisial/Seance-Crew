# Implementation Plan: demo-say-fixes

## Overview

Fixes three faults from the live rehearsal of `docs/DEMO.md` (2026-11-13). Depends on `irc-bridge`, `mcp-tools` and `steward-agent` being implemented. Tasks run in the order listed, one at a time, tests included. After each task `pnpm typecheck && pnpm test` must be green. Never edit `backend/vendor/irc-protocol/`, treat channel text as untrusted, and never log the secret.

## Tasks

- [x] 1. Own messages in the channel log
  - `Store.addOwnMessage` and `consumeOwnEcho` with at most 20 markers that expire after 30 s; `say` calls `addOwnMessage` only after `trySend` succeeded; the `PRIVMSG` branch in `dispatch.ts` skips an echo of our own message.
  - Tests in `backend/test/own-message.test.ts`: one line from our nick after `say`; exactly one with an echo; a later same-text line from our nick is added; the same text from another nick is added; a failed `say` (not registered, rate limit, invalid line) adds none; an untracked channel gets none and is not created; formatting codes stripped; marker cap.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

- [x] 2. Server refusals are logged and shown
  - `onRefusal` in `dispatch.ts`: one `warn` log with numeric, target and a cleaned reason (control characters and formatting removed, 120 characters), one `system` line for a tracked channel, no state for anything else; the `server-error` event is still emitted.
  - Tests in `backend/test/refusals.test.ts`: a 404 after `say` is logged once and returned by `read` and `/api/state`; every numeric in the list; a nick or command target; an untracked channel; cleaning and cutting; the event still reaches a waiter; no secret in the log.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [x] 3. The steward asks for `+v` before the first `say`
  - `SKILL.md`: rule 10 and the flow step; `agents/seance-steward.json`: one sentence in `prompt`; `backend/test/steward-content.test.ts`: rule count ten and the new content checks for both files.
  - Test: the rule is present in the skill and in the agent prompt, in both its parts (ask and wait for `+v`; no `say` without `+v` or `+o`).
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 4. Demo text and final checks
  - `docs/DEMO.md` step 3: the steward asks for `+v` first, and the log shows the crew account's own message to `coder` (and a refusal line when the server refuses); the README steward bullet mentions it.
  - Run `pnpm typecheck && pnpm lint && pnpm test`, then `pnpm build` twice (identical output) and `pnpm check:dist` with `backend/dist/server.js` rebuilt.
  - _Requirements: 4.1, 4.2, 4.3_

## Notes

- Do not commit or push. The orchestrator re-runs the rehearsal against the live gateway after the build is installed.
- The own-message line uses the kind `privmsg`, the kind every channel message already has, so the dashboard and `read` need no change.
- Verify each task with `pnpm typecheck && pnpm test` and by running the tests named in the task before ticking it.

## Task Dependency Graph

```json
{
  "waves": [
    {
      "id": 0,
      "tasks": [
        "1"
      ]
    },
    {
      "id": 1,
      "tasks": [
        "2"
      ]
    },
    {
      "id": 2,
      "tasks": [
        "3"
      ]
    },
    {
      "id": 3,
      "tasks": [
        "4"
      ]
    }
  ]
}
```
