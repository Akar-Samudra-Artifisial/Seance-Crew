# Design Document

## Overview

A single React page (`ui/src/App.tsx`) bundled by esbuild (`scripts/build.mjs ui`) into `ui/dist/index.mjs`. State comes from polling `GET /api/state`. Actions are `POST`s through `useAppApi()`. The backend side is a handful of routes in `backend/src/api/` that reuse the same validators and bridge operations as the MCP tools (`mcp-tools`), so both surfaces share one set of safety rules.

```
 browser ─ useAppApi() ─▶ Crew dashboard proxy ─ X-KiroCrew-Proxy ─▶ backend /api/*
                          (/apps/seance-crew/api/*, needs signed-in session)
```

## Architecture

The page is a static bundle served by Kiro Crew. It reaches the backend only through `useAppApi()` and the gateway proxy, and the backend reads the `irc-bridge` store.

### Build

`node scripts/build.mjs ui` runs esbuild: entry `ui/src/App.tsx`, `format: esm`, `jsx: automatic`, externals as in `app.json`. `@types/react` is a dev dependency for typecheck; React itself is provided by the host. Output `ui/dist/index.mjs` is committed. If an install of the scaffold template is needed, use `npm install --legacy-peer-deps`.

## Components and Interfaces

### Backend API

| Route | Method | Body | Response |
| --- | --- | --- | --- |
| `/api/state` | GET (`?since=<rev>`) | none | `State` or `{ changed: false, revision }` |
| `/api/summary` | GET | none | `{ summary: Summary \| null }` (see `steward-agent`) |
| `/api/summon` | POST | `{ channel, agent? }` | `{ ready, waitedSec? }` |
| `/api/grant-op` | POST | `{ channel, agent, mode, confirm, inboxId? }` | `{ ok: true }` |
| `/api/exorcise` | POST | `{ channel, agent, reason?, confirm }` | `{ ok: true, closed: boolean }` |
| `/api/inbox/dismiss` | POST | `{ id }` | `{ ok: true }` |

```ts
interface State {
  revision: number; serverTime: number;
  bridge: { state: BridgeState; host: string; nick: string; lastError?: string };
  channels: Array<{
    name: string; topic: string; count: number;
    credits: { used: number | null; total: number | null };
    agents: Array<{ nick: string; modes: string; model: string; ready: boolean }>;
    commitCount: number; // every commit the store keeps (up to 50); `commits` below holds only the newest 5
    commits: Array<{ agent: string; sha: string; files: number; ts: number }>; // last 5
    lines: Array<{ seq: number; ts: number; from: string; kind: string; text: string }>; // newest 200, untrusted
  }>;
  inbox: Array<{ id: string; channel: string; agent: string; action: string; ts: number }>;
  totalCredits: number | null;
  truncated: boolean; // true when lines were dropped to fit 256 KiB
}
```

- `revision` increments on every store change (events from `irc-bridge`), which makes `?since=` cheap.
- Routes live in `src/api/routes.ts`. Every `/api/*` request first passes the shared guard (`src/http/guard.ts`, see `mcp-tools`): Host → 421, Origin → 403. Then `src/api/proxyAuth.ts` verifies `X-KiroCrew-Proxy` with `node:crypto` (`createHmac`, `timingSafeEqual`, sha256 of the raw body), using the scheme recorded in `.kiro/steering/kirocrew.md`: `msg = "<ts>:<METHOD>:<req.url>:<sha256hex(body)>"`, key `KIROCREW_PROXY_SECRET`, ±60 s. `req.url` is the raw request-target, which is what the gateway signed. A bad or missing header is 403 `invalid_proxy_signature`. An unset secret is 503 `proxy_secret_missing`; there is no "skip verification" mode, so local `kirocrew app dev` works because the gateway still signs.
- `lines` come from the irc-bridge ring buffers (newest 200 per channel). `buildState` serializes, and while the byte length exceeds 256 KiB it removes the oldest line from the channel that currently holds the most lines, then sets `truncated: true`. `?since=` still returns the full capped state when the revision changed.
- `/api/summary` returns `{ summary }` from the in-backend summary service (`steward-agent`).
- Errors: `{ error: { code, message } }`; 400 validation/`confirm_required`, 403 `bad_origin`/`invalid_proxy_signature`, 404, 405, 409 `not_registered`, 413, 421 `bad_host`, 422, 502, 503 `proxy_secret_missing`.
- `useAppApi()` does not proxy automatically and adds no prefix: it checks the path against `permissions.api` (the pathname is matched, so `?since=` passes) and calls `fetch` with it as is. The page therefore requests the full proxy path `/apps/seance-crew/api/<route>`, built from one constant (`API_BASE` in `ui/src/api.ts`), and `permissions.api` lists the six full paths: `/apps/seance-crew/api/state`, `/apps/seance-crew/api/summary`, `/apps/seance-crew/api/summon`, `/apps/seance-crew/api/grant-op`, `/apps/seance-crew/api/exorcise`, `/apps/seance-crew/api/inbox/dismiss` (explicit list, no wildcard). The backend itself still sees `/api/<route>`. Adding a route requires adding it there, and tests compare the lists.

