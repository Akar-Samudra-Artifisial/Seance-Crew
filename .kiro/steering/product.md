---
inclusion: always
---
# Product: Séance Crew

Séance Crew turns Kiro Crew into the foreman of Séance coding channels: from Crew chat or a dashboard you list channels, summon an agent, grant or revoke op, read the log, watch commits and credits live, and exorcise the agent when done.

It is a Kiro Crew app, submitted for the Kiroween 2026 bonus "Best Kiro Crew App". Séance itself lives in a separate repository (https://github.com/Akar-Samudra-Artifisial/Seance); this app is a client of a running Séance server.

## Users

- A developer who runs Séance and already uses Kiro Crew, and wants to steer coding agents from Crew chat without opening a separate IRC client.
- The `seance-steward` Crew agent, which uses the MCP tools on the developer's behalf and asks before risky actions.

## Goals

- One connection, one process: the backend holds the only WebSocket to the server and exposes it as MCP tools and a dashboard API.
- Make agent permissions and activity visible: modes, commits, credits, and a needs-op inbox.
- Safe by default: op grants and exorcisms need explicit confirmation.

## Non-goals

- No multi-server support: exactly one Séance host per install.
- No IRC client UI: no raw command box, no full chat client, no nick list management beyond agents.
- No agent runner: agents run on the Séance server, not here.

## Brand rules

- The product name is **Séance Crew**. Never name the trademarked classic Windows IRC client in code, docs, UI or commit messages. `pnpm lint` enforces this.
- All documentation, code comments, commit messages and UI copy are in English.
