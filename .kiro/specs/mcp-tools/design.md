# Design Document

## Overview

`backend/src/mcp/` implements a minimal stateless Streamable HTTP MCP server on the same `node:http` server as `/health` (see `irc-bridge`). It depends on a small `Bridge` interface (read from the store, send through the queue, wait for events), so tests run against the fake ircd or a stub bridge.

## Architecture

The MCP handler is a stateless HTTP layer on the backend's single `node:http` server. It reads the `irc-bridge` store and sends lines only through the bridge send queue.

### Transport

- `POST /mcp`: body is one JSON-RPC message or an array. Response is `application/json`. Notifications get `202` with no body. `GET` and `DELETE` get `405` with `Allow: POST`. No `Mcp-Session-Id` is issued, so every call is independent.
- Body limit 64 KiB (counted while streaming, abort with 413). Before the body is read, the shared local-caller guard (`src/http/guard.ts`) runs; see "Local-caller protection".
- Protocol version negotiation as in requirement 1.2. The `MCP-Protocol-Version` request header is accepted and ignored.
- MCP traffic does not go through the signed dashboard proxy, and the gateway adds no header or secret to MCP calls (see "Local-caller protection").

### Waiting for outcomes

`summon`, `exorcise` and `whois` register a one-shot listener on the store's event emitter before sending, then send, then await the matching event or timeout (20 s, 10 s, 5 s). Listeners are always removed in a `finally`. A timed-out `summon` returns `ready: false` as a normal result, since some agents take longer to start.

### Local-caller protection

`src/http/guard.ts` exports `checkLocalCaller(req, { port, gatewayOrigin })` returning `{ ok: true }` or `{ ok: false, status: 421 | 403, code }`. It is used by the `/mcp` handler and, in `dashboard-ui`, by the `/api/*` router.

1. **Host** (421 `bad_host`): the header must equal `127.0.0.1:<port>` or `localhost:<port>` (case-insensitive), where `<port>` is the port the server is listening on. A missing `Host` fails. This stops DNS rebinding, where a page on `evil.example` resolves to `127.0.0.1` but still sends `Host: evil.example`.
2. **Origin** (403 `bad_origin`): if `Origin` is present it must be the gateway origin. `KIROCREW_GATEWAY_ORIGIN` is `http://127.0.0.1:5476`, but a user may open the dashboard as `http://localhost:5476`, so the comparison normalizes scheme, port and the loopback names (`127.0.0.1`, `localhost`, `[::1]`). `Origin: null` and any other origin fail. No `Origin` (curl, the MCP client in kiro-cli) passes. When `KIROCREW_GATEWAY_ORIGIN` is unset, any present `Origin` fails.
3. **Credential on `/mcp`**: none. In `bridges_mcp.py` (Kiro Crew 0.12.1, lines 1022-1049) the gateway copies the manifest entry and only rewrites the port; it adds no header or secret. A header written into `app.json` would be public. Task 1 re-checks this against the installed source. If a future gateway sends a credential, the guard gains a third check (403 `bad_credential`).

**Accepted risk:** any local process of the same user can call `/mcp`. The mitigations are the Host and Origin checks (against browsers), the `confirm: true` requirement on `grant_op` and `exorcise`, the untrusted-output wrapping, and the send queue limits. This is written in `.kiro/steering/security.md` and in the README security section.

`/health` is routed before the guard and returns `{"ok":true}` only.

Tests: wrong Host → 421; `Host: 127.0.0.1` without port → 421; matching Host passes; foreign `Origin` → 403; gateway `Origin` (including the `localhost` spelling) passes; `Origin: null` → 403; no `Origin` passes; the guard runs before body parsing (an oversized body with a bad Host gets 421, not 413).

## Components and Interfaces

### Files

| File | Responsibility |
| --- | --- |
| `src/mcp/rpc.ts` | JSON-RPC 2.0 envelope parsing, error codes, batch handling. |
| `src/mcp/handler.ts` | `handleMcp(req, res, tools, deps)`: method checks, Origin check, body limit, dispatch of `initialize`, `ping`, `tools/list`, `tools/call`. |
| `src/mcp/validate.ts` | Tiny validator: `object({ field: string({max}), enum([...]), int({min,max}), bool() })` returning typed values or a precise error. |
| `src/mcp/tools.ts` | Tool definitions: `name`, `description`, `inputSchema` (JSON Schema), `parse`, `run`. |
| `src/mcp/untrusted.ts` | `wrapUntrusted(source, from, text)`, escaping. |
| `src/mcp/waiters.ts` | `waitFor(bridge, predicate, ms)` on store events, with cleanup on timeout. |

