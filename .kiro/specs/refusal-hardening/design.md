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

### Global budget and safe eviction (Requirements 5 and 6)

The per-key limit alone can be bypassed: a server that sends refusals for 100 or more different targets makes the map evict its oldest keys, so each new target is reported, and a tracked channel's own key can be evicted and reset. The limiter now has a second limit and a stricter eviction rule.

```ts
note(key, now): { report: boolean; suppressed: number; summary: number }
```

1. **Global window.** `globalStart` and `globalCount` track one 10 s window across all keys (a clock that steps back opens a new one). The budget is `REFUSAL_GLOBAL_BUDGET = 20` reports per window.
2. **Open key.** A refusal for a key whose window is still open is counted on the key and is never reported. It is checked before the budget, and an open key is never evicted.
3. **New window for the key, or a new key.** If the global budget is used up, the refusal is not reported and `globalSuppressed` goes up. The key's slot is left as it is, so its held count is not lost.
4. **Room for a new key.** If the map holds 100 keys, only expired slots are dropped, oldest first. The `held` count of a dropped slot is added to `globalSuppressed`, so the "(N more suppressed)" figure is not silently lost (finding 2). If every slot is still open, the new key is not stored and the refusal counts in `globalSuppressed`.
5. **Report.** The key is stored (moved to the newest end), `globalCount` goes up, and the decision carries `suppressed` (the key's held count from its closed window) and `summary` (the value of `globalSuppressed`, which is then reset).

`onRefusal` writes one `warn` entry "<N> refusal reports suppressed (global limit)" when `summary > 0`, before the report it came with. It is log only: no channel line, and it does not count against the budget. There is no timer, so a summary appears with the next allowed report and not on its own; if no further refusal comes, the count stays in memory.

The key (`refusalKey` in `dispatch.ts`) is built from the cut, lower-cased target (at most 60 characters, a plain slice), so a long server-chosen target cannot grow memory. For 441 and 443 it also holds the lower-cased nick, but only when `isValidNick(nick)` (at most 30 characters); two nicks in one channel are then two keys (finding 3). An invalid nick is left out of the key, the log entry and the channel line.

The `server-error` event is emitted before any of this and is never limited. Its payload does not change.

#### Expectations changed on purpose

- `refusal-limit.test.ts` "keeps at most 100 keys and drops the oldest first" assumed that open keys are evicted oldest first. It now fills the map with keys whose windows are open and checks that a new key is not stored and not reported, and a second test checks that expired keys are dropped oldest first.
- `refusal-limit.test.ts` "a renewed key moves to the newest end" used times that are all inside one window; it now spaces the times so the windows are expired when the key is renewed.
- Tests that sent more than 20 distinct keys in one window (none in `refusals.test.ts` or `refusal-hardening.test.ts`) would now be limited; the existing ones use at most 4 keys, so none changed.

### Monotonic time for the limiter (Requirement 8)

`store.now()` is the wall clock (`systemClock.now = () => Date.now()`). The limiter only measures elapsed time, so a wall clock that steps back (an NTP correction, a manual change) would open a new global window and expire every key window, and the report budget would refill early. The limiter therefore gets a monotonic time.

1. `backend/src/clock.ts`: `Clock` gets an optional `monotonic?(): number` ("milliseconds from an arbitrary origin; never steps back; only for measuring elapsed time"). `systemClock.monotonic` is `() => performance.now()` (the global `performance`; no import, no dependency).
2. `backend/src/irc/store.ts`: `monotonicNow()` next to `now()` returns `this.clock.monotonic?.() ?? this.clock.now()`. A clock without `monotonic` (every existing test fake) falls back to `now()`, so nothing in the tests changes.
3. `backend/src/irc/dispatch.ts`: `refusalLimiter.note(...)` takes `store.monotonicNow()`. No other `store.now()` call changes: line timestamps, `serverTime`, inbox ages and the `ready` and commit times stay on the wall clock, because people read them.
4. `backend/src/irc/refusal-limit.ts`: the logic is unchanged, including the "clock steps back" guard in `open()`, which stays as defence in depth. Only the header comment changes: the caller passes a monotonic time.

The limits (`REFUSAL_WINDOW_MS`, `REFUSAL_MAX_KEYS`, `REFUSAL_GLOBAL_BUDGET`) and the report and summary text do not change. There is still no timer.

## Data Models

No persistent data, no API field. The limiter holds at most 100 small records and four numbers in memory, and it is created with the dispatcher.

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

### Property 5: The report rate is bounded however many targets there are

In any window of 10 seconds at most 20 reports are written, and a key with an open window is never dropped or reset.

**Validates: Requirements 5.1, 5.3, 5.4**

### Property 6: Held-back counts are not lost

A count held on a key that is dropped, and a refusal that was not stored or not reported, reach the next global summary.

**Validates: Requirements 5.2, 5.5**

### Property 7: A wall clock step does not refill the budget

While the monotonic time stays inside a window, moving the wall clock back or forward by any amount gives no extra report, and the next report after `REFUSAL_WINDOW_MS` of monotonic time carries the suppressed count.

**Validates: Requirements 8.1, 8.2, 8.3**

### Property 4: The report rate per key is bounded

Within one window a key yields at most one `warn` entry and one line, and the map never holds more than 100 keys.

**Validates: Requirements 3.1, 3.3, 3.4**

## Testing Strategy

- `backend/test/refusal-limit.test.ts`: `RefusalLimiter` alone with explicit times: first reported, the rest held, a report after the window with the held count, a count of zero says nothing, distinct keys, a clock step back, 100-key bound with the oldest dropped, a renewed key stays.
- `backend/test/refusal-hardening.test.ts` (bridge with the fake ircd and the fake clock): the secret across the reason cut and across the target cut, and split by a control character; 441 and 443 with a tracked and an untracked channel and with three parameters only; 20 identical refusals give one `warn` and one line, the next after 10 s says `(19 more suppressed)`; a different numeric or channel is not suppressed; 20 events are still emitted; `summon`, `grant_op` and `exorcise` resolve on 442, 482 and 441.
- `backend/test/refusals.test.ts`: the earlier 441 case moves to the new parameter form.
