# Requirements Document

## Introduction

The `irc-bridge` is the core of the backend process. It loads configuration from Kiro Crew, holds the single WebSocket connection to a Séance server, speaks the Séance IRC subset through the vendored `@seance/irc-protocol`, and turns server traffic into an in-memory event model that the MCP tools and the dashboard API read. It also exposes `/health`.

## Glossary

- **Bridge**: this component: the Séance client inside the backend process.
- **Server**: the Séance ircd the bridge connects to.
- **Config**: `host`, `nick` and `secret` from the Kiro Crew app config.
- **Line**: one IRC message without CRLF.
- **appRoot**: the directory that contains `app.json`, found by walking up from the bundle location.
- **Store**: the in-memory model of channels, members, agents, commits, credits and inbox.

## Requirements

### Requirement 1: Configuration loading

**User Story:** As a user, I want the backend to read my Séance credentials from Kiro Crew, so that no secret lives in the repo or environment.

#### Acceptance Criteria

1. WHEN the backend starts, THE bridge SHALL read `<appRoot>/.app_secret`, request a token with `POST {KIROCREW_GATEWAY_ORIGIN}/api/apps/seance-crew/token` and header `X-App-Secret`, and read the config with `GET {KIROCREW_GATEWAY_ORIGIN}/api/apps/seance-crew/config?token=<token>`; `<appRoot>` is defined in Requirement 11.
2. THE bridge SHALL NOT use `Authorization: Bearer`, `X-Session-Token` or cookies to read config.
3. THE bridge SHALL apply the defaults `host = 35-172-120-185.sslip.io` and `nick = crew` when those keys are missing.
4. IF `.app_secret`, `KIROCREW_GATEWAY_ORIGIN`, the token response or the config response is missing or invalid, THEN THE bridge SHALL report a configuration error naming the failed step and SHALL NOT open a connection.
5. IF `secret` is missing or empty, THEN THE bridge SHALL stay in state `unconfigured`, report that in `/health`, and re-read the config every 30 seconds.
6. THE bridge SHALL validate `host` as a hostname (no scheme, path, port or whitespace) and `nick` with the vendored `isValidNick` before use.
7. THE bridge SHALL NOT include the secret in any log line, error message, health response or thrown value.

### Requirement 2: Single connection and handshake

**User Story:** As an operator, I want exactly one connection to the server, so that I stay under the per-IP limit.

#### Acceptance Criteria

1. THE bridge SHALL connect to `wss://<host>/ws` using the global `WebSocket` and SHALL NOT send an Origin header.
2. WHEN the socket opens, THE bridge SHALL send, in order, `PASS <nick>:<secret>`, `NICK <nick>` and `USER <nick> 0 * :seance-crew`.
3. WHEN numeric `001` is received, THE bridge SHALL set its state to `registered` and SHALL start the channel and membership refresh.
4. IF registration does not complete within 15 seconds, THEN THE bridge SHALL close the socket and treat it as a failed attempt.
5. THE bridge SHALL hold at most one open or connecting socket at any time.
6. WHEN the backend starts, THE bridge SHALL create `<appRoot>/data/bridge.lock` with the exclusive-create flag (`O_EXCL`) containing JSON `{ pid, startedAt, port }`; IF the file already exists and is not stale, THEN THE bridge SHALL NOT open a connection and SHALL report state `duplicate-instance`.
7. IF the server answers the handshake with an authentication error (numeric `464`, or `ERROR` mentioning authentication), THEN THE bridge SHALL stop reconnecting, set state `auth-failed`, and wait for a config change before trying again.
8. A lock SHALL be stale, and SHALL be replaced, WHEN its `pid` is not alive (`process.kill(pid, 0)` throws `ESRCH`) OR its `startedAt` is older than the current system boot time OR the file is not valid JSON.
9. WHEN the process receives `SIGINT`, `SIGTERM` or `SIGHUP`, or exits normally, THE bridge SHALL remove the lock file it created, and SHALL NOT remove a lock that holds another `pid`.

### Requirement 3: Keepalive

**User Story:** As a user, I want the connection to stay alive without noise, so that the server does not drop it and I do not see reconnect churn.

#### Acceptance Criteria

1. WHEN the server sends `PING <token>`, THE bridge SHALL reply `PONG <token>` without going through the normal send queue delay.
2. THE bridge SHALL NOT use WebSocket-level ping frames.
3. IF no line has been received for 120 seconds, THEN THE bridge SHALL send `PING` itself, and IF still nothing is received within 30 seconds, THEN THE bridge SHALL close the socket and reconnect.

