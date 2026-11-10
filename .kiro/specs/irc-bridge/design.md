# Design Document

## Overview

A pure-TypeScript module set under `backend/src/` with no runtime dependencies beyond Node and the vendored protocol package. The bridge is a small state machine around one `WebSocket`, a rate-limited send queue, a line parser, and an in-memory store. Everything that touches time, randomness or the socket is injected so unit tests run against an in-process fake ircd without any network.

## Architecture

```
 Kiro Crew gateway ──(token, config)──▶ config.ts
                                           │
 ┌─────────────────────────── backend process ───────────────────────────┐
 │  server.ts ─ http.ts (/health, /mcp, /api/*)                          │
 │       │                                                               │
 │   IrcBridge (client.ts) ── SendQueue ── validateLine ── serialize     │
 │       │  ▲                                                            │
 │  WebSocket ─ LineFramer ─ parse ─ Dispatcher ─ Store (+ rings, inbox) │
 └───────────────────────────────────────────────────────────────────────┘
                    │
              wss://<host>/ws
```

### State machine

```
unconfigured ─(config ok)─▶ connecting ─(001)─▶ registered
     ▲                          │ close/timeout       │ close
     │                          ▼                     ▼
     └──(secret removed)── reconnecting ◀─────────────┘
connecting ─(464)─▶ auth-failed ─(config changed)─▶ connecting
start ─(lock held)─▶ duplicate-instance
```

- One `WebSocket` field. A new connection is created only from `reconnecting` or `connecting` and only after the old socket reached `CLOSED`.
- Registration timer 15 s. Idle timer 120 s, then own `PING`, then 30 s grace.
- Single-instance lock: see "Single-instance lock" below.
- Backoff: `min(60_000, 1000 * 2^n) * (1 + rand * 0.25)`; `rand` injected.
- A rejected `PASS` (464) never loops, because the server allows only 3 bad passes per connection and 10 per IP per 10 minutes.

### State on restart

Ring buffers, member lists, commits and the inbox are in memory by design and start empty after every restart. After each `registered` (first connect or reconnect) the bridge rebuilds its view: `LIST` → `NAMES` for each channel it is in → `WHOIS` for each member nick (at most 5 in flight, paced by the send queue). A nick is an agent only if its WHOIS has a `320` line starting with `model:`. History from before the restart is not reconstructed: `read` reports `lost: true` for earlier sequence numbers, and commits or inbox items from before the restart are simply absent. The only persisted files are `data/credits.json` and `data/summary.json` (see `steward-agent`), plus the transient `data/bridge.lock`. The HTTP port may change on every restart; nothing stores it for later use.

## Components and Interfaces

| File | Responsibility |
| --- | --- |
| `src/paths.ts` | `resolveAppRoot(importMetaUrl)`: walks up from the bundle location to the directory containing `app.json`; `appPaths(root)` returns `{ root, data, secretFile, lockFile, creditsFile, summaryFile }`. The only place that touches `import.meta.url`. |
| `src/lock.ts` | `acquireLock(paths, deps)`: single-instance lock `data/bridge.lock` (`O_EXCL`, JSON `{pid, startedAt, port}`), stale detection, release on exit signals. |
| `src/config.ts` | `loadConfig(deps)`: read `<appRoot>/.app_secret`, token, config; defaults; validation. Returns `Config` or a `ConfigError` naming the step. |
| `src/log.ts` | `createLogger(secrets)`: JSON-lines logger with redaction of secret values and `PASS` lines. |
| `src/irc/line.ts` | `buildLine(command, params)`: validation (512 bytes, no CR/LF/NUL, nick/channel checks) and `serialize`. Pure. |
| `src/irc/queue.ts` | `SendQueue`: token bucket (burst 8, 1/s), priority lanes, depth limit. Clock injected. |
| `src/irc/client.ts` | `IrcBridge`: state machine, socket lifecycle, handshake, PING/PONG, reconnect/backoff, state rebuild after registration. |
| `src/irc/dispatch.ts` | `dispatch(message, store, ownNick)`: maps parsed messages to store updates and typed events. |
| `src/irc/notices.ts` | `parseNotice({ prefix, target, text }, ownNick)`: source checks (ChanServ channel notice vs server-prefixed op notice) and the regexes below. Pure. |
| `src/irc/store.ts` | `Store`: channels, members, agents, credits, commits, inbox, events emitter. |
| `src/irc/ring.ts` | `Ring<T>`: fixed-capacity buffer with sequence numbers. |
| `src/http.ts` | `node:http` server and router. `GET /health` (unauthenticated, body `{"ok":true}`); `/mcp` and `/api/*` are registered by `mcp-tools` and `dashboard-ui` behind their own guards. |
| `src/server.ts` | Entry point: resolves `appRoot`, takes the lock, wires everything, handles `PORT` and exit signals. No CLI modes. |
| `test/fakeIrcd.ts` | In-process fake server implementing the handshake, PING, LIST, WHOIS, INVITE, MODE, KICK and scripted ChanServ notices. |

