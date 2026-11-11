# Requirements Document

## Introduction

One Kiro Crew dashboard page (`/apps/seance-crew`) shows the Séance channels the bridge knows about and lets a signed-in owner summon, grant op to, and exorcise agents. The page is a React bundle (`ui/dist/index.mjs`) that talks to the backend only through `useAppApi()` and a small JSON API under `/api/*`. Every path the page calls is listed in `permissions.api` in `app.json`.

## Glossary

- **Page**: the Séance Crew dashboard page served at `/apps/seance-crew`.
- **Inbox**: the list of open needs-op items.
- **Agent**: a channel member whose WHOIS showed a `model:` line.
- **Gateway**: the Kiro Crew gateway that proxies dashboard calls to the backend.
- **Revision**: a counter that increases on every store change and lets the page ask only for changes.

## Requirements

### Requirement 1: Channel overview

**User Story:** As an operator, I want to see all channels and their agents at a glance, so that I know what is running without opening a chat client.

#### Acceptance Criteria

1. WHEN the page loads, THE page SHALL fetch `GET /api/state` and show one card per channel with name, topic, member count and the list of agents.
2. THE page SHALL show for each agent: nick, modes (`+o`, `+v` or none) as text and icon (not color alone), model, and a ready or starting indicator.
3. WHEN there are no channels, THE page SHALL show an empty state that explains how to summon an agent.
4. THE page SHALL show the bridge state (`registered`, `connecting`, `reconnecting`, `unconfigured`, `auth-failed`, `duplicate-instance`) in a status banner, and for `unconfigured` or `auth-failed` SHALL tell the user to check `host`, `nick` and `secret` in the app settings.
5. THE page SHALL render all channel text (topics, nicks, commit text) as plain text and SHALL NOT render it as HTML.
6. THE page SHALL show the recent log of a channel (up to the 200 newest lines delivered by `GET /api/state`, oldest first) in an expandable panel per channel, with sender, time and text rendered as plain text, and SHALL label the panel as untrusted channel text.

### Requirement 2: Live credits and commits

**User Story:** As an operator, I want to watch cost and progress as it happens, so that I can stop an agent before it spends more than I intended.

#### Acceptance Criteria

1. THE page SHALL show credits used per channel and a total, with two decimals, or "n/a" when unavailable.
2. THE page SHALL show the last 5 commits per channel (agent, short sha, file count, time).
3. WHEN new data arrives, THE page SHALL update credits and commits without a full reload and SHALL announce new commits and new inbox items to assistive technology through an `aria-live="polite"` region.
4. THE page SHALL refresh by polling `GET /api/state` every 3 seconds while the tab is visible, pause polling while hidden, and refresh immediately after any action.
5. IF a poll fails, THEN THE page SHALL keep the last data, show a "connection to the app lost" notice with the time of the last success, and back off to a 10 second interval until a poll succeeds.
6. THE page SHALL show the latest daily summary from `GET /api/summary` (date, total credits, credits per channel) or the text "No summary yet", and SHALL refresh it on load and every 60 seconds while the tab is visible.

### Requirement 3: Needs-op inbox

**User Story:** As an operator, I want to resolve permission requests in one place, so that a blocked agent does not wait for me to find the request.

#### Acceptance Criteria

1. THE page SHALL list open inbox items with channel, agent, denied action and age.
2. WHEN the user chooses "Grant op" on an item, THE page SHALL show a confirmation dialog naming the agent, channel and the effect of `+o` (write and run), and SHALL call `POST /api/grant-op` with `confirm: true` only after the user confirms.
3. WHEN the user chooses "Dismiss", THE page SHALL call `POST /api/inbox/dismiss` and remove the item.
4. WHEN a grant succeeds, THE page SHALL show a success message and the item SHALL disappear after the next refresh.
5. WHEN the inbox is empty, THE page SHALL say so.

### Requirement 4: Summon and exorcise

**User Story:** As an operator, I want to start and stop agents safely, so that I never grant op or reset a worktree by accident.

#### Acceptance Criteria

