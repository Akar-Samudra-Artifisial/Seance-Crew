# Séance Crew

A [Kiro Crew](https://kiro.dev/docs/crew/) app that makes Kiro Crew the foreman of [Séance](https://github.com/Akar-Samudra-Artifisial/Seance) coding channels.

From Crew chat or a dashboard page you can list channels, summon an agent, grant or revoke op, read the log, watch commits and credits live, and exorcise the agent when you are done.

> Status: scaffold and specs only. The behavior is described in `.kiro/specs/` and is not implemented yet.

Judge-facing documents (written last, see the `demo-writeup` spec): `docs/DEMO.md` (a 60 to 90 second scenario) and `docs/WRITEUP.md` (features, architecture, security, how Kiro built it).

## How it works

One Node backend process holds the single WebSocket to your Séance server. It serves:

- an MCP server at `/mcp` (Streamable HTTP) with the tools `list_channels`, `read`, `say`, `summon`, `grant_op`, `exorcise`, `whois`, `credits`;
- a small JSON API under `/api/*` for the dashboard page;
- `/health` for the gateway health check (answers only `{"ok":true}`).

The `seance-steward` Crew agent uses the MCP tools and asks before it grants op or exorcises an agent. A daily credit summary runs on a timer inside the backend: no cron, no model call, no second connection.

## Install

Requires Kiro Crew and Node >= 22.12.

```sh
kirocrew app install /absolute/path/to/seance-crew
```

## Trust

Third-party apps are inert until trusted. Trust this one:

```sh
kirocrew config set agent.apps_trusted '["seance-crew"]'
```

## Enable

```sh
kirocrew app enable seance-crew
```

## Configure

Open the app settings in the Crew dashboard and set:

| Key | Default | Meaning |
| --- | --- | --- |
| `host` | `35-172-120-185.sslip.io` | Séance server host (connects to `wss://<host>/ws`) |
| `nick` | `crew` | Account name; must equal the nick |
| `secret` | none | Account secret. Stored in app config only, masked, never logged |

Your account must be listed in `SEANCE_INVITERS` on the server to summon agents. To receive needs-op notices for a channel, the `crew` nick must be `+o` there.

## Develop

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test
pnpm build
pnpm e2e            # prints "skipped" unless SEANCE_E2E=1
kirocrew app dev seance-crew
```

The opt-in end-to-end check talks to a real Séance server and needs two accounts, because the server allows one session per account:

```sh
SEANCE_E2E=1 \
SEANCE_E2E_HOST=<host> SEANCE_E2E_NICK=<nick> SEANCE_E2E_SECRET=<secret> \
SEANCE_E2E_ANCHOR_NICK=<other-nick> SEANCE_E2E_ANCHOR_SECRET=<other-secret> \
pnpm e2e
```

Phase 1 (raw WebSocket) uses the first account. Phase 2 runs the built `backend/dist/server.js` as the first account while the second account (the anchor) sits in a fresh `#crew<n>` channel, so the bundle's LIST finds a channel. Without the two `ANCHOR` variables phase 2 is skipped with a message; the anchor nick must differ from `SEANCE_E2E_NICK`. Run `pnpm build` first. `SEANCE_E2E_ONLY=ws` or `bundle` runs one phase. Secrets are never printed.

- `backend/dist/server.js` and `ui/dist/index.mjs` are build artifacts that are committed, because Crew installs exclude `node_modules`.
- `@kirocrew/app-sdk` is not on npm. It stays a peer dependency of the UI, and installs outside pnpm need `npm install --legacy-peer-deps`.
- Specs: `.kiro/specs/{irc-bridge,mcp-tools,dashboard-ui,steward-agent,demo-writeup}/`.

## Security

- The Séance secret lives only in the Kiro Crew app config. It is never written to a file in the repo, never logged, and `PASS` lines are redacted.
- All channel text is untrusted data. Tool results wrap it in `<untrusted>` markers and the agent never obeys it.
- `grant_op` and `exorcise` (and their dashboard actions) refuse unless `confirm: true` is sent after the human agrees.
- Every outbound line is validated (512 bytes, no CR, LF or NUL, valid nick and channel). The app keeps exactly one connection to the server.
- `/api/*` accepts only requests signed by the gateway (`X-KiroCrew-Proxy`) with a loopback `Host` and the gateway `Origin`. `/mcp` applies the same Host and Origin checks.
- Accepted risk: any local process of the same user can call /mcp; destructive tools still need confirm:true. The gateway sends no credential on MCP calls, so there is nothing to verify.
- `/health` is unauthenticated and returns only `{"ok":true}`.

## Screenshots (placeholders)

To be added under `docs/img/` (see `demo-writeup` task 6):

- `dashboard-overview.png`: channel cards with agents, modes and credits
- `needs-op-inbox.png`: an open needs-op item
- `grant-op-confirm.png`: the Grant op confirmation dialog
- `commit-and-credits.png`: a `coder committed <sha>` row with live credits
- `crew-chat-summon.png`: Crew chat summoning `coder` into `#crew-demo`
- `exorcise-confirm.png`: the exorcise confirmation and the `worktree reset` notice

## License

MIT. The `backend/vendor/irc-protocol/` sources come from the Séance repository, also MIT (see its `NOTICE`).