### Configuration flow

`loadConfig` takes `{ paths, env, fetch, readFile }`; `paths` comes from `appPaths(resolveAppRoot(import.meta.url))`, so the secret file is `<appRoot>/.app_secret` and never depends on `process.cwd()`. Steps, each with its own error label (`read-app-secret`, `token`, `config`, `validate`): read `paths.secretFile`; `POST ${origin}/api/apps/seance-crew/token` with `X-App-Secret`; `GET .../config?token=…`. The app name comes from `KIROCREW_APP_NAME` with fallback `seance-crew`. Missing `secret` yields `{ kind: "unconfigured" }` rather than an error so the bridge can poll every 30 s. The app secret and token never leave this module except as request headers and a query string, and the logger redacts both.

### App paths

`resolveAppRoot(importMetaUrl)` converts the URL to a path with `fileURLToPath`, takes its directory, and walks up until a directory contains `app.json` (installed: `~/.kiro/crew/apps/seance-crew/backend/dist/server.js` → `…/seance-crew`; development and tests: `backend/src/*.ts` → repository root). No `process.cwd()`, no environment variable. Not finding `app.json` is a fatal start error that names the start directory. `data/` is created with mode 700. Every other module receives `AppPaths`, so tests pass a temporary directory.

### Single-instance lock

`acquireLock(paths, { now, pid, isAlive, bootTime })`:

1. `open(lockFile, "wx")` (`O_EXCL`); on success write `{ pid, startedAt, port }` and fsync. `port` is filled in by a second atomic write once the HTTP server is listening, and is informational only; nothing ever reads it to connect.
2. On `EEXIST`, read and parse the file. The lock is **stale** when the JSON is invalid, or `isAlive(pid)` is false (`process.kill(pid, 0)` throws `ESRCH`; `EPERM` counts as alive), or `startedAt` is earlier than the current boot time (`Date.now() - os.uptime() * 1000`, with 5 s tolerance) because a PID can be reused after a reboot.
3. A stale lock is removed and acquisition is retried once; a second `EEXIST` or a live lock gives `duplicate-instance` and the process opens no connection (it keeps serving `/health` so the gateway does not restart-loop it).
4. `release()` removes the file only if it still holds our `pid`. It runs on `SIGINT`, `SIGTERM`, `SIGHUP`, and the `exit` event. A `SIGKILL` leaves a stale lock, which rule 2 handles on the next start.

### Send path

`bridge.send(command, params, {priority})` → `buildLine` (throws `LineError` with a stable `code`: `too-long`, `bad-char`, `bad-nick`, `bad-channel`, `not-registered`, `queue-full`) → `SendQueue.push` → timer drains at the bucket rate → `socket.send(line + "\r\n")`. `PONG` bypasses the bucket. Byte length uses `TextEncoder`. Free text is sliced on a character boundary so the whole line stays ≤ 512 bytes including CRLF; if the caller's text does not fit, the call fails rather than silently truncating (the MCP layer chooses the limit, see `mcp-tools`).

### Dispatch and notice parsing

`dispatch` handles: `001`, `322/323`, `353/366` (NAMES), `311/312/319/320/317/318` (WHOIS accumulator keyed by nick), `PRIVMSG`, `NOTICE`, `JOIN/PART/KICK/QUIT/NICK/MODE`, `PING`, `ERROR`, `464`. Unknown commands are counted and ignored.

Notice handling has two sources. Both were checked against the Séance server code (`apps/runner`, `apps/ircd/src/runner-wiring.ts`):

1. **Channel notices from ChanServ** (`:ChanServ!… NOTICE #chan :<text>`): worktree, ready, closed, reverted, commit. Accepted only when the prefix nick passes the vendored `isServiceNick` and the target is a channel, so an ordinary user cannot forge them.
2. **Op notices from the server itself** (`:<serverName> NOTICE <ournick> :ops: …`): the runner sends the `ops:` text with `noticeTo` to each human `+o` member of the channel, with the **server name as prefix** and **our nick as target**. The channel is not in the text. Accepted only when the prefix contains no `!` (a server prefix, not a user mask) and the target is our own nick. A user cannot forge this, because user messages always carry a `nick!user@host` prefix.

