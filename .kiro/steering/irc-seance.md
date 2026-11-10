---
inclusion: fileMatch
fileMatchPattern: ["backend/**", ".kiro/specs/irc-bridge/**", ".kiro/specs/mcp-tools/**"]
---
# Séance protocol facts

Use exactly these facts. The vendored `@seance/irc-protocol` (`backend/vendor/irc-protocol/`) is the only parser and serializer.

## Connection

- Connect to `wss://<host>/ws`. Origin rule: no Origin header is accepted; an Origin that is not in the server's `IRCD_WS_ALLOWED_ORIGINS` is answered with HTTP 403. The bridge sends no Origin (Node's global `WebSocket` sends none).
- Handshake: `PASS <nick>:<secret>`, `NICK <nick>`, `USER <nick> 0 * :seance-crew`. The nick must equal the account name.
- Registration must finish within 15 s. At most 3 bad `PASS` per connection and 10 per IP per 10 minutes, so never retry a rejected `PASS` in a loop.
- Text frames only. Lines end in CRLF and are at most 512 bytes including CRLF, counted in UTF-8 bytes. A frame may hold several lines or a partial line; always go through `LineFramer`.
- Keepalive is IRC `PING`/`PONG`. There is no WebSocket-level ping.

## Limits

- Server flood limit: burst 10, refill 1 line/s. Our send queue allows a burst of 8, then 1 line/s.
- At most 5 connections per IP. We hold exactly one; a second instance refuses to start.
- Reconnect with exponential backoff plus jitter, capped. Stop retrying after an authentication failure.

## Agents

- `INVITE <agent> <#chan>` summons an agent. The inviter's account must be in `SEANCE_INVITERS` on the server.
- `MODE <#chan> +v <agent>`: read and speak. `MODE <#chan> +o <agent>`: write and run.
- `KICK <#chan> <agent> :<reason>` exorcises the agent.
- Default agent nick: `coder`.

## ChanServ notices to parse into events

- `worktree ready: <dir> @ <sha>`
- `<agent> is ready`
- `session closed, worktree reset to <sha>` and `session cancelled, worktree reset to <sha>`
- `<N> file(s) reverted · <X.XX> credits used`
- `<agent> committed <sha> (<n> file(s))`
- Denied action, goes to the needs-op inbox: `ops: <agent> denied <action>: needs-op`

## WHOIS and LIST

- WHOIS numerics: 311, 312, 319, 320, 317, 318. Lines with numeric 320 carry `model: …`, `tools: …` and `credits: <#chan> X.XX / total Y.YY`.
- There is no isAgent flag. A nick is an agent when its WHOIS has a 320 `model:` line.
- LIST: `322 <me> <#chan> <count> :<topic>`, ended by `323`.
