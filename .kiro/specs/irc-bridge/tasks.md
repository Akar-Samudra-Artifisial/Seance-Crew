# Implementation Plan: irc-bridge

## Overview

Work in order. After each task `pnpm typecheck && pnpm test` must be green. Unit tests use the in-process fake ircd (`test/fakeIrcd.ts`); no network. Tasks run in the order listed. Verify each task with `pnpm typecheck && pnpm test && pnpm lint` and by running the tests named in the task before ticking it.

## Tasks

- [x] 1. Backend skeleton and logger
  - Create `backend/src/server.ts` (reads `PORT`, exits with a clear error if invalid) and `src/log.ts` with redaction.
  - Tests: logger replaces secret values and `PASS` lines; error for missing or non-numeric `PORT`.
  - _Requirements: 9.1, 9.2, 10.4_

- [x] 2. App paths
  - `src/paths.ts`: `resolveAppRoot(importMetaUrl)` (walk up to `app.json`), `appPaths(root)`; `data/` created with mode 700.
  - Tests with temp directories: installed layout (`backend/dist/server.js`), dev layout (`backend/src/x.ts`), no `app.json` found → error naming the start directory, `process.cwd()` and env changes have no effect, mode 700.
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

- [x] 3. Outbound line builder
  - `src/irc/line.ts`: `buildLine` with the 512-byte, CR/LF/NUL, `isValidNick`, `isValidChannel` checks and stable error codes.
  - Tests: boundary at 512 bytes with multibyte text; injection attempts; fast-check property on output shape (P1).
  - _Requirements: 4.5, 5.1, 5.2, 5.3_

- [x] 4. Send queue
  - `src/irc/queue.ts`: burst 8, then 1 line/s, depth limit 100, priority bypass for `PONG`/`QUIT`; injected clock.
  - Tests: 20 lines produce 8 immediately then 1 per second; queue-full rejects low priority only; `PONG` not delayed.
  - _Requirements: 3.1, 5.4, 5.5_

- [x] 5. Ring buffer
  - `src/irc/ring.ts`: capacity 500, sequence numbers, `since(seq)` with `lost` flag.
  - Tests: wraparound, ordering, `since` after eviction.
  - _Requirements: 8.1, 8.2, 8.3_

- [x] 6. Config loader
  - `src/config.ts`: `<appRoot>/.app_secret` → token → config; defaults; validation; `unconfigured` result; labelled errors.
  - Tests with fake `fetch`/`readFile`: happy path, each step failing, missing secret, bad host, no Bearer/cookie headers sent, secret absent from error text.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 9.3_

- [x] 7. Notice parser
  - `src/irc/notices.ts` with the six patterns and source checks (ChanServ channel notices vs server-prefixed notices addressed to our own nick).
  - Tests: every sample from `.kiro/steering/irc-seance.md`, `1 file reverted` and `N file(s) reverted`, `ops:` with every reason and the trailing ` (path)`, near-miss strings that must not match, forged `ops:` from a user prefix ignored.
  - _Requirements: 7.4, 7.5, 7.6, 7.7, 7.9_

- [x] 8. Store and dispatcher
  - `src/irc/store.ts`, `src/irc/dispatch.ts` (`createDispatcher(store, hooks)` returning `{ handle, reset }`; `001`, `PING`, `464` and `ERROR` stay in the client): LIST, NAMES, WHOIS accumulator, JOIN/PART/KICK/QUIT/NICK/MODE, PRIVMSG/NOTICE, typed events, inbox, commits, credits, own modes, memory-only state.
  - Tests: feed recorded line sequences; agent detected only via `320 model:`; `323` drops stale channels; `needs-op` creates exactly one inbox item (repeat within 60 s de-duplicated); other reasons create none; channel resolved from shared membership, `null` plus candidates when ambiguous; channel buffer dropped 10 minutes after leaving; unknown commands ignored; a new store is empty.
  - _Requirements: 4.1, 4.2, 4.4, 7.1, 7.2, 7.3, 7.6, 7.8, 7.9, 7.10, 7.11, 8.4, 12.1_

- [x] 9. Fake ircd test helper
  - `test/fakeIrcd.ts` and a `WebSocket`-compatible in-process pair. Supports `PASS/NICK/USER` (accept or reject with 464), `PING`, `LIST`, `NAMES`, `WHOIS`, `INVITE`, `MODE`, `KICK`, and scripted notices; records received lines.
  - Tests: helper self-tests (handshake accepted, bad PASS rejected, multi-line frame, partial frame).
  - _Requirements: 2.2, 4.2_

- [x] 10. Connection state machine
  - `src/irc/client.ts`: connect, handshake, 15 s registration timeout, `PONG`, idle `PING`, one socket at a time, `auth-failed` stop, shutdown `QUIT`, sends rejected when not registered.
  - Tests with fake clock: handshake order and content, no Origin header; timeout closes socket; `PING` → `PONG`; idle `PING` then close; 464 stops reconnecting; only one socket ever open (P3); binary frame ignored; send while not registered fails; shutdown sends `QUIT`.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.7, 3.1, 3.2, 3.3, 4.3, 5.6, 6.4_

