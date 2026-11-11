# Implementation Plan: dashboard-ui

## Overview

Depends on `irc-bridge` (tasks 1 to 13) and `mcp-tools` (tasks 2 and 4: guard and validators). After each task `pnpm typecheck && pnpm test` must be green. Unit tests use the in-process fake ircd or a stub bridge; no network. Tasks run in the order listed. Verify each task with `pnpm typecheck && pnpm test && pnpm lint` and by running the tests named in the task before ticking it.

## Tasks

- [x] 1. Verify the proxy signing scheme before any code depends on it
  - Read `~/.kiro/crew-venv/lib/python3.12/site-packages/kiro_crew/apps/routes_proxy.py` (signing around lines 346-361; secret lookup at lines 77-90; stripped headers and `token` query param at lines 130-160) and `proxy_auth.py` (verifier at lines 102-135).
  - Confirm that `.kiro/steering/kirocrew.md` ("Dashboard proxy and the signing scheme") matches the installed source exactly: header name, `<ts>:<sig>` format, message `ts:METHOD:target:sha256hex(body)`, key `KIROCREW_PROXY_SECRET` (same value as `.app_secret`), ±60 s, raw request-target. Fix the steering file if the installed version differs.
  - Produce fixed test vectors with the gateway's own Python code and save them in `backend/test/fixtures/proxy-vectors.json`: `~/.kiro/crew-venv/bin/python -c "..."` computing `hmac.new(secret, msg, sha256)` for four cases (GET with query, POST with body, empty body, percent-encoded query) using a dummy secret that is not a real credential.
  - Manual check plus a committed fixture; used by task 3.
  - _Requirements: 5.4_

- [x] 2. Store revision and state snapshot
  - Add `revision` to the store and `buildState(store, bridge)` producing the `State` shape (last 5 commits, newest 200 lines per channel, `truncated`, no secret) with the 256 KiB cap.
  - Tests: revision increments on each event; snapshot shape; credits `null` when unknown; serialized state never contains the secret; **cap test**: 10 channels with 200 long lines each serialize to ≤ 256 KiB, `truncated` is `true`, the newest lines survive, and a small state is not truncated.
  - _Requirements: 5.6, 5.7, 5.8_

- [x] 3. Proxy signature verification
  - `src/api/proxyAuth.ts`: parse `X-KiroCrew-Proxy`, HMAC-SHA256 over `ts:METHOD:target:sha256hex(body)`, ±60 s, `timingSafeEqual` over bytes, 503 when the secret is unset.
  - Tests using the vectors from task 1: valid, wrong secret, tampered body, tampered path, tampered query, expired, future, malformed header, non-digit timestamp, non-ASCII signature (no throw), empty body hash `e3b0c442…`, unset secret → 503.
  - _Requirements: 5.4_

- [x] 4. API router and read routes
  - `src/api/routes.ts` registered in `src/http.ts`: shared guard (Host 421, Origin 403), then proxy auth (403), JSON helpers, `Cache-Control: no-store`, 404/405, body limit 16 KiB, content-type check, `GET /api/state` with `?since=`, `GET /api/summary` through an injected `SummaryProvider`.
  - Tests with a real loopback `http.Server` on port 0: wrong Host → 421; foreign Origin → 403; missing proxy header → 403; bad proxy header → 403; valid signed request → 200; unset secret → 503; `changed: false` and full state after a change; `/api/summary` returns `{ summary: null }` and a stub summary; error body shape; oversize body; wrong content type; `/health` still needs no credentials.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.8, 5.9, 5.10_

- [x] 5. Action routes
  - `POST /api/summon`, `/api/grant-op`, `/api/exorcise`, `/api/inbox/dismiss` using the shared validators and the same bridge operations as the MCP tools; `inboxId` resolves the item on success; error mapping to 409/422/502.
  - Tests with fake ircd (signed requests): exact IRC lines; `confirm_required` sends nothing; not registered → 409; refused invite → 502; dismiss unknown id → 404.
  - _Requirements: 5.5, 5.10, 3.3_

- [x] 6. `permissions.api` consistency test
  - Test reads `app.json` and the route table and asserts both lists match exactly (six paths); asserts `app.json` has no `crons` key and no `cron` key under `permissions`.
  - _Requirements: 5.1_

- [x] 7. SDK type declaration and build wiring
  - `ui/src/kirocrew-app-sdk.d.ts` (minimal), `ui/src/App.tsx` stub that renders the page header, `pnpm build` produces `ui/dist/index.mjs`.
  - Tests: build output exists, is ESM, does not contain React or SDK code (externals only); `app.json` `ui.entry` and route match.
  - _Requirements: 6.4, 7.1, 7.2, 7.3_

- [x] 8. State hook, summary and polling
  - `ui/src/useSeanceState.ts`: 3 s poll, 10 s after failure, pause when hidden, immediate refresh, `?since=`, stale notice data, diff for announcements; summary fetched on load and every 60 s.
  - Tests with fake timers: schedule, backoff, pause/resume, diff finds new commit shas and inbox ids, summary refresh cadence.
  - _Requirements: 2.3, 2.4, 2.5, 2.6_

