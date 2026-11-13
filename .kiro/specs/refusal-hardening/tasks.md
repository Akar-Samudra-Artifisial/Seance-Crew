# Implementation Plan: refusal-hardening

## Overview

Fixes three Minor findings from the code review of `onRefusal` (`demo-say-fixes`), tasks 1 to 4, and then one Medium finding from the security review and two Minor findings from the review of commit d11ab18, tasks 5 to 7. Depends on `irc-bridge`, `mcp-tools` and `demo-say-fixes`. Tasks run in the order listed, one at a time, tests included. After each task `pnpm typecheck && pnpm test` must be green. Never edit `backend/vendor/irc-protocol/`, treat channel text as untrusted, and never log the secret.

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

- [x] 5. Global budget and safe eviction in the limiter
  - `RefusalLimiter`: a global budget of 20 reports per 10 s window, eviction of expired slots only (oldest first), no store for a new key when every slot is open, the held count of an evicted expired slot added to the global count, and a `summary` figure on the decision.
  - Tests in `backend/test/refusal-limit.test.ts`: 200 different keys in one window give 20 reports; the summary is handed over once with the next allowed report; an open key is never evicted or reset by a flood; a full map of open keys stores nothing new; an expired slot's held count reaches the summary; a clock step back opens a new window. Update the two older tests that assumed oldest-first eviction of open keys (named in `design.md`).
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.7_

- [x] 6. Use the limiter's summary and a per-nick, bounded key in `onRefusal`
  - `dispatch.ts`: `refusalKey(numeric, target, nick)` (cut and lower-cased target, nick for 441 and 443 when `isValidNick`), one `warn` summary entry before a report that carries a `summary`, and the nick left out of the line and the log when it is not valid.
  - Tests in `backend/test/refusal-hardening.test.ts`: 200 refusals for 200 targets give at most 20 reports and one summary after the window; a tracked channel's key survives a flood; an evicted expired slot's count appears in the summary; two nicks in one channel with 441 are both reported; an invalid nick is omitted; the key stays bounded for a 5,000 character target; `server-error` is emitted for every refusal.
  - _Requirements: 5.2, 5.6, 5.8, 6.1, 6.2, 6.3, 7.1_

- [x] 7. Final checks and bundle for the extension
  - Run `pnpm typecheck && pnpm lint && pnpm test`, then `pnpm build` twice (identical output) and `pnpm check:dist` with `backend/dist/server.js` rebuilt. The spec count in `README.md`, `docs/WRITEUP.md` and `AGENTS.md` does not change.
  - _Requirements: 7.2, 7.3_

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
    },
    {
      "id": 4,
      "tasks": [
        "5"
      ]
    },
    {
      "id": 5,
      "tasks": [
        "6"
      ]
    },
    {
      "id": 6,
      "tasks": [
        "7"
      ]
    }
  ]
}
```
