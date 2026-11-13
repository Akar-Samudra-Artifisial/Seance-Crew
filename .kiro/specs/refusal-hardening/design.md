# Design Document

## Overview

Three changes inside the refusal path of `backend/src/irc/dispatch.ts`, plus one small helper file. The refusal path is the code that `demo-say-fixes` added: `onRefusal`, and the `case "403" … "482"` that calls it. Nothing else moves.

| Finding | Where | Change |
| --- | --- | --- |
| Cut, then redact | `dispatch.ts` `onRefusal`, `cleanServerText` | Redact the raw text, clean it, redact again, then cut |
| 441 and 443 never reach the log | `dispatch.ts` `case` | A numeric-aware channel and nick; the event payload is unchanged |
| Repeated refusals flood the log | `backend/src/irc/refusal-limit.ts`, `dispatch.ts` | `RefusalLimiter` with a 10 s window and 100 keys |

## Architecture

The dispatcher already holds the logger (for `redact`) and the store (for `now()` and `channel()`). The limiter is a plain class that takes the time as an argument, so it needs no timer: the window is checked when a refusal arrives. The store's clock is the injectable `Clock`, so tests move time with `FakeClock`.

### Process

For each refusal numeric the dispatcher does two independent things, in this order:

1. `onRefusal(...)`: build the key, ask the limiter, and report (or not).
2. `store.emit({ type: "server-error", … })` with the same payload as before, always.

So the limiter can never hide a reply from a waiting tool.

## Components and Interfaces

### Redaction order (Requirement 1)

```ts
export function cutText(text: string, max: number): string          // the cut only
export function cleanServerText(text: string, max: number): string  // clean, then cut (unchanged signature)
const safeText = (raw: string, max: number): string => {
  const first = redact(raw);                    // the whole raw text
  const clean = cleanServerText(first, Infinity); // formatting and controls removed, nothing cut
  return cutText(redact(clean), max);           // redact again, then cut
};
```

`redact` is `logger.redact` (the Séance secret and `PASS` lines). Redacting twice costs nothing and catches a secret that was split by a control character in the raw text. The cut is always last. A search of `dispatch.ts` for other places that cut or truncate text before redacting found none: `onRefusal` is the only caller of `redact`, and the other server text that is stored (lines, topics) is not logged by this file. The suffix `(N more suppressed)` is added after the cut, so it is never cut off.

### Where the channel is (Requirement 2)

```ts
const nickFirst = numeric === "441" || numeric === "443";   // <me> <nick> <channel> :text
const channel = nickFirst ? (p.length >= 4 ? p[2] : "") : (p.length >= 3 ? p[1] : "");
const nick    = nickFirst && p.length >= 4 ? p[1] : "";
const target  = channel !== "" ? channel : (p.length >= 3 ? p[1] : "");   // what the log calls the target
```

- With a channel, the line is `Server refused (441): coder: They aren't on that channel`; without a nick it is the old form.
- The log entry is `{ numeric, target, reason }` plus `nick` for the two numerics.
- `server-error` keeps `target: p[1]`. `act-tools.ts` waits on `INVITE_ERRORS`, `MODE_ERRORS`, `KICK_ERRORS` and `JOIN_ERRORS` and compares the event target with the channel or the agent; for 441 that is the agent nick, as today.

### Rate limit (Requirement 3)

```ts
class RefusalLimiter {
  note(key: string, now: number): { report: boolean; suppressed: number }
  readonly size: number
}
```

- `key` is `<numeric> <lower-case channel or target>`.
- First refusal of a key (or the first after its window closed): `report: true`, with `suppressed` set to the number held back in the closed window (0 for a new key).
- Others inside the 10 s window: `report: false`, and the held count goes up.
- A new key when 100 are held drops the oldest (a `Map` keeps insertion order; a renewed key is re-inserted at the newest end).
- A summary is not sent on its own when the window closes, because that would need a timer. The count is told on the next report of the key, as the spec asks ("or a single summary when the window closes on the next refusal").
- `onRefusal` adds ` (N more suppressed)` after the cut reason when `suppressed > 0`, in the log entry (`reason`, plus a `suppressed` field) and in the channel line.

## Data Models

No persistent data, no API field. The limiter holds at most 100 small records in memory, and it is created with the dispatcher.

## Error Handling

- A refusal without a logger still works: `redact` is the identity and nothing is logged.
- A clock that steps back does not suppress forever: a refusal with `now` before the window start opens a new window.
- A refusal for an untracked or invalid channel never creates state: the line is added only when `store.channel(channel)` exists.

## Correctness Properties

### Property 1: No part of the secret survives

For any position of the secret in the reason or the target (before, across or after a cut position, or split by control characters), neither the log entry nor the channel line contains it or a prefix of it longer than the mask.

**Validates: Requirements 1.1, 1.2, 1.3, 1.4**

### Property 2: A refusal reaches the channel its numeric names

For 441 and 443 with a tracked channel in the third parameter there is exactly one line, and none for an untracked one.

**Validates: Requirements 2.1, 2.2, 2.3**

### Property 3: Waiters see every reply

The `server-error` event is emitted once per refusal, with an unchanged payload, whether or not the report was suppressed.

**Validates: Requirements 2.4, 3.6**

### Property 4: The report rate per key is bounded

Within one window a key yields at most one `warn` entry and one line, and the map never holds more than 100 keys.

**Validates: Requirements 3.1, 3.3, 3.4**

## Testing Strategy

- `backend/test/refusal-limit.test.ts`: `RefusalLimiter` alone with explicit times: first reported, the rest held, a report after the window with the held count, a count of zero says nothing, distinct keys, a clock step back, 100-key bound with the oldest dropped, a renewed key stays.
- `backend/test/refusal-hardening.test.ts` (bridge with the fake ircd and the fake clock): the secret across the reason cut and across the target cut, and split by a control character; 441 and 443 with a tracked and an untracked channel and with three parameters only; 20 identical refusals give one `warn` and one line, the next after 10 s says `(19 more suppressed)`; a different numeric or channel is not suppressed; 20 events are still emitted; `summon`, `grant_op` and `exorcise` resolve on 442, 482 and 441.
- `backend/test/refusals.test.ts`: the earlier 441 case moves to the new parameter form.
