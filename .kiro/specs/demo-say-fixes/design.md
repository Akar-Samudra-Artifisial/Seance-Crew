# Design Document

## Overview

Three small changes, one per fault found in the demo rehearsal. The store learns to record our own messages, the dispatcher reports server refusals, and the steward's skill and prompt pin the order summon, `+v`, say. No new tool, no new API route, no change to the dashboard code.

| Fault | Where | Change |
| --- | --- | --- |
| Own `say` missing from the log | `backend/src/irc/store.ts`, `backend/src/mcp/act-tools.ts`, `backend/src/irc/dispatch.ts` | `Store.addOwnMessage` and an echo guard in the `PRIVMSG` branch |
| Refusals vanish | `backend/src/irc/dispatch.ts` | Log at `warn` and add a `system` line for a tracked channel |
| `say` before `+v` | `skills/seance-steward/SKILL.md`, `agents/seance-steward.json` | Rule 10, a flow step, a prompt sentence; content test |

## Architecture

Nothing moves. The dashboard and the `read` tool already render `lines` from the store, so a line added to the store reaches both. The refusal numerics already pass through `dispatch.ts`, which holds the logger.

### Process

`say` queues the line with `trySend`. Only when that returns no error does it call `store.addOwnMessage(channel, text)`. The server does not echo, so this is the only way the line reaches the log. If a server ever echoes, `addOwnMessage` leaves a marker that the `PRIVMSG` branch consumes.

## Components and Interfaces

### Own messages (`store.ts`)

```ts
addOwnMessage(channelName: string, text: string): ChannelLine | null
consumeOwnEcho(channelName: string, text: string): boolean
```

- `addOwnMessage` returns `null` and does nothing unless the channel is tracked (`this.channel(name) !== undefined`). Otherwise it calls `addLine(name, this.ownNick, "privmsg", text)`, which already strips formatting and fills the ring, then records a marker `{ key: <lower channel>\0<cleaned text>, at: now }`.
- Markers live in a small array, at most 20 (the oldest is dropped), each valid for `OWN_ECHO_MS = 30_000`. The text in the marker is the text after `stripFormatting`, so it compares equal to an echoed line after the same cleaning.
- `consumeOwnEcho` removes expired markers, then removes and returns `true` for the first marker that matches. A match means "this PRIVMSG is the echo of what `say` just sent".

### Echo guard (`dispatch.ts`, `PRIVMSG`)

```ts
const from = nickOfPrefix(message.prefix) || "server";
const text = stripFormatting(p[1] ?? "");
if (isOwn(from) && store.consumeOwnEcho(target, text)) break;   // our own line is already in the log
store.addLine(target, from, "privmsg", text);
```

The guard applies only to a message from our own nick, so a human or agent cannot suppress a line by sending the same text. The kind is `privmsg` and not a new `message` kind: the dashboard, `read`, the diff and the tests all treat `privmsg` as "a channel message", and a new kind would render as a muted event line.

### Refusals (`dispatch.ts`)

The existing `case "403" … "482"` keeps its `store.emit({ type: "server-error", … })` and now calls `onRefusal(numeric, target, text)` first:

1. `reason = cleanReason(text)`: `stripFormatting`, remove `[\x00-\x1f\x7f-\x9f]`, collapse spaces, cut at 120 characters.
2. `logger?.warn("server refused a command", { numeric, target: cleanReason(target), reason })`. The logger redacts the secret as it does for every field; nothing in a refusal carries it.
3. When `isValidChannel(target)` and `store.channel(target)` is defined: `store.addLine(target, "server", "system", \`Server refused (${numeric}): ${reason}\`)`. No `ensureChannel`, so a refusal cannot create state.

`401` stays as it is (a missing nick in a WHOIS is a normal answer, not a refusal).

### Steward rule

- `SKILL.md` Rules gain rule 10: "After `summon`, ask the human for `grant_op` with `+v` and have it applied before the first `say` to that agent. Never `say` to an agent that has neither `+v` nor `+o` (check its modes in `list_channels`)."
- The "Typical flow" step 2 ends "before the first `say`".
- `agents/seance-steward.json` `prompt` gains: "After `summon`, ask the human to approve `grant_op` with `+v` before your first `say` to that agent, and never `say` to an agent that has neither `+v` nor `+o`."
- `steward-content.test.ts` pins both, and its rule count becomes ten.

## Data Models

No persistent data and no new API field. `ChannelLine` is unchanged. The markers are in memory only.

## Error Handling

- A failed `say` (`requireRegistered`, rate limit, `LineError`) returns before `addOwnMessage`, so no line exists for a message that was not queued.
- A queued message that the server later rejects stays in the log (it was sent) and is followed by the refusal line, which is the intended picture: "crew said X" then "Server refused (404)".
- A refusal for an untracked target is logged only.

## Correctness Properties

### Property 1: A sent message is logged exactly once

For any tracked channel and text, after a successful `say` the log holds exactly one more line from our nick with that text, whether or not the server echoes it within 30 seconds.

**Validates: Requirements 1.1, 1.3, 1.6**

### Property 2: Nothing is logged for a message that was not sent

A `say` that fails validation, rate limiting or the registered check adds no line, and `say` to an untracked channel creates no channel.

**Validates: Requirements 1.2, 1.4**

### Property 3: Every refusal is reported once and creates no state

For every refusal numeric the bridge writes one `warn` entry; a tracked channel gets one `system` line and any other target gets none, and the channel list is unchanged.

**Validates: Requirements 2.1, 2.2, 2.3**

### Property 4: The steward rule cannot be dropped silently

`SKILL.md` and the agent prompt both contain the `+v`-before-`say` rule and the no-`say`-without-modes rule.

**Validates: Requirements 3.1, 3.2, 3.3, 3.5**

## Testing Strategy

- `backend/test/own-message.test.ts` (bridge with the fake ircd): `say` adds one line with our nick; an echoed `PRIVMSG` adds nothing more; the same text from our nick later than 30 s is added; the same text from another nick is added; a failed `say` adds none; `say` to an untracked channel adds none and creates no channel; formatting codes are stripped; 25 sends keep at most 20 markers.
- `backend/test/refusals.test.ts`: a 404 after `say` gives one `warn` log and one `system` line that `read` returns; each refusal numeric is logged; a nick or command target is logged without a channel; an untracked channel is not created; control characters and a long reason are cleaned and cut; the `server-error` event is still emitted; the log text holds no secret.
- `backend/test/steward-content.test.ts`: rule 10 and the flow step in `SKILL.md`, the sentence in the agent prompt, ten rules.
