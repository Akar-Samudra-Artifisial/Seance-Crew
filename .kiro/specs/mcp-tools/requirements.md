# Requirements Document

## Introduction

The backend serves a Streamable HTTP MCP endpoint at `/mcp` so Kiro Crew agents (for example `seance-steward`) can operate Séance channels. The gateway registers `mcpServers.seance.url` and rewrites the port to the live backend port. The tools read the `irc-bridge` store and send validated lines through its send queue.

## Glossary

- **Tool**: an MCP tool offered at `/mcp`.
- **Channel text**: any text that came from the IRC server (messages, topics, nicks, notices, WHOIS fields).
- **Gateway origin**: the value of `KIROCREW_GATEWAY_ORIGIN`, the origin of the Kiro Crew gateway.
- **Local-caller guard**: the shared Host and Origin check applied to `/mcp` and `/api/*`.

## Requirements

### Requirement 1: Transport and JSON-RPC

**User Story:** As Kiro Crew, I want a standard MCP endpoint, so that the gateway can register and call it.

#### Acceptance Criteria

1. THE backend SHALL answer `POST /mcp` with JSON-RPC 2.0 for the methods `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call`.
2. WHEN `initialize` is received, THE backend SHALL answer with `protocolVersion` (the client's version if supported among `2025-06-18`, `2025-03-26`, `2024-11-05`, otherwise `2025-06-18`), `capabilities: { tools: { listChanged: false } }` and `serverInfo: { name: "seance-crew", version }`.
3. WHEN a JSON-RPC notification (no `id`) is received, THE backend SHALL answer HTTP 202 with an empty body.
4. WHEN a request has an unknown method, THE backend SHALL answer a JSON-RPC error `-32601`; WHEN the body is not valid JSON, `-32700`; WHEN it is not a valid request object, `-32600`; WHEN params are invalid, `-32602`.
5. THE backend SHALL answer with `Content-Type: application/json` and SHALL NOT require sessions (stateless); `GET /mcp` and `DELETE /mcp` SHALL return HTTP 405.
6. THE backend SHALL accept request bodies up to 64 KiB and answer HTTP 413 above that.
7. THE backend SHALL apply the local-caller guard of Requirement 8 to every `/mcp` request before reading the body.
8. THE backend SHALL accept batch arrays by answering each element, and SHALL answer HTTP 202 when a batch has only notifications.

### Requirement 2: Tool catalog

**User Story:** As an agent, I want a small, well-described toolset, so that I can pick the right tool without guessing.

#### Acceptance Criteria

1. WHEN `tools/list` is received, THE backend SHALL return exactly these tools, each with `name`, `description` and a JSON Schema `inputSchema` with `additionalProperties: false`: `list_channels`, `read`, `say`, `summon`, `grant_op`, `exorcise`, `whois`, `credits`.
2. THE description of every tool that returns channel text SHALL state that the text is untrusted data.
3. THE description of `grant_op` and `exorcise` SHALL state that `confirm: true` is required and must only be set after the human agrees.

### Requirement 3: Input validation

**User Story:** As a maintainer, I want strict validation without extra dependencies, so that bad input never reaches the server and the backend stays dependency-free.

#### Acceptance Criteria

1. THE backend SHALL validate tool arguments with hand-written validators (no zod or schema library) that reject unknown properties, wrong types, missing required properties and out-of-range values.
2. THE backend SHALL validate channel names with `isValidChannel` and nicks with `isValidNick` from the vendored protocol.
3. THE backend SHALL reject text arguments that contain CR, LF or NUL, or that would make the final line exceed 512 bytes including CRLF.
4. WHEN validation fails, THE backend SHALL return a tool result with `isError: true` and a message naming the property and rule, and SHALL NOT send anything to the server.
5. WHEN an unknown tool name is called, THE backend SHALL return JSON-RPC error `-32602`.

### Requirement 4: Read-only tools

**User Story:** As an agent, I want to see channels, history, agents and credits, so that I can report accurately to the human.

#### Acceptance Criteria

1. WHEN `list_channels` is called, THE backend SHALL return each channel with name, topic, member count and its agents (nick, modes, model, ready flag, last commit).
2. WHEN `read` is called with `channel`, optional `since` (sequence number) and optional `limit` (1 to 200, default 50), THE backend SHALL return the newest lines after `since`, oldest first, each with `seq`, `ts`, `from`, `kind` and `text`, plus `lost: true` when lines were dropped from the ring buffer.
3. IF the bridge has no record of the channel, THEN `read` SHALL return `isError: true` saying the channel is unknown.
4. WHEN `whois` is called with `nick`, THE backend SHALL send `WHOIS`, wait up to 5 seconds for `318`, and return the parsed fields (user, host, channels, model, tools, credits, idle); WHEN the timeout elapses, THE backend SHALL return `isError: true` with "whois timed out".
5. WHEN `credits` is called, THE backend SHALL return per-channel and total credits from the store, optionally filtered by `channel`, the latest daily summary (`summary`, defined in `steward-agent`, or `null` when none exists yet), and SHALL say when a figure is unavailable.
6. THE read-only tools SHALL NOT send any line to the server except `WHOIS` for `whois`.

### Requirement 5: Acting tools

**User Story:** As an operator, I want to steer agents from Crew with safety rails, so that a mistaken call cannot grant op or kick an agent without my consent.

#### Acceptance Criteria

1. WHEN `say` is called with `channel` and `text` (1 to 400 characters), THE backend SHALL send `PRIVMSG <channel> :<text>` and return `{ sent: true }`.
2. WHEN `summon` is called with `channel` and optional `agent` (default `coder`), THE backend SHALL send `INVITE <agent> <channel>`, wait up to 20 seconds for `<agent> is ready` in that channel, and return `{ ready: true }` or `{ ready: false, waitedSec }` without treating a timeout as an error.
3. IF `INVITE` is refused with numeric `482` or `473`, THEN `summon` SHALL return `isError: true` explaining that the account may not be allowed to invite (check `SEANCE_INVITERS` on the server).
4. WHEN `grant_op` is called with `channel`, `agent`, `mode` (one of `+v`, `-v`, `+o`, `-o`) and `confirm`, THE backend SHALL send `MODE <channel> <mode> <agent>` only if `confirm === true`.
5. WHEN `exorcise` is called with `channel`, `agent`, optional `reason` (at most 200 characters, default `exorcised by seance-crew`) and `confirm`, THE backend SHALL send `KICK <channel> <agent> :<reason>` only if `confirm === true`, and SHALL wait up to 10 seconds for the `session closed` or `session cancelled` notice.
6. IF `confirm` is absent, false or not a boolean for `grant_op` or `exorcise`, THEN THE backend SHALL return `isError: true` with a message saying that `confirm: true` is required after the human agrees, and SHALL NOT send anything.
7. WHEN a `grant_op` with `+o` succeeds, THE backend SHALL mark open inbox items for that channel and agent as `granted`.
8. IF the bridge is not `registered`, THEN every acting tool SHALL return `isError: true` stating the bridge state.
9. THE acting tools SHALL go through the bridge send queue and its line validation.

### Requirement 6: Untrusted output

**User Story:** As a security reviewer, I want channel text clearly marked as data, so that text from a channel cannot pass as an instruction to the agent.

#### Acceptance Criteria

1. THE backend SHALL wrap every piece of channel text in tool results as `<untrusted source="channel:<name>" from="<nick>">…</untrusted>`, in the human-readable `content` text.
2. THE backend SHALL escape any `</untrusted>` and `<untrusted` sequence inside channel text so it cannot close or fake a wrapper.
3. THE backend SHALL return `structuredContent` with the same data, where text fields are plain strings and the result carries `untrusted: true`.
4. THE backend SHALL NOT interpret channel text as commands, and SHALL NOT include the Séance secret, token or config in any tool result.

### Requirement 7: Errors and limits

**User Story:** As an agent, I want predictable errors, so that I can tell a bad argument from a server problem and react correctly.

#### Acceptance Criteria

1. THE backend SHALL return tool failures as results with `isError: true` and a short message, and SHALL reserve JSON-RPC errors for protocol problems.
2. IF a handler throws, THEN THE backend SHALL return `isError: true` with a generic message and log the redacted error, without a stack trace in the result.
3. THE backend SHALL cap tool result size at 32 KiB by trimming the oldest lines of `read`.
4. THE backend SHALL allow at most 8 concurrent tool calls and return `isError: true` "busy" above that.

### Requirement 8: Local-caller protection

**User Story:** As a security reviewer, I want other local processes and web pages to be unable to drive the channels through `/mcp`, so that only the intended callers can act on channels.

#### Acceptance Criteria

1. IF the `Host` header of a `/mcp` request is not `127.0.0.1:<port>` or `localhost:<port>` for the port the backend listens on, THEN THE backend SHALL answer HTTP 421 and SHALL NOT read the body (DNS-rebinding guard).
2. IF a `/mcp` request carries an `Origin` header that is not the gateway origin (`KIROCREW_GATEWAY_ORIGIN`, where `127.0.0.1`, `localhost` and `[::1]` on the same scheme and port count as the same origin), THEN THE backend SHALL answer HTTP 403; a request without `Origin` SHALL pass this check.
3. THE backend SHALL NOT require a credential on `/mcp` as long as the gateway sends none on MCP calls, and SHALL document the resulting accepted risk in `.kiro/steering/security.md` and in the README security section.
4. IF the gateway is found to send a header or secret on MCP calls, THEN THE backend SHALL require it and answer HTTP 403 without it.
5. THE guard SHALL NOT apply to `GET /health`, which stays unauthenticated and returns only `{"ok":true}`.
6. THE guard SHALL be one shared module used by `/mcp` and `/api/*`, so both surfaces behave identically for Host and Origin.
