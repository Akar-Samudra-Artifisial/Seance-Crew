# Requirements Document

## Introduction

Judge-facing deliverables for the Kiroween 2026 "Best Kiro Crew App" bonus: a 60 to 90 second demo scenario (`docs/DEMO.md`), a write-up (`docs/WRITEUP.md`), and a README that lets a judge install and try the app. The documents must match the implemented behavior, so they are written last and checked against the code and specs.

## Glossary

- **Scenario**: the scripted demo in `docs/DEMO.md`.
- **Screen text**: text a judge can see in Crew chat or on the dashboard page.
- **Write-up**: `docs/WRITEUP.md`, the judge-facing description of the app.
- **Placeholder screenshot**: an image name listed in the README that is added under `docs/img/` later.

## Requirements

### Requirement 1: Demo scenario

**User Story:** As a judge, I want a short, repeatable demo so that I can see the whole loop in about a minute.

#### Acceptance Criteria

1. THE repository SHALL contain `docs/DEMO.md` describing a scenario that takes 60 to 90 seconds when performed, with a time estimate per step.
2. THE scenario SHALL start in Crew chat with the exact prompt "summon coder into #crew-live and ask it to fix the failing test".
3. THE scenario SHALL show on the dashboard, in this order: the `worktree ready` event for `#crew-live`, the needs-op inbox item, "Grant op" with the confirmation dialog, `coder committed <sha>`, and live credits.
4. THE scenario SHALL end with the chat prompt "exorcise coder" and the `worktree reset` notice (`session closed, worktree reset to <sha>`).
5. FOR every step, THE document SHALL give the exact command or prompt to type and the expected screen text, using placeholders (`<sha>`, `<X.XX>`) only where the value varies.
6. THE document SHALL list prerequisites: Kiro Crew installed and signed in, the app installed and trusted (`kirocrew config set agent.apps_trusted '["seance-crew"]'`), config (`host`, `nick`, `secret`) set, an account allowed to invite (`SEANCE_INVITERS`), the crew nick opped in `#crew-live` so that needs-op notices reach it, and a channel that has never been used on the Séance server (a fresh worktree of a repository with one failing test, and no agent memory), with another unused channel name for a retake.
7. THE document SHALL include a recovery section: what to do when the invite is refused, when the agent stays "starting", when no needs-op item appears, and how to reset the channel.
8. THE document SHALL NOT contain a secret, a real account name other than the default `crew`, or the forbidden trademark word.

### Requirement 2: Write-up

**User Story:** As a judge, I want to understand what the app is, how it is built, and why it is safe, so that I can evaluate it without reading the code.

#### Acceptance Criteria

1. THE repository SHALL contain `docs/WRITEUP.md` with sections: Summary, Features, Architecture, Security model, How Kiro built it, Try it, and Links.
2. THE Architecture section SHALL include a diagram showing Crew → MCP and dashboard → backend → one WSS connection → Séance ircd → Kiro agents in a Podman sandbox, in Mermaid and with a text description for readers who cannot render it.
3. THE Features section SHALL list the eight MCP tools, the dashboard (channels, agents, credits, commits, log, needs-op inbox, summon, exorcise), the steward agent, and the daily credit summary.
4. THE Security model section SHALL state: secret only in app config and never logged; channel text is untrusted; `confirm: true` for `MODE` and `KICK`; line validation; one connection; Host, Origin and proxy-signature checks; and the accepted risk for `/mcp`.
5. THE "How Kiro built it" section SHALL describe the use of specs (the five specs and their requirements, design and tasks), steering files (`product`, `tech`, `kirocrew`, `irc-seance`, `security`), and hooks (`guard-shell`, `verify-after-task`), with file paths.
6. THE Links section SHALL link the Séance repository https://github.com/Akar-Samudra-Artifisial/Seance and the Kiro Crew documentation.
7. EVERY claim in the document about behavior SHALL correspond to a requirement or a test in the repository, and THE document SHALL not claim features that are not implemented.

### Requirement 3: README for judges

**User Story:** As a judge, I want to install and try the app from the README alone, so that I can reproduce the demo myself.

#### Acceptance Criteria

1. THE README SHALL contain: a one-paragraph description, Install (`kirocrew app install`), Trust (`kirocrew config set agent.apps_trusted '["seance-crew"]'`), Enable, Configure (`host`, `nick`, `secret` table), Develop (`kirocrew app dev seance-crew`), a Security section, and links to `docs/DEMO.md` and `docs/WRITEUP.md`.
2. THE README Security section SHALL state the secret handling, the untrusted-text rule, the `confirm: true` rule, and the sentence "Accepted risk: any local process of the same user can call /mcp; destructive tools still need confirm:true" (or its replacement if a credential is found, see `mcp-tools` Requirement 8).
3. THE README SHALL include a screenshots placeholder list naming each file under `docs/img/` with its subject: `dashboard-overview.png`, `needs-op-inbox.png`, `grant-op-confirm.png`, `commit-and-credits.png`, `crew-chat-summon.png`, `exorcise-confirm.png`.
4. THE README SHALL state that `@kirocrew/app-sdk` is not on npm and that the UI installs with `npm install --legacy-peer-deps`.

### Requirement 4: Consistency checks

**User Story:** As a maintainer, I want the documents to stay true, so that a judge never reads a claim the code does not support.

#### Acceptance Criteria

1. THE repository SHALL include a docs test that checks `docs/DEMO.md`, `docs/WRITEUP.md` and `README.md` for: required headings, the exact chat prompts, the six screenshot names, the Séance repository link, no secret-looking strings, and no forbidden word.
2. THE docs test SHALL check that every MCP tool name in the write-up exists in the tool catalog and every dashboard API path mentioned exists in `permissions.api`.
3. THE docs test SHALL check that every relative link in the three documents points to an existing file, except for the screenshots listed as placeholders.