- [x] 9. Status banner, channel cards, log panel and summary card
  - `StatusBanner`, `ChannelCard`, `AgentRow`, `LogPanel`, `SummaryCard`, commits and credits display, empty states, plain-text rendering.
  - Tests (server render): each bridge state message, modes shown as text, credits `n/a`, a channel topic and a log line containing HTML are escaped, log panel labelled untrusted, "No summary yet" and a rendered summary.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.6, 6.3_

- [x] 10. Confirm dialog
  - `ConfirmDialog` with focus trap, Escape, focus return, and a reducer for the confirm flow.
  - Tests: reducer transitions; cancel sends nothing; dialog markup has `role="dialog"`, `aria-modal`, labelled title.
  - _Requirements: 3.2, 4.3, 4.4, 6.1_

- [x] 11. Inbox and actions
  - `Inbox`, `SummonForm`, mode toggle, Exorcise button, error display, pending states, live region.
  - Tests: Grant op opens confirm and posts `confirm: true` only on confirm; Dismiss posts id; empty inbox text; summon `ready: false` message; errors keep form values; mode change goes through confirm; button accessible names include agent and channel.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.5, 4.6, 2.3, 6.2_

- [x] 12. Packaging and manual check
  - Run `pnpm build`; commit `ui/dist/index.mjs` and `backend/dist/server.js`; run `pnpm lint` (forbidden word check covers the UI).
  - Manual: `kirocrew app dev seance-crew`, open `/apps/seance-crew`, summon in a fresh `#crew<n>` channel, grant `+v` then `+o`, exorcise, confirm credits update. Record results in the PR description (not in code).
  - _Requirements: 6.5, 7.1, 7.2, 7.3, 2.3_

- [x] 13. Primitives, layout refresh and tests
  - `ui/src/ui.tsx` (Panel, SectionHeader, Pill, Button, EmptyState, Skeleton, StatTile, Meter), `ui/src/Icon.tsx`, tokens and the scoped focus-ring rule in `ui/src/styles.ts`; `StatusBanner` slim line, `StatTiles`, two wrapping columns in `Dashboard`, denser `ChannelCard` (pills, meter, agent grid, commits with the "newest 5 of N" note, log grid), restyled `Inbox`, `SummonForm`, `SummaryCard`; every `buttonStyle()` caller moved to `Button`.
  - Tests: tile values from a fixture state; meter aria values and its absence when the total is null; "active … ago"; empty states; skeletons while the state is null; every icon renders a decorative `svg`; no icon-only button without a name; hardening of the log grid, commit rows and topic `title`; new contrast pairs; bundle size and externals unchanged.
  - Manual: screenshots at about 1400 px and 800 px wide from `kirocrew app dev seance-crew`; retake `docs/img/*.png`.
  - Review fixes: `commitCount` in `/api/state` (backend test), live "updated … ago" outside the live region, meter clamp, label-in-name, tokens, contrast floor 4.7, summary date label with the live total, Channels panel, 3 + 3 tiles, primary grant confirm, log open by default.
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 6.1, 6.2, 6.3_

- [x] 14. App icon assets and manifest test
  - `ui/icon.svg`, `ui/icon-inactive.svg`, `assets/icon.png` (512×512 from the SVG via `sips`), `app.json` page `iconUrl` and `iconInactiveUrl`.
  - Tests in `backend/test/manifest.test.ts`: `iconPath` is a PNG (magic bytes, IHDR 512×512); both SVGs exist under `ui/`, start with `<svg`, and contain no `<script`, `href=` or `on…=`.
  - Manual: the sidebar shows the candle, greyed when another page is active.
  - _Requirements: 8.10_

## Notes

- Depends on `irc-bridge` tasks 1 to 13 and on `mcp-tools` tasks 2 (guard) and 4 (validators). `GET /api/summary` uses the `SummaryProvider` that `steward-agent` task 6 wires in; task 4 uses a stub.
- Never skip verification of `X-KiroCrew-Proxy`, never add a route without listing it in `permissions.api`, and never render channel text as HTML.
- Task 1 and task 12 contain manual checks (source reading, `kirocrew app dev seance-crew`); record their results in the PR description.
- Verify each task with `pnpm typecheck && pnpm test && pnpm lint`. UI tests run in `ui/` with vitest and `react-dom/server`.

## Task Dependency Graph

```json
{
  "waves": [
    {
      "id": 0,
      "tasks": [
        "1",
        "2",
        "7"
      ]
    },
    {
      "id": 1,
      "tasks": [
        "3",
        "8",
        "10"
      ]
    },
    {
      "id": 2,
      "tasks": [
        "4",
        "9"
      ]
    },
    {
      "id": 3,
      "tasks": [
        "5",
        "11"
      ]
    },
    {
      "id": 4,
      "tasks": [
        "6"
      ]
    },
    {
      "id": 5,
      "tasks": [
        "12"
      ]
    },
    {
      "id": 6,
      "tasks": [
        "13",
        "14"
      ]
    }
  ]
}
```
