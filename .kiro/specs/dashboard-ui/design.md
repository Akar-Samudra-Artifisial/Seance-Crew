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
- `permissions.api` lists `/api/state`, `/api/summary`, `/api/summon`, `/api/grant-op`, `/api/exorcise`, `/api/inbox/dismiss`. Adding a route requires adding it there, and a test compares the two lists.

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
- SDK components (`PageHeader`, `Card`, `CardTitle`, `StatCard`) come from `@kirocrew/app-sdk/ui`; dialogs and badges are small local components because the SDK has no documented dialog.

### Types for the SDK

`@kirocrew/app-sdk` is not on npm. The repo carries a hand-written minimal declaration (`ui/src/kirocrew-app-sdk.d.ts`) for the parts used (`useAppApi`, the four UI components). It can be replaced by `curl --fail -o ui/src/kirocrew-app-sdk.d.ts http://localhost:5476/vendor/kirocrew-app-sdk.d.ts` against a local gateway. The bundle treats the SDK as external, so the declaration is for typecheck only.

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

`permissions.api` in `app.json` equals the set of implemented `/api/*` routes.

**Validates: Requirements 5.1**

## Testing Strategy

- Backend: route tests against a stub bridge on a loopback `http.Server`: status codes, `confirm_required`, body limits, `?since=`, proxy signature (valid, bad, expired, missing secret), no secret in any response, `permissions.api` equals the implemented route list.
- UI: component tests with vitest and `react-dom/server` render for static markup, plus pure tests for the state diff, polling schedule (fake timers) and confirm flow reducer. No browser or network.
- Manual check list in tasks (run `kirocrew app dev seance-crew`, open the page, summon, grant, exorcise against a test channel).