### Tools

All inputs use `additionalProperties: false`.

| Tool | Input | Effect |
| --- | --- | --- |
| `list_channels` | `{}` | Reads store. |
| `read` | `{ channel, since?: int ≥ 0, limit?: int 1..200 }` | Reads ring buffer. |
| `say` | `{ channel, text: string 1..400 }` | `PRIVMSG`. |
| `summon` | `{ channel, agent?: nick }` | `INVITE`, waits for `<agent> is ready`. |
| `grant_op` | `{ channel, agent, mode: "+v"\|"-v"\|"+o"\|"-o", confirm: boolean }` | `MODE`, needs `confirm: true`. |
| `exorcise` | `{ channel, agent, reason?: string ≤ 200, confirm: boolean }` | `KICK`, needs `confirm: true`. |
| `whois` | `{ nick }` | `WHOIS`, waits for `318`. |
| `credits` | `{ channel?: string }` | Reads store. |

`confirm` is declared `type: boolean` in the schema and required. The validator accepts any boolean but `run` refuses unless it is exactly `true`; the refusal text is: "confirm: true is required. Ask the human first, then call again with confirm: true."

## Data Models

### Results

Every result has:

```ts
{
  content: [{ type: "text", text: string }],   // human-readable, channel text wrapped
  structuredContent?: { untrusted: boolean, ... }, // plain data
  isError?: boolean
}
```

`wrapUntrusted("#fix-bug", "coder", text)` yields `<untrusted source="channel:#fix-bug" from="coder">…</untrusted>` after replacing `<untrusted` with `<\u200buntrusted` and `</untrusted` with `<\u200b/untrusted`. Topics and notices use `from="server"` or the sender nick. The wrapper is only in `content`; `structuredContent` carries raw strings plus `untrusted: true`.

### Result size

`read` trims from the oldest line until the serialized result is ≤ 32 KiB and sets `trimmed: true`.

## Error Handling

### Error mapping

| Situation | Result |
| --- | --- |
| Bad JSON / envelope / unknown method | JSON-RPC error `-32700` / `-32600` / `-32601` |
| Unknown tool, bad `params` shape | JSON-RPC error `-32602` |
| Invalid tool arguments | `isError: true`, message names property and rule |
| `confirm` missing | `isError: true`, confirmation message |
| Bridge not registered | `isError: true`, "bridge is <state>" |
| `LineError` from the bridge | `isError: true`, code and message (`too-long`, `bad-char`, `queue-full`, …) |
| Numeric `482`/`473`/`401`/`403` for the call | `isError: true`, mapped hint |
| Unexpected throw | `isError: true`, "internal error"; redacted log |

## Correctness Properties

### Property 1: Rejected calls send nothing

Every tool call that fails validation, lacks `confirm: true` where required, or arrives while the bridge is not `registered` sends zero lines to the server.

**Validates: Requirements 3.3, 3.4, 4.6, 5.6, 5.8**

### Property 2: Channel text cannot break out of its wrapper

Every piece of channel text in a tool result is wrapped so that it cannot close or fake the `<untrusted>` wrapper.

**Validates: Requirements 6.1, 6.2**

### Property 3: Foreign callers are rejected before the body is read

A `/mcp` request with a wrong `Host` or a foreign `Origin` is rejected before its body is read.

**Validates: Requirements 1.7, 8.1, 8.2**

## Testing Strategy

- Handler tests drive `handleMcp` with fake `IncomingMessage`/`ServerResponse` objects or a real `http.Server` on port 0 bound to loopback (no external network).
- Tool tests use the fake ircd to assert the exact lines sent (`INVITE coder #c`, `MODE #c +o coder`, `KICK #c coder :reason`) and that nothing is sent when validation or `confirm` fails.
- Untrusted wrapper tests include a message that tries to close the wrapper and one that looks like an instruction.
- Property test: random arguments never cause a sent line with CR/LF/NUL or over 512 bytes.
