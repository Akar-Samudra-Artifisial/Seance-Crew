# Implementation Plan: mcp-tools

## Overview

Depends on `irc-bridge` tasks 1 to 13. After each task `pnpm typecheck && pnpm test` must be green. Unit tests use the in-process fake ircd; no network. Tasks run in the order listed. Verify each task with `pnpm typecheck && pnpm test && pnpm lint` and by running the tests named in the task before ticking it.

## Tasks

- [x] 1. Check whether the gateway authenticates MCP calls
  - Read `~/.kiro/crew-venv/lib/python3.12/site-packages/kiro_crew/apps/bridges_mcp.py` (registration around lines 1022-1049, `_resolve_live_mcp_url` at line 120) and confirm that the gateway adds no header or secret to the registered HTTP MCP entry.
  - Result already recorded for Kiro Crew 0.12.1: it sends nothing. Re-check if the installed version differs (`kirocrew --version`). If it does send something, record the exact header in `.kiro/steering/kirocrew.md` and make task 2 require it (requirement 8.4).
  - Otherwise confirm that `.kiro/steering/security.md` contains the line "Accepted risk: any local process of the same user can call /mcp; destructive tools still need confirm:true" and that the README has a Security section with the same sentence.
  - Manual check, no code. Verified by the grep in task 12.
  - _Requirements: 8.3, 8.4_

- [x] 2. Local-caller guard
  - `src/http/guard.ts`: `checkLocalCaller` (Host 421, Origin 403, gateway-origin normalization for `127.0.0.1`/`localhost`/`[::1]`).
  - Tests: wrong Host → 421; Host without port → 421; `localhost:<port>` passes; foreign `Origin` → 403; gateway `Origin` incl. `localhost` spelling passes; `Origin: null` → 403; no `Origin` passes; unset `KIROCREW_GATEWAY_ORIGIN` plus any `Origin` → 403; fast-check that random Host strings never pass unless they match exactly.
  - _Requirements: 8.1, 8.2, 8.6_

- [x] 3. JSON-RPC core
  - `src/mcp/rpc.ts`: parse single and batch messages, build results and errors, codes `-32700/-32600/-32601/-32602`.
  - Tests: invalid JSON, non-object, missing `jsonrpc`, notification detection, batch with mixed notifications and requests.
  - _Requirements: 1.3, 1.4, 1.8_

- [x] 4. Hand-written validator
  - `src/mcp/validate.ts`: string (min/max, no CR/LF/NUL), int range, boolean, enum, optional, unknown-property rejection, channel and nick validators using the vendored `isValidChannel` and `isValidNick`.
  - Tests: each rule with passing and failing inputs; error messages name the property; fast-check that unknown keys always fail.
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 5. Untrusted wrapper
  - `src/mcp/untrusted.ts`: `wrapUntrusted` with escaping.
  - Tests: plain text, text containing `</untrusted>`, text containing `<untrusted source=…>`, empty text, multi-line text.
  - _Requirements: 6.1, 6.2_

- [x] 6. HTTP handler
  - `src/mcp/handler.ts` and route registration in `src/http.ts`: guard first, then `POST /mcp`, 405 for GET/DELETE, 413 above 64 KiB, `initialize` negotiation, `ping`; `/health` routed before the guard.
  - Tests with a real loopback `http.Server` on port 0: guard runs before body parsing (bad Host with oversized body → 421); each status code; version negotiation for three versions and an unknown one; 202 for notifications; `/health` needs no Host check.
  - _Requirements: 1.1, 1.2, 1.5, 1.6, 1.7, 8.1, 8.2, 8.5_

- [x] 7. Tool catalog and `tools/list`
  - `src/mcp/tools.ts` registry with the eight tool definitions and JSON Schemas.
  - Tests: exact tool names and order; every schema has `additionalProperties: false`; descriptions of text-returning tools contain "untrusted"; `grant_op` and `exorcise` descriptions mention `confirm: true`; unknown tool gives `-32602`.
  - _Requirements: 2.1, 2.2, 2.3, 3.5_