Consequence: the bridge only receives `ops:` notices for channels where its own nick is `+o`. The store therefore tracks our own modes per channel (from `353`, `MODE`), and `summon` is expected to be followed by granting op to the crew nick or by the human opping it. This is a documented limit, not a bug: without `+o` for the crew nick there is no needs-op inbox for that channel.

Patterns (case-sensitive, anchored):

| Event | Regex (text) |
| --- | --- |
| worktree | `^worktree ready: (\S+) @ ([0-9a-f]{7,40})$` |
| ready | `^(\S+) is ready$` |
| closed | `^session (closed|cancelled), worktree reset to ([0-9a-f]{7,40})$` |
| reverted | `^(\d+) files?(?:\(s\))? reverted · (\d+\.\d{2}) credits used$` (the server prints both `1 file reverted` and `N file(s) reverted`) |
| commit | `^(\S+) committed ([0-9a-f]{7,40}) \((\d+) files?(?:\(s\))?\)$` |
| denied | `^ops: (\S+) denied (.+?): (no-mode\|needs-op\|outside-worktree\|unclassified\|unresolved-path\|deny-list\|protected-path\|private-session)(?: \((.+)\))?$` (server-prefixed, see above) |

Only `needs-op` creates an inbox item, because only it is fixed by granting `+o`. The other reasons (`outside-worktree`, `deny-list`, `protected-path`, …) are security denials that op cannot fix; they are stored as plain `system` lines on the channel and emit no inbox item. `no-mode` also becomes a plain line, since the fix is `+v` or `+o` and the human decides.

**Resolving the channel of an `ops:` notice.** The text names the agent but not the channel. The store looks up the agent in its member lists: exactly one shared channel (where our nick is `+o`) gives that channel; several candidates give the channel with an open or recent session (last `ready`/`worktree` event); if still ambiguous the item is created with `channel: null` and `candidates: string[]`, and consumers must ask the human to pick. Items are de-duplicated by `(agent, action)` within 60 seconds, since the runner may repeat a denial.

```ts
interface InboxItem {
  readonly id: string; readonly channel: string | null; readonly candidates: readonly string[];
  readonly agent: string; readonly action: string; readonly reason: "needs-op";
  readonly ts: number; status: "open" | "granted" | "dismissed";
}
```

An agent is any nick whose WHOIS has a `320` line starting with `model:`. WHOIS runs on JOIN of a new nick (rate-limited, max 1 pending) and on `<agent> is ready`.

### Redaction

`createLogger([secret, token])` replaces every occurrence of each secret string with `***` and rewrites `^PASS .*` to `PASS ***`. Errors thrown from the bridge are built from fixed strings plus non-secret fields. Tests assert absence of the secret in all log output and in `/health`.

### Health

`GET /health` (and `HEAD`) → `200 {"ok":true}`, nothing else: no state, counts, host, nick, error text or version. It is unauthenticated because the gateway health check sends no credentials, and it never depends on IRC state so Crew does not restart the app during a network outage. The bridge state is available only through the authenticated `GET /api/state` (see `dashboard-ui`).

## Data Models

```ts
type BridgeState =
  | "unconfigured" | "connecting" | "registered"
  | "reconnecting" | "auth-failed" | "duplicate-instance";

interface Config { readonly host: string; readonly nick: string; readonly secret: string }

type BridgeEvent =
  | { type: "state"; state: BridgeState }
  | { type: "line"; channel: string; line: ChannelLine }
  | { type: "agent"; nick: string; model: string; tools: string[] }
  | { type: "ready"; channel: string; agent: string }
  | { type: "worktree"; channel: string; dir: string; sha: string }
  | { type: "session-closed"; channel: string; sha: string; cancelled: boolean }
  | { type: "reverted"; channel: string; files: number; credits: number }
  | { type: "commit"; channel: string; agent: string; sha: string; files: number }
  | { type: "credits"; channel: string; used: number; total: number }
  | { type: "needs-op"; item: InboxItem };

interface ChannelLine {
  readonly seq: number; readonly ts: number; readonly from: string;
  readonly kind: "privmsg" | "notice" | "join" | "part" | "kick" | "mode" | "system";
  readonly text: string; // untrusted
}

interface InboxItem {
  readonly id: string; readonly channel: string | null; readonly candidates: readonly string[];
  readonly agent: string; readonly action: string; readonly ts: number;
  status: "open" | "granted" | "dismissed"; // channel null = ambiguous, see Dispatch
}
```

### Store and ring

`Store` owns `Map<string, Channel>` keyed by `irc_lower(name)`. `Channel` holds `topic`, `count`, `members: Map<nick, modes>`, `ring: Ring<ChannelLine>(500)`, `commits`, `credits {used, total}`, `worktree`, `leftAt`. `Ring.since(seq)` returns `{ lines, lost }`. The inbox is an array capped at 200 with `dismiss(id)` and `resolve(id)`. Credits come from two sources: the `reverted` notice (per session) and WHOIS `320 credits:` lines (authoritative total); the store keeps the latest WHOIS value and falls back to the notice.