### UI structure

```
App
 ├─ StatusBanner            bridge state, stale-connection notice
 ├─ LiveRegion              aria-live="polite" announcements
 ├─ SummaryCard             latest daily summary (GET /api/summary, every 60 s)
 ├─ SummonForm              channel + agent, pending/ready states
 ├─ Inbox                   InboxItem[]  (Grant op, Dismiss)
 ├─ ChannelCard[]           topic, credits, AgentRow[], Commits
 │    ├─ AgentRow           modes, model, ready, mode toggle, Exorcise
 │    └─ LogPanel           newest 200 lines, plain text, labelled untrusted
 └─ ConfirmDialog           shared, focus trap, Escape, returns focus
```

- Data hook `useSeanceState()`: `setTimeout` loop, interval 3 s (10 s after failure), paused on `document.visibilityState === "hidden"`, immediate `refresh()` after actions. Passes the last `revision` as `?since=`.
- Diffing for announcements: compare previous and next state for new commit shas and new inbox ids.
- `useAppApi()` is the only network access. The page never builds URLs to the backend port.
- Text from the server is rendered as React text nodes only; there is no `dangerouslySetInnerHTML`.
- Confirmation copy examples: "Grant +o to coder in #fix-bug? +o lets the agent edit files and run commands in the channel worktree." and "Exorcise coder from #fix-bug? The agent stops and uncommitted work in the worktree is reverted."
- `PageHeader` comes from `@kirocrew/app-sdk/ui`. Panels, stat tiles, pills, buttons and the dialog are small local primitives (`ui/src/ui.tsx`, see "Layout refresh"): the SDK `Card` adds its own margin and animation and `StatCard` does not fit the overview grid, and the SDK has no documented dialog.

### Types for the SDK

`@kirocrew/app-sdk` is not on npm. The repo carries a hand-written minimal declaration (`ui/src/kirocrew-app-sdk.d.ts`) for the parts used (`useAppApi`, the four UI components). It can be replaced by `curl --fail -o ui/src/kirocrew-app-sdk.d.ts http://localhost:5476/vendor/kirocrew-app-sdk.d.ts` against a local gateway. The bundle treats the SDK as external, so the declaration is for typecheck only.

### Layout refresh (Requirement 8)

```
PageHeader "Séance Crew"
StatusBanner      slim line when registered (icon · Connected · host as nick · updated 5 s ago), full banner otherwise
StatTiles         <section aria-label="Overview"> is a size container (container-type: inline-size); one grid of six
                  tiles inside it, columns from TILES_CSS: 6 from 900 px, 3 under 900 px, 2 under 500 px (container width)
columns           flex, wrap, gap 1rem
 ├─ main  (flex 999 1 34rem)   Panel > SectionHeader "Channels" (h2#channels-heading, tabIndex -1) + ChannelCard[]
 └─ aside (flex 1 1 20rem)     Inbox (Needs op) → SummonForm → SummaryCard
ConfirmDialog     portal to document.body (unchanged behaviour)
```

- No media queries are possible with inline styles, so the layout is intrinsic: the large `flex-grow` keeps the channels wide, and the aside wraps below it once the row cannot hold `34rem + 20rem`.
- `ChannelCard`: header row (`#` icon, `h3` with the focus id, pills for members, agents and "active N ago" = `serverTime - max(lines.ts)`), topic in one ellipsed line with `title`, a credits row with a `Meter` (`role="meter"`, `aria-valuenow/min/max/valuetext`), agent rows as a 4-column grid (`minmax(8rem,1fr) auto auto 1fr`: nick · mode and ready pills · model · controls), commits (the 5 newest; the state carries only 5 rows, so when `commitCount` is higher the card says "Showing the newest 5 of N commits." instead of offering a toggle with nothing more to show; keys are sha + time + index), and the `<details open>` log rendered as a time | sender + text grid; join/part/mode lines muted italic.
- `overviewStats(state)` is a pure function (counts agents per channel and adds up `commitCount`), so tiles are tested without a DOM.
- Ages move: `ui/src/useAging.ts` holds `useAgingNow` (server-anchored, Inbox, every 30 s) and `useNow` (browser clock, status line, every 5 s). The "updated … ago" text is outside the `role="status"` element, so it is not announced on each tick.
- `Meter` clamps `aria-valuenow` to `[0, max]`; a total of zero gives an empty bar, `aria-valuemax="0"` and value text "n/a".
- Buttons: the accessible name starts with the visible text (label in name), for example "Grant op in #a to coder" for the visible "Grant op in #a".
- `SummaryCard` compares the summary date with the server's UTC date; an older one reads "Last summary: <date>" with "Total credits now" (live, from the state) above "Total credits in that summary".
- `ConfirmDialog` takes `destructive`: the grant confirm uses the primary style; exorcise and revoke keep the danger style.
- Files: `ui/src/ui.tsx` (Panel, SectionHeader, Pill, Button, EmptyState, Skeleton, StatTile, Meter, SrOnly), `ui/src/Icon.tsx` (17 lucide paths, ISC, inline SVG, `aria-hidden`), `ui/src/StatTiles.tsx`; the text glyphs (◆ ◇ ○ ✔ ◌ ⚠) are replaced by icons, the words stay.