- [x] 8. Read tools: `list_channels`, `read`, `credits`
  - Implement against the store. `read` supports `since`, `limit`, `lost`, trimming to 32 KiB. `credits` returns per-channel and total credits plus `summary` from an injected `SummaryProvider` (`latest(): Summary | null`; the real one is wired in `steward-agent` task 5).
  - Tests: output shape, wrapped text in `content`, raw text and `untrusted: true` in `structuredContent`, unknown channel error, `lost` after ring eviction, no lines sent to the fake ircd, credits filter, "unavailable" wording, `summary` present with a stub provider and `null` without one.
  - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.6, 6.1, 6.3, 7.3_

- [x] 9. `whois` tool
  - Send `WHOIS`, await `318`, return parsed fields, time out at 5 s.
  - Tests: success with a `320 model:` line, no-such-nick (`401`), timeout with fake clock, listener cleanup after timeout.
  - _Requirements: 4.4_

- [x] 10. `say` and `summon`
  - `say` sends `PRIVMSG`; `summon` sends `INVITE`, waits for ready, maps `482`/`473`.
  - Tests: exact lines on the fake ircd; 400-character limit; multibyte text near the 512-byte limit rejected; summon ready, summon timeout (`ready: false`), summon refused; bridge not registered.
  - _Requirements: 5.1, 5.2, 5.3, 5.8, 5.9_

- [x] 11. `grant_op` and `exorcise` with confirmation
  - Require `confirm === true`; send `MODE` and `KICK`; wait for session-closed on exorcise; mark inbox items `granted` after `+o`.
  - Tests: missing, `false`, `"true"` (string) and `1` all refused with nothing sent; success paths send exactly one line; inbox update; reason default and length cap; CR/LF in reason rejected.
  - _Requirements: 5.4, 5.5, 5.6, 5.7, 3.3_

- [x] 12. Error mapping, busy limit, secret hygiene and docs check
  - Central try/catch mapping, concurrency cap 8, redacted logging.
  - Tests: thrown handler returns generic message with no stack; ninth concurrent call returns busy; the configured secret never appears in any tool result or log across the whole suite (assert over captured output); a docs test reads `.kiro/steering/security.md` and `README.md` and asserts both contain "any local process of the same user can call /mcp" and "confirm:true" (or the security line is replaced if task 1 found a credential).
  - _Requirements: 6.4, 7.1, 7.2, 7.4, 8.3_

- [x] 13. End-to-end MCP session test
  - One test drives `initialize` → `tools/list` → `summon` → `grant_op` (+v, with confirm) → `say` → `read` → `exorcise` against the fake ircd over loopback HTTP, with a valid Host header.
  - Asserts the full sequence of IRC lines and that channel text from the fake agent is wrapped as untrusted.
  - _Requirements: 1.1, 2.1, 5.2, 5.4, 5.5, 6.1_

## Notes

- Depends on `irc-bridge` tasks 1 to 13. The `credits` tool in task 8 reads a `SummaryProvider` that `steward-agent` task 6 wires in; task 8 uses a stub until then. `dashboard-ui` reuses the guard (task 2) and the validators (task 4).
- Never send a line to the server from a call that failed validation or lacks `confirm: true`, and never put channel text in a tool result without the `<untrusted>` wrapper.
- Task 1 is a manual source check; if the gateway is found to send a credential on MCP calls, update task 2 and the security steering file before continuing.
- Verify each task with `pnpm typecheck && pnpm test && pnpm lint`; tests use the fake ircd and a loopback `http.Server` on port 0.

## Task Dependency Graph

```json
{
  "waves": [
    {
      "id": 0,
      "tasks": [
        "1",
        "2",
        "3",
        "4",
        "5"
      ]
    },
    {
      "id": 1,
      "tasks": [
        "6",
        "7"
      ]
    },
    {
      "id": 2,
      "tasks": [
        "8"
      ]
    },
    {
      "id": 3,
      "tasks": [
        "9"
      ]
    },
    {
      "id": 4,
      "tasks": [
        "10"
      ]
    },
    {
      "id": 5,
      "tasks": [
        "11"
      ]
    },
    {
      "id": 6,
      "tasks": [
        "12"
      ]
    },
    {
      "id": 7,
      "tasks": [
        "13"
      ]
    }
  ]
}
```