- [x] 11. Single-instance lock
  - `src/lock.ts`: `acquireLock` / `release` per the design: `O_EXCL`, `{pid, startedAt, port}`, stale detection (dead pid, invalid JSON, older than boot), release on `SIGINT`/`SIGTERM`/`SIGHUP`/`exit`; wire `duplicate-instance` into the bridge.
  - Tests with a temp dir and injected `isAlive`/`bootTime`: missing lock → acquired; live lock → `duplicate-instance` and no socket; stale (dead pid) replaced; stale (invalid JSON) replaced; stale (older than boot) replaced; `EPERM` counts as alive; `release` removes only our own lock; second acquire after release works.
  - _Requirements: 2.6, 2.8, 2.9_

- [x] 12. Reconnect and state rebuild
  - Backoff with jitter (injected random), reset on `registered`; after each `registered`, `LIST` → `NAMES` for every listed channel (up to 50) → `WHOIS` of each member (≤ 5 in flight), in `src/irc/rebuild.ts`.
  - Tests: delays 1, 2, 4 … capped at 60 s (plus jitter bound, P8); state rebuilt on the fake ircd after a dropped connection; agents detected only via `320 model:`; pre-restart sequence numbers report `lost`; rebuild respects the send queue rate.
  - _Requirements: 6.1, 6.2, 6.3, 12.2, 12.4, 12.5_

- [x] 13. HTTP server and `/health`
  - `src/http.ts` on `127.0.0.1:$PORT` with `GET`/`HEAD /health` only; wire paths, lock, config, bridge and signals in `server.ts`; build script produces `backend/dist/server.js`; nothing persists the port.
  - Tests: `/health` is exactly `{"ok":true}` in every bridge state and needs no credentials; no state, counts, host, nick or error text in the body; `POST /health` → 405; the secret never appears; the data directory contains no port file after start.
  - _Requirements: 10.1, 10.2, 10.3, 10.5, 12.3_

- [x] 14. Config re-poll
  - `src/config-watch.ts` polls every 30 s (always, so changes are noticed while connected; an unchanged config never reconnects, not even from `auth-failed`); connect when a secret appears; reconnect when host/nick/secret change; leave `auth-failed` on config change.
  - Tests with fake clock and fake `fetch`.
  - _Requirements: 1.5, 2.7_

- [x] 15. Opt-in e2e script against production
  - `USER` is sent as `USER <nick> 0 * :seance-crew` through `buildLine(..., { forceTrailing: true })`.
  - Root script `"e2e": "node scripts/e2e.mjs"` (plain ESM JavaScript). Without `SEANCE_E2E=1` it prints `skipped` and exits 0. With it, it reads `SEANCE_E2E_HOST`, `SEANCE_E2E_NICK`, `SEANCE_E2E_SECRET` (never from files) and runs in a fresh `#crew<n>` channel (n random): connect → `JOIN #crew<n>` (so the script owns the channel) → `INVITE coder #crew<n>` (summon) → wait for `coder is ready` → `MODE #crew<n> +v coder` → one prompt via `PRIVMSG` → wait for a reply from `coder` → `KICK #crew<n> coder :e2e done` (exorcise) → wait for `session closed` → `QUIT`.
  - Each step has a timeout; failure always runs exorcise and `QUIT`; the secret is never printed; exits non-zero on failure.
  - Test: a unit test spawns `node scripts/e2e.mjs` without the variable and asserts output `skipped` and exit code 0.
  - _Requirements: 2.1, 2.2, 2.3, 5.4, 7.4_

## Notes

- Depends on no other spec. `mcp-tools`, `dashboard-ui` and `steward-agent` depend on tasks 1 to 13 of this plan.
- Never open a second IRC connection (the server allows 5 per IP and this app uses exactly one), and never write the secret, token or a `PASS` line to a log, error message or file.
- Resolve app files from `import.meta.url` through `appPaths`, never from `process.cwd()` or environment variables.
- Verify each task with `pnpm typecheck && pnpm test && pnpm lint`; unit tests use the in-process fake ircd and never touch the network. The opt-in e2e (`pnpm e2e`, task 15) needs `SEANCE_E2E=1`.

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
        "5",
        "7",
        "9"
      ]
    },
    {
      "id": 1,
      "tasks": [
        "6",
        "8"
      ]
    },
    {
      "id": 2,
      "tasks": [
        "10"
      ]
    },
    {
      "id": 3,
      "tasks": [
        "11"
      ]
    },
    {
      "id": 4,
      "tasks": [
        "12"
      ]
    },
    {
      "id": 5,
      "tasks": [
        "13"
      ]
    },
    {
      "id": 6,
      "tasks": [
        "14",
        "15"
      ]
    }
  ]
}
```