### Requirement 4: Framing and parsing

**User Story:** As a developer, I want one parser for all traffic, so that behavior matches the server.

#### Acceptance Criteria

1. THE bridge SHALL feed every text frame through the vendored `LineFramer` and parse each framed line with the vendored `parse`.
2. WHEN a frame contains several lines or a partial line, THE bridge SHALL process complete lines in order and buffer the remainder.
3. IF a binary frame is received, THEN THE bridge SHALL ignore it and count it in diagnostics.
4. IF a line is overlong or unparsable, THEN THE bridge SHALL drop it, count it in diagnostics, and continue.
5. THE bridge SHALL serialize every outbound message with the vendored `serialize` and end it with CRLF.

### Requirement 5: Outbound validation and send queue

**User Story:** As a user, I want the bridge to never get me flood-kicked or injected, so that a bad tool call cannot cost me the connection or run a forged command.

#### Acceptance Criteria

1. THE bridge SHALL reject any outbound line longer than 512 bytes including CRLF, counted in UTF-8 bytes, with an error that names the limit.
2. THE bridge SHALL reject any parameter containing CR, LF or NUL.
3. THE bridge SHALL validate nicks with `isValidNick` and channels with `isValidChannel` before building a line.
4. THE bridge SHALL send through a queue that allows a burst of up to 8 lines and then at most 1 line per second.
5. WHEN the queue holds more than 100 lines, THE bridge SHALL reject new low-priority lines (`say`, `LIST`, `WHOIS`) with a "queue full" error and SHALL keep `PONG` and `QUIT` always sendable.
6. IF the socket is not `registered`, THEN THE bridge SHALL reject user-initiated sends with an error that states the current state, and SHALL NOT buffer them for later.

### Requirement 6: Reconnect

**User Story:** As a user, I want the bridge to recover from network trouble by itself, so that I do not have to restart the app after an outage.

#### Acceptance Criteria

1. WHEN the socket closes or errors and the state is not `auth-failed` or `duplicate-instance`, THE bridge SHALL reconnect with exponential backoff starting at 1 second, doubling to a cap of 60 seconds, with random jitter of up to 25 percent.
2. WHEN a connection reaches `registered`, THE bridge SHALL reset the backoff.
3. WHEN reconnecting, THE bridge SHALL re-join nothing automatically and SHALL rebuild channel and member state from `LIST`, `WHOIS` and `NAMES`.
4. WHEN the backend receives a shutdown signal, THE bridge SHALL send `QUIT :seance-crew shutting down`, close the socket, and not reconnect.

### Requirement 7: Event model

**User Story:** As a consumer of the bridge, I want a typed view of channels, agents, credits and denials, so that the tools and the dashboard do not parse IRC text themselves.

#### Acceptance Criteria

1. THE bridge SHALL maintain, in memory, channels (name, topic, member count), members with modes, agents, per-channel credits, a commit list per channel, and an inbox of needs-op items.
2. WHEN a `322` reply arrives, THE bridge SHALL record the channel, member count and topic; WHEN `323` arrives, THE bridge SHALL mark the list complete and drop channels no longer listed.
3. WHEN a WHOIS completes (`318`) and contains a `320` line with `model:`, THE bridge SHALL mark the nick as an agent and record its model, tools and credits from the `320` lines (`credits: <#chan> X.XX / total Y.YY`).
4. WHEN a ChanServ NOTICE matches `worktree ready: <dir> @ <sha>`, `<agent> is ready`, `session closed, worktree reset to <sha>`, `session cancelled, worktree reset to <sha>` or `<N> file(s) reverted · <X.XX> credits used`, THE bridge SHALL emit a typed event and update channel state (worktree, agent ready, credits).
5. WHEN a NOTICE matches `<agent> committed <sha> (<n> file(s))`, THE bridge SHALL append a commit entry to that channel.
6. WHEN the server sends a server-prefixed NOTICE addressed to the bridge's own nick that matches `ops: <agent> denied <action>: needs-op`, THE bridge SHALL create an inbox item (id, channel or `null` with candidate channels when the agent shares several channels with the bridge, agent, action, time, status `open`), and SHALL ignore the same text from any user-prefixed sender.
7. WHEN an `ops:` notice carries a reason other than `needs-op`, THE bridge SHALL store it as a plain channel line and SHALL NOT create an inbox item.
8. WHEN `JOIN`, `PART`, `KICK`, `QUIT`, `NICK` or `MODE` arrive, THE bridge SHALL update members and modes accordingly.
9. IF a NOTICE does not match any pattern, THEN THE bridge SHALL store it as a plain line and emit no typed event.
10. THE bridge SHALL treat the text of every channel line as untrusted data and SHALL store it as a string without interpretation.
11. THE bridge SHALL offer a subscription API (`on(event, handler)`) so consumers can react to events without polling.

