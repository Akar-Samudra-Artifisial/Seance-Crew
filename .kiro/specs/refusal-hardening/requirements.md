# Requirements Document

## Introduction

`demo-say-fixes` made server refusals visible: each refusal numeric is logged once at `warn` and, for a tracked channel, shown as a `system` line in the channel log. A code review of that change (`onRefusal` in `backend/src/irc/dispatch.ts`) found three Minor problems. The secret is redacted after the text is cut, so a secret that straddles the cut can leak in part. Two numerics (441 and 443) carry a nick before the channel, so their channel never matches and they never reach the log. And a server, or a loop, can send the same refusal many times, which floods the log and the channel. This spec fixes the three (Requirements 1 to 4). A later security review then found that the per-key limit can be bypassed by sending refusals for many different targets, and a review of commit d11ab18 found that two nicks in one channel suppress each other (Requirements 5 to 7). A last security review (Low) found that the limiter uses the wall clock, so a clock that steps back refills the budget early (Requirement 8). It changes `irc-bridge` only, adds no tool, no API field and no dependency, and does not change the internal `server-error` event.

## Glossary

- **Refusal**: a numeric reply that a command was rejected: 403, 404, 441, 442, 443, 461, 471, 472, 473, 474, 475, 481 or 482.
- **Report**: the one `warn` log entry and the one `system` channel line that a refusal produces.
- **Reason**: the last parameter of the refusal, which is server text and therefore untrusted.
- **Key**: the refusal numeric and the channel (or the target, when there is no channel), compared without case, cut to 60 characters; for 441 and 443 also the nick.
- **Global budget**: the 20 reports allowed per window across all keys.
- **Window**: 10 seconds, counted from the first report of a key.
- **Tracked channel**: a channel the store already holds.

## Requirements

### Requirement 1: Redact before cutting

**User Story:** As an operator, I want the secret never to appear in a refusal report, so that a long or hostile reason cannot leak part of it.

#### Acceptance Criteria

1. WHEN a refusal is reported, THE bridge SHALL redact the whole raw reason and the whole raw target before it cleans or cuts them, so a secret that crosses the cut position is replaced as a whole.
2. THE bridge SHALL redact once more after cleaning and before cutting, so a secret hidden by control or formatting characters inserted into it is also replaced.
3. THE bridge SHALL cut the reason to 120 characters and the target to 60 characters only after both redactions.
4. THE log entry and the channel line SHALL contain no part of the secret, for any position of the secret in the reason or the target.
5. THE bridge SHALL NOT cut a string and redact it afterwards anywhere in `backend/src/irc/dispatch.ts`.

### Requirement 2: Refusals that name a nick first reach the channel log

**User Story:** As an operator, I want a failed kick or invite of an agent to show in the channel, so that I see why an agent was not removed or added.

#### Acceptance Criteria

1. WHEN the numeric is 441 or 443 and has the form `<me> <nick> <channel> :<text>`, THE bridge SHALL take the channel from the third parameter and the nick from the second.
2. WHEN that channel is tracked, THE bridge SHALL add one `system` line that names the nick: `Server refused (<numeric>): <nick>: <reason>`; WHEN it is not tracked, THE bridge SHALL log the refusal only and SHALL NOT create a channel or a line.
3. WHEN a 441 or 443 has no channel parameter, THE bridge SHALL treat the second parameter as the target and SHALL log it without a channel line.
4. THE bridge SHALL keep the payload of the `server-error` event exactly as before (`target` is the second parameter), so the waiters of `summon`, `grant_op` and `exorcise` still match on it.
5. THE log entry SHALL carry the channel as `target` and the nick as `nick` for these two numerics.

### Requirement 3: Identical refusals are rate limited

**User Story:** As an operator, I want a flood of identical refusals not to bury the channel log, so that the page stays readable and the log stays small.

#### Acceptance Criteria

1. THE bridge SHALL report at most one refusal per key per window: the first is reported, and the others in the same window are counted and not reported.
2. WHEN a refusal of a key arrives after its window has closed, THE bridge SHALL report it and SHALL append `(N more suppressed)` to the reason, where N is the number held back in the closed window; WHEN none were held back, THE bridge SHALL append nothing.
3. THE bridge SHALL treat refusals with a different numeric or a different channel or target as different keys, and SHALL NOT suppress them.
4. THE bridge SHALL remember at most 100 keys, and SHALL drop a key only as Requirement 5 allows (an expired window, never an open one).
5. THE bridge SHALL measure the window with the store's injectable clock, so that tests need no real wait.
6. THE bridge SHALL emit the internal `server-error` event for every refusal, reported or not, so a waiting tool sees every reply.

