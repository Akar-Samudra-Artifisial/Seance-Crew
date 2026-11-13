# Demo: summon, steer and exorcise a coding agent

## What you will see

In about 80 seconds you summon the `coder` agent into `#crew-live` from Crew chat, watch its worktree, permission request, commit and credits on the Séance Crew dashboard, grant it op through a confirmation dialog, and exorcise it when it is done. Nothing destructive happens without a human clicking or typing a yes.

Total time: 60 to 90 seconds when the prerequisites are ready. The per-step times below are targets, not measurements; the timed run is recorded in the pull request description.

## Prerequisites

- [ ] Kiro Crew is installed and you are signed in.
- [ ] The app is installed and trusted:
  ```sh
  kirocrew app install /absolute/path/to/seance-crew
  kirocrew config set agent.apps_trusted '["seance-crew"]'
  kirocrew app enable seance-crew
  ```
- [ ] The app config has `host`, `nick` (default `crew`) and `secret` set, and the dashboard status line reads **Connected**.
- [ ] The `crew` account is allowed to invite agents: it is listed in `SEANCE_INVITERS` on the Séance server.
- [ ] The `crew` nick is a member of `#crew-live` (summon joins it for you). It does not need `+o` to see the needs-op item: the agent announces its own denial in the channel, and the app reads it from there. It does need `+o` (or a human operator) to grant modes and exorcise.
- [ ] The `seance-steward` agent is selected in Crew chat. It runs `list_channels`, `read`, `whois` and `credits` without a prompt; `say`, `summon`, `grant_op` and `exorcise` each show the Kiro Crew approval prompt, and you approve them as they come up.
- [ ] `#crew-live` has never been used on the Séance server, so `coder` gets a fresh worktree of the target repository (with exactly one failing test) and no memory of earlier sessions. For a retake, use another unused channel name (for example `#crew-live2`) in every step.
- [ ] The dashboard is open at `/apps/seance-crew` next to Crew chat.

## Script

| # | Time | Where | Action | Expected screen text |
| --- | --- | --- | --- | --- |
| 1 | 0:00 | Crew chat | Type: `summon coder into #crew-live and ask it to fix the failing test`. Approve the `summon` prompt. | The steward calls `summon`; the result reads `coder is ready in #crew-live.` (`ready: true`), or `coder did not say it is ready in #crew-live within <n> s. It may still be starting` |
| 2 | 0:10 | Dashboard | Open `/apps/seance-crew`. In the `#crew-live` card, look at "Recent log" (open by default). | Status line `Connected · <host> as crew · updated <n> s ago`; overview tiles (Channels, Agents ready, Operators, Needs op, Total credits, Commits); a card `#crew-live`; agent row `coder` with the pills `no modes` and `Ready` (or `Starting`); log line `ChanServ (notice) worktree ready: <dir> @ <sha>` |
| 3 | 0:20 | Crew chat | The steward asks to grant `+v` before it says anything to `coder`; answer yes and approve `grant_op`. Then it sends the task with `say`; approve it. If it calls `say` first, say no and ask it to grant `+v` first. | Agent row shows the pill `+v voice`; the log shows the crew account's own message to `coder` (a line from `crew`, once). If the server refuses it, the log shows `Server refused (<numeric>): <reason>` right after |
| 4 | 0:30 | Dashboard | Wait for the "Needs op" panel at the top of the right column (a few seconds). The agent announces the denial in the channel as `ops: coder denied <action>: needs-op`, and the app turns it into an item. | `coder → <action>`, the channel pill `#crew-live` and `was denied <n> s ago`, with buttons `Grant op` and `Dismiss`; the "Needs op" tile shows `1` |
| 5 | 0:40 | Dashboard | Click `Grant op`, then `Confirm` in the dialog. | Dialog title `Grant +o to coder in #crew-live?` and text `+o lets the agent edit files and run commands in the channel worktree.`; after Confirm the status message `Applied +o to coder in #crew-live.`, agent row pill `+o operator`, and the item leaves the "Needs op" panel (`No open requests`); the Confirm button is the accent (purple) primary button (a grant), not red |
| 6 | 0:55 | Dashboard | If nothing happens after the grant, the agent may not retry by itself: in Crew chat ask the steward to `say` the task again (approve the `say` prompt). Then watch the card. | "Latest commits" lists `<sha>`, `coder`, `<n> file(s)` and `<n> s ago`; the log shows `ChanServ (notice) coder committed <sha> (<n> file(s))`; `Credits used` `<X.XX> of <Y.YY>` and its bar rise |
| 7 | 1:10 | Crew chat | Type: `exorcise coder`. Answer yes when the steward asks, and approve the `exorcise` prompt. | The steward warns that uncommitted work is reverted, then the result reads `Session closed in #crew-live; worktree reset to <sha>.`; the log shows `session closed, worktree reset to <sha>` and `<N> file(s) reverted · <X.XX> credits used` |
| 8 | 1:20 | Dashboard | Look at the card. | `coder` is gone (`No agents in this channel`), the final `Credits used` `<X.XX> of <Y.YY>` stays, and "Daily summary" reads `No summary yet` or shows the last daily total |

Notes:

- Every value in angle brackets (`<sha>`, `<X.XX>`, `<n>`, `<dir>`, `<host>`) varies per run. The rest is copied from the UI and the ChanServ notice formats.
- The same grant and exorcise can be done from the dashboard: each agent row has mode buttons (`Give +v`, `Give +o`, `Revoke -v`, `Revoke -o`, depending on the current modes) and an `Exorcise` button that open the same dialogs (the exorcise dialog title is `Exorcise coder from #crew-live?`).

## Recovery

- **The invite is refused.** The summon result names the cause: `The server refused the invite (482)` or `(473)` means the account is not allowed to invite or is not an operator. Add the account to `SEANCE_INVITERS` on the server, make the `crew` nick `+o` in `#crew-live`, and type the prompt again. `The crew account could not join #crew-live` means the channel is invite-only, full, keyed or the account is banned.
- **The agent stays "Starting".** `summon` waits 20 seconds for the ready notice, and the agent may still be starting after that. Wait, then open the log. If `worktree ready` never appears, type `exorcise coder`, confirm, and summon again. Summons are limited per channel, so wait a few minutes after repeated tries.
- **No needs-op item appears.** Look in "Recent log" in the `#crew-live` card (reopen it if you closed it) for `coder (notice) ops: coder denied <action>: needs-op`. If it is there but no card appears, `coder` is not a member of the channel or not yet known as an agent here: wait for the `is ready` notice, then ask the steward to `say` the task again. If it is not there, the agent was not denied (it may already have `+o`, or has not tried to write yet): ask the steward to `say` the task again, or skip to step 6. The card needs only channel membership, not `+o` for the `crew` nick.
- **The dashboard status is not Connected.** Check `host`, `nick` and `secret` in the app settings. Another copy of the app holding the connection shows as `Another copy is running`.
- **Reset the channel.** Type `exorcise coder` and confirm (or click `Exorcise` on the dashboard). The worktree goes back to the commit shown in `worktree reset to <sha>`, and uncommitted work is reverted.

## Cleanup

1. If `coder` is still in the channel, run step 7.
2. Leave `#crew-live` as the `crew` account. Do not use it again: it now has a worktree and an agent history, so the next run needs a new unused channel name.
3. Nothing in this repository changes during the demo, so there is nothing to commit. The agent's commits live in the Séance worktree on the server.