### Requirement 8: Ring buffer

**User Story:** As a reader, I want recent channel history without unbounded memory, so that long sessions cannot exhaust the backend.

#### Acceptance Criteria

1. THE bridge SHALL keep a ring buffer of the last 500 lines per channel, each with a monotonic sequence number, timestamp, sender and kind (`privmsg`, `notice`, `join`, `part`, `kick`, `mode`, `system`).
2. WHEN the buffer is full, THE bridge SHALL drop the oldest line.
3. WHEN asked for lines after sequence number N, THE bridge SHALL return only newer lines, in order, and report if lines were lost since N.
4. THE bridge SHALL drop the buffer of a channel 10 minutes after the bridge has left or been removed from it.

### Requirement 9: Secret redaction

**User Story:** As a user, I want to be sure the secret never leaks, so that connecting this app does not put my account at risk.

#### Acceptance Criteria

1. THE bridge SHALL write logs only through a logger that replaces the configured secret value and any `PASS <…>` line with `PASS ***` or `***`.
2. WHEN outbound traffic is logged for debugging, THE bridge SHALL redact `PASS` lines before logging.
3. THE bridge SHALL redact the secret in error messages produced from socket, config or HTTP failures.

### Requirement 10: Health

**User Story:** As Kiro Crew, I want a health check to know the app is alive, so that I can supervise it without the check exposing anything.

#### Acceptance Criteria

1. THE backend SHALL bind `127.0.0.1:$PORT` and answer `GET /health` with HTTP 200 and the JSON body `{ "ok": true }` whenever the process is alive, regardless of the IRC state.
2. THE `/health` response SHALL NOT include the bridge state, counts, host, nick, error text, uptime, version or any config value, and SHALL NOT require authentication (the gateway health check sends no credentials).
3. THE `/health` route SHALL answer only `GET` and `HEAD`; other methods SHALL get HTTP 405.
4. IF `PORT` is missing or invalid, THEN THE backend SHALL exit with a clear error.
5. THE backend SHALL NOT persist or advertise its port anywhere; the port may differ on every restart.

### Requirement 11: App paths

**User Story:** As a maintainer, I want paths that work regardless of how the gateway starts the process, so that the app does not depend on the working directory.

#### Acceptance Criteria

1. THE backend SHALL derive `<appRoot>` by walking up from the directory of `import.meta.url` (the bundle `backend/dist/server.js` when installed) to the first directory containing `app.json`.
2. THE backend SHALL derive `<appRoot>/data` and `<appRoot>/.app_secret` from `<appRoot>` and SHALL NOT use `process.cwd()` or environment variables to locate any app file.
3. IF no `app.json` is found while walking up, THEN THE backend SHALL exit with an error naming the start directory.
4. THE backend SHALL create `<appRoot>/data` with mode 700 when missing.
5. Every module that needs a path SHALL receive `appRoot` from one `resolveAppRoot` function so tests can inject a temporary directory.

### Requirement 12: State on restart and persistence

**User Story:** As a user, I want the app to recover its view of the server after a restart without stale data, so that the dashboard never shows history the app cannot know.

#### Acceptance Criteria

1. THE bridge SHALL keep ring buffers, the inbox, commit lists and member lists in memory only, and SHALL start empty after every restart.
2. WHEN a connection reaches `registered`, THE bridge SHALL rebuild state with `LIST`, then `NAMES` for each listed channel the bridge is in, then `WHOIS` for each member nick, and SHALL mark a nick as an agent only when its WHOIS has a `320` line with `model:`.
3. THE only state the backend SHALL persist is `<appRoot>/data/credits.json` and `<appRoot>/data/summary.json` (defined in `steward-agent`), plus the transient `data/bridge.lock`.
4. THE rebuilt state SHALL NOT claim history it cannot know: commits and inbox items that happened before the restart SHALL be absent, and `read` SHALL report `lost: true` for sequence numbers from before the restart.
5. THE bridge SHALL cap the rebuild at 5 WHOIS lines in flight and SHALL finish within the send queue rate (1 line per second after the burst).
