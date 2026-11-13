# Implementation Plan: refusal-hardening

## Overview

Fixes three Minor findings from the code review of `onRefusal` (`demo-say-fixes`). Depends on `irc-bridge`, `mcp-tools` and `demo-say-fixes`. Tasks run in the order listed, one at a time, tests included. After each task `pnpm typecheck && pnpm test` must be green. Never edit `backend/vendor/irc-protocol/`, treat channel text as untrusted, and never log the secret.

## Tasks

- [x] 1. Redact before cutting
  - `cutText` and the redaction order in `dispatch.ts`: redact the raw reason and target, clean, redact again, cut last; the `(N more suppressed)` suffix is added after the cut. Note in `design.md` that no other place in `dispatch.ts` cuts before redacting.
  - Tests in `backend/test/refusal-hardening.test.ts`: a secret that crosses the 120-character reason cut and the 60-character target cut is fully redacted in the log entry and in the channel line; a secret split by a control character is redacted; the cut is still 120 and 60; no prefix of the secret appears.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 2. 441 and 443 reach the channel log
  - Numeric-aware channel and nick in the `case` for the refusals; the `server-error` payload stays as it is. Update the earlier 441 case in `refusals.test.ts` to the `<me> <nick> <channel> :text` form.
  - Tests: a line `Server refused (441): coder: …` in the channel of the third parameter, the same for 443, none and no new channel for an untracked channel, a three-parameter 441 logged only, the log entry has `target` and `nick`; the waiters of `summon` (442), `grant_op` (482) and `exorcise` (441) still resolve and the event payload is unchanged.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [x] 3. Rate limit repeated refusals
  - `backend/src/irc/refusal-limit.ts` (`RefusalLimiter`, 10 s window, 100 keys) and its use in `onRefusal`; the `server-error` event is emitted for every refusal.
  - Tests: `refusal-limit.test.ts` for the class; in `refusal-hardening.test.ts`, 20 identical refusals within 10 s give one `warn` and one line, the next one after the window says `(19 more suppressed)`, different numerics or channels are not suppressed, 20 events are still emitted, and the clock is the fake clock (no real wait).
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 4. Final checks and bundle
  - Add `refusal-hardening` to the spec lists in `AGENTS.md`, `README.md` and `docs/WRITEUP.md` (seven specs).
  - Run `pnpm typecheck && pnpm lint && pnpm test`, then `pnpm build` twice (identical output) and `pnpm check:dist` with `backend/dist/server.js` rebuilt.
  - _Requirements: 4.1, 4.2_

## Notes

- Do not commit or push.
- The limiter has no timer: the window is checked when a refusal arrives, so no timer needs cleanup on stop.
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