1. THE page SHALL offer a "Summon" form with a channel field (must start with `#`) and an optional agent field (default `coder`), and SHALL call `POST /api/summon`; the form text SHALL say that the crew account joins the channel first if it is not a member, and that waiting can take up to 30 seconds (10 s to join, 20 s for ready).
2. WHILE a summon request is pending, THE page SHALL show progress and disable the submit button; WHEN the result says `ready: false`, THE page SHALL say the agent is still starting and will appear when ready.
3. THE page SHALL offer an "Exorcise" button per agent that opens a confirmation dialog naming the agent and channel and stating that uncommitted work in the worktree is reverted.
4. WHEN the user confirms, THE page SHALL call `POST /api/exorcise` with `confirm: true`; WHEN the user cancels, THE page SHALL send nothing.
5. THE page SHALL offer a mode control per agent to switch between `+v` and `+o` (and back), and every change SHALL pass through the same confirmation dialog.
6. IF an action fails, THEN THE page SHALL show the error message from the backend next to the action and SHALL keep the form values.

### Requirement 5: Backend JSON API

**User Story:** As the dashboard page, I want a small, safe API, so that the page can show state and act without exposing the backend to other callers.

#### Acceptance Criteria

1. THE backend SHALL implement `GET /api/state`, `GET /api/summary`, `POST /api/summon`, `POST /api/grant-op`, `POST /api/exorcise` and `POST /api/inbox/dismiss`, and `app.json` `permissions.api` SHALL list exactly these paths with the `/apps/seance-crew` proxy prefix (for example `/apps/seance-crew/api/state`).
2. THE backend SHALL answer JSON with `Cache-Control: no-store`, accept only `application/json` bodies up to 16 KiB on POST, and answer HTTP 405 for other methods and 404 for unknown `/api/*` paths.
3. THE backend SHALL apply the shared local-caller guard (`mcp-tools` Requirement 8) to every `/api/*` request: a `Host` that is not `127.0.0.1:<port>` or `localhost:<port>` SHALL get HTTP 421, and an `Origin` that is not the gateway origin SHALL get HTTP 403.
4. THE backend SHALL require the gateway proxy header on every `/api/*` request: it SHALL verify `X-KiroCrew-Proxy: <timestamp>:<hmac-sha256>` using `KIROCREW_PROXY_SECRET` with the scheme recorded in `.kiro/steering/kirocrew.md` (HMAC over `timestamp:method:target:sha256(body)`, ±60 second window, constant-time compare); a missing, malformed, expired or wrong signature SHALL get HTTP 403 `invalid_proxy_signature`, and an unset `KIROCREW_PROXY_SECRET` SHALL get HTTP 503 `proxy_secret_missing` (fail closed).
5. THE backend SHALL validate POST bodies with the same validators and rules as the MCP tools, and `grant-op` and `exorcise` SHALL require `confirm: true` (HTTP 400 `confirm_required` otherwise, nothing sent).
6. THE `GET /api/state` response SHALL contain the bridge state, `host`, `nick`, channels with agents, credits, last commits and up to 200 recent lines per channel, the open inbox, a `revision` number and the server time, and SHALL NOT contain the secret or the token.
7. THE `GET /api/state` response SHALL NOT exceed 256 KiB: WHEN the serialized state is larger, THE backend SHALL drop the oldest lines (across all channels, round-robin) until it fits and SHALL set `truncated: true`.
8. WHEN the request includes `?since=<revision>` and nothing changed, THE backend SHALL answer `{ changed: false, revision }`; WHEN something changed, THE backend SHALL answer the full capped state, so polling with `since` keeps working.
9. WHEN `GET /api/summary` is called, THE backend SHALL answer the latest daily summary defined in `steward-agent`, or `{ summary: null }` when none exists.
10. THE backend SHALL map bridge errors to HTTP 409 (`not_registered`), 422 (validation) and 502 (server refused), each with a JSON `{ error: { code, message } }` body.

### Requirement 6: Accessibility and look

**User Story:** As any user, I want a page that works with a keyboard and a screen reader, so that I can operate channels without a pointing device.

#### Acceptance Criteria

1. THE page SHALL be fully operable with the keyboard, with visible focus, and confirmation dialogs SHALL trap focus, close on Escape, and return focus to the trigger.
2. THE page SHALL use semantic headings, labelled form fields, and buttons with accessible names that include the agent and channel.
3. THE page SHALL NOT use color as the only way to show state, and all text (hints, status banner, labels) SHALL have a contrast ratio of at least 4.5:1 against its background: text colours come from the host variables `--card-fg` and `--muted` (never `--muted-fg`, which is black on this host), each with a fallback that keeps the same contrast, never a fixed dark colour.
4. THE page SHALL use the `@kirocrew/app-sdk` UI components and Crew theme tokens where available, and SHALL NOT bundle React, `@kirocrew/app-sdk` or `lucide-react`.
5. THE page SHALL not contain the trademarked name forbidden by `.kiro/steering/security.md`.

