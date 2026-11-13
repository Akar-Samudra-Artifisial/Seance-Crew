# Requirements Document

## Introduction

A live rehearsal of `docs/DEMO.md` (2026-11-13) showed three faults around `say`. The steward summoned `coder` and called `say` at once, without the `grant_op +v` that step 3 of the demo expects. The message it sent never appeared in the channel log, because the server does not echo our own `PRIVMSG` and the store is filled only from server lines. And the agent never answered, with nothing on the page to say why: the server's refusals (for example `404 Cannot send to channel`) are turned into an internal event that only `summon`, `grant_op` and `exorcise` listen for, so a rejected `PRIVMSG` vanishes. This spec fixes the three faults. It changes `irc-bridge` (log and refusals) and `steward-agent` (skill and prompt) and does not add a tool or an API route.

## Glossary

- **Own message**: a `PRIVMSG` to a channel that the bridge itself sent, through the `say` tool.
- **Echo**: the server sending our own `PRIVMSG` back to us. The Séance server does not, and the bridge does not request the `echo-message` capability, but a server could.
- **Refusal**: a numeric reply that a command was rejected: 403, 404, 441, 442, 443, 461, 471, 472, 473, 474, 475, 481 or 482.
- **Tracked channel**: a channel the store already holds (it is in the channel list or has been joined).
- **Channel log**: the `lines` of a channel in the store, shown on the dashboard and returned by `read`.

## Requirements

### Requirement 1: Own messages appear in the channel log

**User Story:** As an operator, I want the message the steward sends to show up in the channel log, so that I can see what the agent was told and in what order it answered.

#### Acceptance Criteria

1. WHEN `say` has queued a message for a tracked channel without error, THE bridge SHALL add one line to that channel's log with `from` set to the bridge's own nick, kind `privmsg` (the kind of every channel message) and the message text.
2. THE bridge SHALL give an own message the same treatment as an incoming one: IRC formatting codes removed, the same ring capacity, and no line for a channel the store does not track (so `say` cannot make the store grow past its channel limits).
3. WHEN the server echoes an own message (a `PRIVMSG` from our own nick to the same channel with the same text) within 30 seconds of the send, THE bridge SHALL NOT add a second line; WHEN the same text arrives from our own nick and was not sent by `say`, THE bridge SHALL add it as a normal line.
4. IF `say` fails (not registered, rate limit, invalid line, queue full), THEN THE bridge SHALL NOT add a line, because nothing was sent.
5. THE `say` result SHALL stay `sent: true` only; the log line SHALL NOT change what the tool returns.
6. THE pending own-message markers SHALL be bounded (at most 20) and SHALL expire after 30 seconds, so memory does not grow.

### Requirement 2: Server refusals are visible

**User Story:** As an operator, I want to see when the server rejects something the steward sent, so that I do not wait for an agent that never got the message.

#### Acceptance Criteria

1. WHEN the server sends a refusal numeric, THE bridge SHALL log it once at level `warn` with the numeric, the target (a channel, nick or command name) and a short reason, with control characters and formatting codes removed and the reason cut to 120 characters.
2. WHEN the target of a refusal is a tracked channel, THE bridge SHALL also add one `system` line to that channel's log, from `server`, naming the numeric and the reason, so the dashboard and `read` show it.
3. WHEN the target is not a tracked channel (a nick, a command name, an unknown channel, or none), THE bridge SHALL log it but SHALL NOT create a channel or a line.
4. THE bridge SHALL keep emitting the internal `server-error` event for every refusal, so `summon`, `grant_op` and `exorcise` behave as before.
5. THE log entry and the channel line SHALL NOT contain the secret, and the reason text SHALL be treated as untrusted channel text.

### Requirement 3: The steward gets `+v` before the first `say`

**User Story:** As an operator, I want the steward to ask me for `+v` after a summon and wait for it, so that an agent that cannot speak is never sent a task that it will ignore.

#### Acceptance Criteria

1. THE skill SHALL state that after a `summon` the steward must ask the human for `grant_op` with `+v` and have it applied (approved) before the first `say` to that agent.
2. THE skill SHALL state that the steward must not `say` to an agent that has neither `+v` nor `+o`, and SHALL name the check (the agent's modes in `list_channels`).
3. THE agent prompt (`agents/seance-steward.json`) SHALL state the same two rules in one or two sentences.
4. THE typical flow in the skill SHALL put the `+v` grant before the first `say`.
5. A content test SHALL pin both rules in `SKILL.md` and in the agent prompt, so a rewrite of either file cannot drop them silently.

### Requirement 4: Tests and documents stay true

**User Story:** As a maintainer, I want each fix pinned by a test and the demo to describe what happens, so that the rehearsal does not find the same faults again.

#### Acceptance Criteria

1. THE repository SHALL have tests showing that an own `say` appears in `lines` exactly once, with and without an echo; that a failed `say` adds no line; that a 404 after `say` is logged once and shown in the channel log; and that the steward rule is present in `SKILL.md` and the agent prompt.
2. `docs/DEMO.md` step 3 SHALL say that the log shows the crew account's own message to `coder`.
3. `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm check:dist` SHALL pass, with `backend/dist/server.js` rebuilt.