## Error Handling

- Configuration: `loadConfig` returns a `ConfigError` naming the failing step (`read-app-secret`, `token`, `config`, `validate`). A missing secret is not an error; it yields `{ kind: "unconfigured" }` and the bridge polls every 30 s.
- Outbound lines: `buildLine` throws `LineError` with a stable `code` (`too-long`, `bad-char`, `bad-nick`, `bad-channel`, `not-registered`, `queue-full`). Text is never silently truncated.
- Connection loss: the bridge moves to `reconnecting` and retries with capped exponential backoff plus jitter.
- Registration failure: a `464` moves the bridge to `auth-failed` and never loops; it resumes only when the config changes.
- Duplicate instance: a live `data/bridge.lock` moves the bridge to `duplicate-instance`; a stale lock (dead pid, invalid JSON, or older than boot) is replaced.
- Paths: a missing `app.json` while walking up from `import.meta.url` is a fatal start error that names the start directory.
- Inbound input: unknown commands are counted and ignored. Notices that fail the source checks are treated as ordinary channel lines, so they cannot forge events.
- Secrets: thrown errors use fixed strings plus non-secret fields, and the logger redacts the secret and token.
- Health: `/health` returns 200 regardless of IRC state, so a network outage does not trigger a restart.

## Correctness Properties

### Property 1: Outbound lines are always valid

For any input string, `buildLine` either throws a `LineError` or returns a line of at most 512 bytes with exactly one trailing CRLF and no inner CR, LF or NUL.

**Validates: Requirements 4.5, 5.1, 5.2, 5.3**

### Property 2: Send rate is bounded

`SendQueue` never emits more than 8 lines in a burst or more than 1 line per second sustained, apart from `PONG`, which bypasses the bucket.

**Validates: Requirements 3.1, 5.4, 5.5**

### Property 3: One socket at a time

At most one `WebSocket` is open at a time, and a new one is created only after the previous reached `CLOSED`.

**Validates: Requirements 2.5**

### Property 4: Ring buffer ordering and loss

`Ring.since(seq)` returns lines in increasing sequence order, and `lost` reports exactly the lines evicted since `seq`.

**Validates: Requirements 8.1, 8.2, 8.3**

### Property 5: Notices cannot be forged

`parseNotice` accepts channel notices only from a service nick, and accepts `ops:` notices only with a server prefix (no `!`) targeted at our own nick.

**Validates: Requirements 7.4, 7.5, 7.6**

### Property 6: Only needs-op creates inbox items

Only a `needs-op` denial creates an inbox item, and items with the same `(agent, action)` within 60 s are de-duplicated.

**Validates: Requirements 7.6, 7.7**

### Property 7: Secret never leaks and health is minimal

The app secret and token never appear in log output, and `/health` always returns exactly `{"ok":true}`.

**Validates: Requirements 1.7, 9.1, 9.2, 9.3, 10.2**

### Property 8: Backoff stays in bounds

Backoff delay is always within `[min(60_000, 1000 * 2^n), 1.25 * that]`.

**Validates: Requirements 6.1, 6.2**

### Property 9: Lock has at most one holder

`acquireLock` yields at most one holder: a live lock is never replaced, and a stale lock (dead pid, invalid JSON, boot older than `startedAt`) always is.

**Validates: Requirements 2.6, 2.8, 2.9**

## Testing Strategy

- Pure units: `buildLine`, `SendQueue` (fake clock), `Ring`, `parseNotice`, `loadConfig` (fake fetch), `createLogger`.
- Integration: `IrcBridge` against `fakeIrcd` over an in-process `WebSocket`-compatible pair (a minimal class implementing the used subset: `send`, `close`, `onopen`, `onmessage`, `onclose`, `onerror`, `readyState`). No ports, no network.
- Property tests (fast-check): any string through `buildLine` either fails with a `LineError` or yields ≤ 512 bytes with exactly one CRLF at the end and no inner CR/LF/NUL.
- Lock tests use a temporary directory and injected `isAlive`/`bootTime`: live, stale (dead pid), stale (invalid JSON), stale (older than boot), missing, and release-only-if-ours.
- E2E (opt-in): `scripts/e2e.mjs`, plain ESM JavaScript because Node 22.12 does not strip TypeScript types by default; `pnpm e2e` runs it, and it only does anything when `SEANCE_E2E=1` (otherwise prints "skipped" and exits 0).