### Requirement 7: Build and packaging

**User Story:** As a maintainer, I want a committed bundle that Crew can serve, so that an install needs no build step or node_modules.

#### Acceptance Criteria

1. THE build SHALL produce `ui/dist/index.mjs` as an ES module with `react`, `react-dom`, `react/jsx-runtime`, `@kirocrew/app-sdk`, `@kirocrew/app-sdk/ui` and `lucide-react` as externals.
2. THE `app.json` `ui.entry` SHALL point at that file and `ui.pages[0].route` SHALL be `/apps/seance-crew`.
3. THE repository SHALL commit `ui/dist/index.mjs` and `backend/dist/server.js`.

### Requirement 8: Layout refresh and app icon

**User Story:** As an operator, I want a page I can scan in a few seconds and an app I can find in the sidebar, so that I see what needs my attention without reading sentences.

#### Acceptance Criteria

1. THE page SHALL show, under the page header, a slim status line WHEN the bridge is `registered` (status icon, the word "Connected", `<host> as <nick>`, and "updated <age> ago" from the last successful poll, refreshed every 5 seconds and kept outside the `role="status"` element so it is not announced each time), and SHALL keep the full banner with its action text for every other bridge state.
2. THE page SHALL show an overview row of six tiles (Channels, Agents ready as `ready / total`, Operators, Needs op, Total credits, Commits) computed from `GET /api/state` (the Commits tile adds up `commitCount`, every commit the backend keeps, not only the rows it sends), in a grid whose columns follow the width of its container (a container query, not the window): six in one row from 900 px up, three (3 + 3) under 900 px, two under 500 px; WHEN Needs op is above zero, THE tile SHALL use the warn tone on its border and icon.
3. THE page SHALL lay out the channels and an aside (Needs op first, then Summon, then the daily summary) as two columns that wrap into one column on narrow widths without media queries.
4. EACH channel card SHALL show the name with member and agent counts and the last activity as pills, the topic on one line with the full text as a tooltip, credits as text plus a `role="meter"` bar (omitted when the total is unknown), agents as aligned rows, at most 5 commits newest first with a relative age and, when the backend keeps more (`commitCount`), the text "Showing the newest 5 of N commits.", and the log, open by default, as a time | sender and text grid.
5. THE page SHALL use one set of primitives (panel, section header, pill, button, empty state, skeleton, icon) and design tokens for space, radius, type and colour; a tone SHALL change only borders, bars and icons, never the colour of text.
6. WHEN there are no channels, no agents, no commits, no log lines, no inbox items or no summary, THE page SHALL show an empty state with an icon, a title and, where useful, a hint; WHILE the first state is loading, THE page SHALL show placeholder blocks hidden from assistive technology and a visually hidden "Loading channels…" text.
7. EVERY interactive element SHALL show a visible focus ring (2 px accent outline, 2 px offset) on keyboard focus, and icons SHALL be decorative (`aria-hidden="true"`) next to a word or an accessible name.
8. WHEN the daily summary is from an earlier day than the server's date, THE page SHALL label it "Last summary: <date>" and SHALL show today's live total credits next to it; THE Channels heading SHALL sit inside its own panel, like Needs op; the meter SHALL clamp `aria-valuenow` to `[0, max]` and show "n/a" for a total of zero; the confirm button of a grant SHALL use the primary style, and the danger style SHALL stay for exorcise and revoke; every button's accessible name SHALL start with its visible text.
9. THE `GET /api/state` response SHALL carry `commitCount` per channel: how many commits the store keeps (up to 50) while `commits` holds the newest 5.
10. THE app SHALL show the Séance candle in the Crew sidebar: `iconPath` SHALL point at a 512×512 PNG of the candle, and `ui.pages[0]` SHALL set `iconUrl` and `iconInactiveUrl` to SVG files under `ui/` (relative to `ui/`) that contain no script, no external reference and no event handler; the inactive SVG SHALL use the same shapes in greys.
