---
inclusion: always
---
# Kiro Crew runtime facts

Verified by hand on a live gateway (Kiro Crew 0.12.1, macOS arm64, 2026-11-10). These facts win over any conflicting statement in the public docs. Evidence lives in `spike/RUNTIME.md` (git-ignored, local only).

## Trust gate

- Every third-party app is inert until trusted. `kirocrew app enable` refuses with "third-party app execution is disabled … (agent.apps_trusted)".
- Trust one app: `kirocrew config set agent.apps_trusted '["seance-crew"]'`.
- Until trusted, no backend, MCP, cron, agent or skill runs. Only the static UI bundle is served.

## Backend process

- A plain `backend/dist/server.js` runs under the system `node`. Working directory is `~/.kiro/crew/apps/seance-crew`.
- `backend.port` is `"auto"`: ports start at 9100 and **change on restart** (9100 then 9101). Never hardcode or persist the port; bind `127.0.0.1:$PORT`.
- Environment given to the backend: `PORT`, `NODE_ENV=production`, `KIROCREW_APP_NAME`, `KIROCREW_HOME`, `KIROCREW_GATEWAY_ORIGIN` (`http://127.0.0.1:5476`), `KIROCREW_GATEWAY_ORIGIN_PROOF`, `KIROCREW_PROXY_SECRET`, `KIROCREW_SANDBOX_ACTIVE=1`, `KIROCREW_SANDBOX_LEVEL=standard`, `KIROCREW_SPAWNED`, `KIROCREW_SPAWN_INSTANCE`.
- **No app config values are in the environment.** Never look for the Séance secret in env.
- Outbound network from the sandboxed backend is allowed: `fetch` to HTTPS and Node's global `WebSocket` to `wss://` both work. The global `WebSocket` sends no Origin header, which the Séance server accepts.

## Reading config

1. Read `<appRoot>/.app_secret` (mode 600; see "App paths").
2. `POST {KIROCREW_GATEWAY_ORIGIN}/api/apps/seance-crew/token` with header `X-App-Secret: <contents>` → `{"token": "…"}`.
3. `GET {KIROCREW_GATEWAY_ORIGIN}/api/apps/seance-crew/config?token=<token>` → config JSON (`host`, `nick`, `secret`).

`Authorization: Bearer`, `X-Session-Token` and cookies are rejected with 403. Config is stored in `<appRoot>/data/config.json` (mode 600, plaintext), so `data/` and `.app_secret` are never committed.

## App paths

The gateway starts the backend from `~/.kiro/crew/apps/seance-crew`, but do not rely on the working directory. Resolve every app file from `import.meta.url`: walk up from the bundle (`backend/dist/server.js`) to the directory that contains `app.json`; `data/` and `.app_secret` live there. Never use `process.cwd()` or environment variables to find app files.

## MCP

- `mcpServers.seance.url` is `http://127.0.0.1:9100/mcp` in `app.json`. The gateway registers it as `seance-crew:seance` and **rewrites the port** to the live backend port (`bridges_mcp.py:120-150`, applied at `:1047-1049`).
- **Agent tool reference: `@seance-crew:seance`** (not `@seance`). Verified in the installed source (Kiro Crew 0.12.1): the server is registered as `{app_name}:{server_name}` (`bridges_mcp.py:1022`), and `@<server>` refs are resolved against the agent's `mcpServers` plus the global `mcp.json`; an unresolved name is dropped silently (`bridges_agents.py:573`, `_unresolvable_tool_refs`). `agents/seance-steward.json` uses this form and a test pins it. Live gateway: the owner's live run of the full flow passed; listing the eight tools from the steward on a live gateway was not repeated by the agent that wrote this note.
- **Approval gate and `allowedTools`.** Without it every MCP call, even a read, needs host approval, and an unattended or `-m` session answers "Denied automatically: … needs approval, and this invocation cannot ask". `allowedTools` in an app agent JSON is the auto-approve list (`kiro_crew/apps/bridges_agents.py:271,318`; an entry `@server/tool` becomes an exact match, `kiro_crew/acp/kas_permissions.py:641`). `agents/seance-steward.json` lists exactly `list_channels`, `read`, `whois` and `credits` as `@seance-crew:seance/<tool>`. Never list `say`, `summon`, `grant_op`, `exorcise` or the bare `@seance-crew:seance`: those keep the host prompt (see `security.md`). `backend/test/manifest.test.ts` pins the list.
- Use HTTP MCP only. A stdio MCP cannot find the backend: no `PORT`, no `KIROCREW_HOME`, no `secret://` resolution, and a cwd chosen by kiro-cli.
- **The gateway sends no header and no secret on MCP calls.** `bridges_mcp.py` copies the manifest entry (`cfg = dict(server_config)`, `:1022`) and only changes the port. A static header in `app.json` would be public, so it is no authentication. `/mcp` is therefore protected by a Host check, an Origin check and `confirm: true` on destructive tools, not by a credential (see `security.md`, "accepted risk").