### Requirement 4: The fixes are pinned by tests and the bundle is rebuilt

**User Story:** As a maintainer, I want each fix covered by a test, so that the review findings stay fixed.

#### Acceptance Criteria

1. THE repository SHALL have tests showing that a secret straddling the reason cut and the target cut is fully redacted in the log entry and in the channel line; that 441 and 443 produce one line in the channel named by the third parameter and none for an untracked channel; that 20 identical refusals within 10 seconds produce one `warn` and one line, and that the next one after the window mentions the number held back; that different keys are not suppressed; that the key map is bounded; and that the `summon`, `grant_op` and `exorcise` waiters still resolve on 441, 442 and 482.
2. `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm check:dist` SHALL pass, with `backend/dist/server.js` rebuilt.

### Requirement 5: The limit cannot be bypassed with many different targets

**User Story:** As an operator, I want a hostile server not to flood the log by sending refusals for hundreds of different targets, so that the per-key limit still protects me when the keys are all new.

#### Acceptance Criteria

1. THE bridge SHALL allow at most 20 reports (a log entry and a channel line count as one report) per 10 second window across all keys, in addition to the per-key limit.
2. WHEN a refusal would be reported but the global budget of the window is used up, THE bridge SHALL NOT report it and SHALL count it; WHEN the first report is allowed after the budget refills, THE bridge SHALL first write one `warn` entry "<N> refusal reports suppressed (global limit)" (log only, no channel line) and then the report.
3. THE bridge SHALL drop a key from its map only when the window of that key has expired, oldest first, and SHALL NOT drop a key whose window is still open, so a tracked channel's key is never reset by a flood of other keys.
4. WHEN the map holds 100 keys whose windows are all still open, THE bridge SHALL NOT store a new key, SHALL NOT report its refusal, and SHALL count it for the global summary.
5. WHEN an expired key that has held-back refusals is dropped, THE bridge SHALL add its held count to the global count, so the "(N more suppressed)" figure is not silently lost.
6. THE bridge SHALL build the key from the target cut to 60 characters and lower-cased, so a long server-chosen target cannot grow memory.
7. THE bridge SHALL evaluate every window when the next refusal arrives, with the store's injectable clock, and SHALL NOT start a timer.
8. THE bridge SHALL emit the internal `server-error` event for every refusal, whatever the limiters decide.

### Requirement 6: Two nicks in one channel are two keys, and only a valid nick is shown

**User Story:** As an operator, I want a failed kick of one agent not to hide the failed kick of another in the same channel, and I want the nick on the line to be one the server could really have meant.

#### Acceptance Criteria

1. FOR a 441 or 443, THE bridge SHALL build the key from the numeric, the lower-cased channel and the lower-cased nick, so two different nicks in the same channel are reported separately.
2. THE bridge SHALL use the nick of a 441 or 443 only when it passes `isValidNick`; otherwise THE bridge SHALL leave the nick out of the key, the log entry and the channel line (the channel is still taken from the third parameter).
3. THE nick part of the key SHALL stay within the nick length limit, because only a valid nick is used.

### Requirement 7: The extension is pinned by tests and the bundle is rebuilt

**User Story:** As a maintainer, I want each new fix covered by a test, so that the findings stay fixed.

#### Acceptance Criteria

1. THE repository SHALL have tests showing that 200 refusals for 200 different targets within 10 seconds give at most 20 reports and, after the window, one global summary entry; that a tracked channel's key is not reset by eviction while its window is open; that the held count of an expired key that is dropped appears in the next global summary; that two nicks in one channel with 441 are both reported; that an invalid nick in a 441 is left out; that the key stays bounded for a 5,000 character target; and that `server-error` is still emitted for every refusal.
2. Existing refusal tests SHALL still pass, and any expectation changed on purpose SHALL be named in `design.md`.
3. `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm check:dist` SHALL pass, with `backend/dist/server.js` rebuilt.

### Requirement 8: The limiter measures time with a monotonic source

**User Story:** As an operator, I want the refusal limits to hold even when the host clock is corrected or changed, so that a clock that steps back cannot refill the report budget early.

#### Acceptance Criteria

1. THE refusal limiter SHALL measure its windows with a monotonic time source, so a wall clock that steps back or forward does not open or close a window.
2. WHEN the clock has no monotonic source (a test fake), THE store SHALL fall back to `now()`, so existing fake clocks keep working without changes.
3. Timestamps shown to people (log lines, `serverTime`, line `at`) SHALL stay on the wall clock.
