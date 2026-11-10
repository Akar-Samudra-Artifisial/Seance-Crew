---
inclusion: always
---
# Tech Stack & Conventions

## Stack

- **Language:** TypeScript (strict), ESM only (`"type": "module"`), Node.js >= 22.12.
- **Package manager:** pnpm only, never npm or yarn, with one exception: the dashboard page build may need `npm install --legacy-peer-deps` outside the workspace because `@kirocrew/app-sdk` is not on npm (see `kirocrew.md`).
- **Workspace:** `backend/` (the single process) and `ui/` (dashboard page). Root scripts: `build`, `typecheck`, `lint`, `test`.
- **Backend:** one Node process, bundled with esbuild into `backend/dist/server.js` and committed. **Zero runtime npm dependencies**: use Node's global `WebSocket` and `fetch`, `node:http`, `node:crypto`. Dev dependencies only.
- **UI:** bundled with esbuild into `ui/dist/index.mjs` and committed. React, ReactDOM, `@kirocrew/app-sdk` and `lucide-react` are externals provided by the host.
- **Protocol:** the Séance IRC subset is parsed with the vendored `@seance/irc-protocol` in `backend/vendor/irc-protocol/` (copied unchanged; never edit it, see its `NOTICE`).
- **Data:** state is in memory. Only `data/credits.json` and `data/summary.json` are persisted (git-ignored), plus the transient `data/bridge.lock`.
- **Paths:** resolved from `import.meta.url` (see `kirocrew.md`), never from `process.cwd()` or env.
- **No cron:** periodic work runs on timers in the backend (see `kirocrew.md`).

## Conventions

- `tsconfig.base.json` is strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`). Do not loosen it per package.
- NodeNext resolution: relative imports include the `.js` extension.
- No `any`. Prefer `readonly` types and `const`. Never mutate inputs.
- Errors say what failed and why; never swallow errors silently.
- Validate all external input at the boundary (WebSocket lines, HTTP bodies, MCP arguments, config). Input validation is hand-written; no zod.
- Pin exact versions in `package.json`. Do not add a dependency without a clear reason.

## Testing

- **vitest** for unit and integration tests; property tests with fast-check for protocol-adjacent code.
- Unit tests use an in-process fake ircd. No test touches the network, except the opt-in e2e script `scripts/e2e.mjs` behind `SEANCE_E2E=1`. The script is plain ESM JavaScript because Node 22.12 does not strip TypeScript types by default.
- UI tests run in `ui/` with vitest and `react-dom/server`.
- A bug fix starts with a failing test.

## Commands

```sh
pnpm install
pnpm build | pnpm typecheck | pnpm lint | pnpm test
pnpm e2e            # prints "skipped" unless SEANCE_E2E=1
kirocrew app dev seance-crew
```