## Dashboard proxy and the signing scheme

Read from the installed source (`~/.kiro/crew-venv/lib/python3.12/site-packages/kiro_crew/apps/`, Kiro Crew 0.12.1). Line numbers are for that version.

- The UI calls the backend through `useAppApi()`, which adds **no prefix**: the SDK only checks the path against `permissions.api` (a prefix match on the pathname, so an entry `X` allows `X` and `X/...`; a query string such as `?since=3` passes) and then passes it to `fetch` as is. A path not in the list throws an `AppApiError` synchronously, before any request. `get("/api/state")` therefore hits the gateway's own `/api/state` and gets 404. The app backend is reached only at the reverse-proxy path `/apps/seance-crew/api/<route>` (`routes_proxy.py`), so the UI must call the full path and `permissions.api` must list the full paths (`/apps/seance-crew/api/state`, and so on, no wildcard). Without a signed-in dashboard session the proxy answers 403 "Sign in required".
- The gateway forwards to `http://127.0.0.1:<port>` (`routes_proxy.py:187`), so a proxied request has `Host: 127.0.0.1:<port>`. The forwarded target is `/api/<path>` plus the raw query, with the gateway's own `token` query parameter removed first (`routes_proxy.py:157`, `:_PROXY_STRIP_QUERY_PARAMS`).
- Signing scheme v1 (`routes_proxy.py:357-361`, verifier `proxy_auth.py:102-135`):
  - header `X-KiroCrew-Proxy: <ts>:<sig>`, `ts` = integer Unix seconds;
  - `msg = "<ts>:<METHOD>:<target>:<sha256hex(body)>"` where `target` is the raw request-target exactly as received (`/api/state?since=3`, percent-encoding unchanged) and an empty body hashes to `e3b0c442…b855`;
  - `sig = hex(HMAC-SHA256(key = secret, msg))`, lowercase hex;
  - verify: `ts` must be all digits, `|now - ts| ≤ 60` seconds, compare bytes with a constant-time compare, fail closed on anything malformed.
- The key is the contents of `<appRoot>/.app_secret` (`routes_proxy.py:77-90`). The gateway injects the same value into the backend as `KIROCREW_PROXY_SECRET` (`backend.py:902`). The backend uses `KIROCREW_PROXY_SECRET`; when it is unset, `/api/*` fails closed (503) instead of skipping verification.
- v2 (optional, replay-proof) adds `X-KiroCrew-Proxy-Nonce` and `X-KiroCrew-Proxy-V2` (`proxy_auth.py:225-264`). This app verifies v1 only.
- The gateway strips caller-sent copies of `x-kirocrew-proxy`, `-v2`, `-nonce`, `-principal`, `cookie`, `authorization`, `x-session-token` and similar before adding its own (`routes_proxy.py:130-150`). A browser `Origin` header is forwarded unchanged.
- Event streams (`text/event-stream`) are supported by the proxy (`routes_proxy.py:440`); this app still polls. Ordinary proxied requests time out after 30 s.
- The header `X-Crew-Proxy` in the public Apps page is stale and wrong.

## UI build

- Commit `ui/dist/index.mjs`; installs exclude `node_modules`.
- `@kirocrew/app-sdk` is not on npm. A scaffold UI installs only with `npm install --legacy-peer-deps`. Keep SDK imports external in the bundle.
- `setup.onUpdate` never runs. Do not rely on it. Put install or build steps in `onEnable` or an idempotent `onInstall` if ever needed.

## Cron: do not use it

A cron `command` runs from the gateway's working directory with the gateway's cleaned environment (`cron_script.py`, `run_command_sandboxed`), not from the app directory. A relative path such as `backend/dist/server.js` is not found, and a second `node` process would open a second IRC connection, which breaks the one-connection rule. This app declares **no** `crons` and no `cron` permission. Periodic work (the daily credit summary) runs on a timer inside the backend process.

## Install and dev loop

```sh
kirocrew app install /absolute/path/to/seance-crew
kirocrew config set agent.apps_trusted '["seance-crew"]'
kirocrew app enable seance-crew
kirocrew app dev seance-crew
```

Local-path installs do not run `setup.onInstall`; build before installing.
