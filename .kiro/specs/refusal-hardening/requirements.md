# Requirements Document

## Introduction

`demo-say-fixes` made server refusals visible: each refusal numeric is logged once at `warn` and, for a tracked channel, shown as a `system` line in the channel log. A code review of that change (`onRefusal` in `backend/src/irc/dispatch.ts`) found three Minor problems. The secret is redacted after the text is cut, so a secret that straddles the cut can leak in part. Two numerics (441 and 443) carry a nick before the channel, so their channel never matches and they never reach the log. And a server, or a loop, can send the same refusal many times, which floods the log and the channel. This spec fixes the three. It changes `irc-bridge` only, adds no tool, no API field and no dependency, and does not change the internal `server-error` event.

## Glossary

- **Refusal**: a numeric reply that a command was rejected: 403, 404, 441, 442, 443, 461, 471, 472, 473, 474, 475, 481 or 482.
- **Report**: the one `warn` log entry and the one `system` channel line that a refusal produces.
- **Reason**: the last parameter of the refusal, which is server text and therefore untrusted.
- **Key**: the pair of the refusal numeric and the channel (or the target, when there is no channel), compared without case.
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
4. THE bridge SHALL remember at most 100 keys and SHALL drop the oldest when a new key would exceed that.
5. THE bridge SHALL measure the window with the store's injectable clock, so that tests need no real wait.
6. THE bridge SHALL emit the internal `server-error` event for every refusal, reported or not, so a waiting tool sees every reply.

### Requirement 4: The fixes are pinned by tests and the bundle is rebuilt

**User Story:** As a maintainer, I want each fix covered by a test, so that the review findings stay fixed.

#### Acceptance Criteria

1. THE repository SHALL have tests showing that a secret straddling the reason cut and the target cut is fully redacted in the log entry and in the channel line; that 441 and 443 produce one line in the channel named by the third parameter and none for an untracked channel; that 20 identical refusals within 10 seconds produce one `warn` and one line, and that the next one after the window mentions the number held back; that different keys are not suppressed; that the key map is bounded; and that the `summon`, `grant_op` and `exorcise` waiters still resolve on 441, 442 and 482.
2. `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm check:dist` SHALL pass, with `backend/dist/server.js` rebuilt.