#### Tokens (`ui/src/styles.ts`)

| Kind | Values |
| --- | --- |
| Space | 0.25 / 0.5 / 0.75 / 1 / 1.5 / 2 rem |
| Radius | 0.375 rem controls, 0.5 rem buttons, 0.75 rem panels, 999px pills |
| Type | 0.75 rem labels and timestamps, 0.875 rem body small and buttons, 1 rem card titles, 1.5 rem stat values; weights 400/500/600; numbers `tabular-nums`; one mono stack |
| Colour | text only `--card-fg` or `--muted` (never `--muted-fg`); accent, warn (#f59e0b) and danger only on borders, bars, icons and filled buttons (black text on accent and danger) |
| Buttons | primary, secondary, danger, ghost; md `0.375rem 0.875rem`, sm `0.25rem 0.625rem`; `aria-disabled` instead of `disabled` |

Every text/background pair is listed in `ui/test/contrast.test.ts` (≥ 4.5:1 with the host values). `--muted` on `--bg-hover` is only 4.52:1, so no text uses it: muted text sits on the page background or a panel (5.4:1 and above, and the test requires 4.7:1 for every muted pair), and everything on a pill, button or banner surface is `--card-fg`.

Focus ring: inline styles cannot express `:focus-visible`, so the page root (`data-seance`) renders one `<style>` element with a single rule, `[data-seance] :is(button,a,input,select,textarea,summary,[tabindex]):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`. The dialog overlay carries the same attribute. It is not a CSS file and not a CSS-in-JS library. The focus targets (`channel-…` heading, `agent-…` row, `channels-heading`) keep their ids.

#### App icon resolution (verified in the gateway source)

The host sidebar picks, in order: the app `iconPath` (served at `/apps/seance-crew/art/assets/icon.png`), else `ui.pages[0].iconUrl` (served at `/apps/seance-crew/ui/<path>`), else a generic glyph; the lucide `icon` name is ignored for non-builtin apps. `iconInactiveUrl` (relative to `ui/`) is shown when the row is not active. So:

- `assets/icon.png`: 512×512 RGBA candle with a transparent background, rasterised from `ui/icon.svg` with `sips` (the sidebar draws it at 20 px, so no box around it).
- `ui/icon.svg`: the 16×16 Séance candle without its full-size background rect, `shape-rendering="crispEdges"`.
- `ui/icon-inactive.svg`: the same shapes in greys (#909098, #A1A1AA, #71717A, #52525B, #D4D4D8).
- `app.json` keeps `"icon": "Ghost"` as a harmless fallback and adds `"iconUrl": "icon.svg"` and `"iconInactiveUrl": "icon-inactive.svg"`.

## Data Models

No persistent data; the page renders `/api/state` and `/api/summary`. The `State` type is defined with the API under Components and Interfaces.

## Error Handling

Backend errors use the `{ error: { code, message } }` shape listed under the API. The page keeps its last data on a failed poll, shows a stale-connection notice, backs off to a 10 second interval, and shows an action error next to the action while keeping the form values.

## Correctness Properties

### Property 1: Destructive routes need confirmation

A POST to `/api/grant-op` or `/api/exorcise` without `confirm: true` sends nothing to the server.

**Validates: Requirements 5.5**

### Property 2: State response is bounded and clean

The serialized `/api/state` response never exceeds 256 KiB and never contains the secret or token.

**Validates: Requirements 5.6, 5.7**

### Property 3: No destructive call without user confirmation

The page makes no destructive call unless the user confirmed in the dialog.

**Validates: Requirements 3.2, 4.4**

### Property 4: Permissions match the routes

`permissions.api` in `app.json` equals the set of implemented `/api/*` routes, each with the `/apps/seance-crew` proxy prefix.

**Validates: Requirements 5.1**

## Testing Strategy

- Backend: route tests against a stub bridge on a loopback `http.Server`: status codes, `confirm_required`, body limits, `?since=`, proxy signature (valid, bad, expired, missing secret), no secret in any response, `permissions.api` equals the implemented route list.
- UI: component tests with vitest and `react-dom/server` render for static markup, plus pure tests for the state diff, polling schedule (fake timers) and confirm flow reducer. No browser or network.
- Manual check list in tasks (run `kirocrew app dev seance-crew`, open the page, summon, grant, exorcise against a test channel).
