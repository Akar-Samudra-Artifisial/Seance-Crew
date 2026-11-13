# Implementation Plan: demo-writeup

## Overview

Run these last, after `irc-bridge`, `mcp-tools`, `dashboard-ui` and `steward-agent` are implemented, so the documents describe real behavior. After each task `pnpm typecheck && pnpm test && pnpm lint` must be green. Tasks run in the order listed. Verify each task with `pnpm typecheck && pnpm test && pnpm lint` and by running the tests named in the task before ticking it.

## Tasks

- [x] 1. Docs test scaffold
  - `backend/test/docs.test.ts` with helpers to read `README.md`, `docs/DEMO.md`, `docs/WRITEUP.md`; start with the checks that already pass on the README (headings, forbidden word, no secrets) and mark the others `todo` until tasks 2 to 4 land.
  - Test: the file runs and passes; `todo` cases are listed.
  - _Requirements: 4.1_

- [x] 2. Write `docs/DEMO.md`
  - Follow the structure and table in the design; copy the exact UI strings and notice formats from the implemented code. Include prerequisites (crew nick `+o` in `#crew-live`), recovery, and cleanup.
  - Manual check: perform the scenario once against a test channel with a stopwatch, fix timings and screen text, and note the run date in the PR description.
  - Test: enable the DEMO checks in `docs.test.ts` (headings, both chat prompts verbatim, 8 table rows, no secret, no forbidden word).
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_

- [x] 3. Write `docs/WRITEUP.md`
  - Sections per Requirement 2.1 with the Mermaid diagram and its text version; every behavior claim traced to a requirement or test.
  - Test: enable the write-up checks (headings, diagram block, Séance repository URL, tool names exist in the catalog, API paths exist in `permissions.api`, hook and steering file paths exist).
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

- [x] 4. Finish the README
  - Sections per the design: Install, Trust, Enable, Configure, Use, Develop, Security (with the accepted-risk sentence), Screenshots placeholder list, Links. Mention `npm install --legacy-peer-deps` for the UI.
  - Test: enable the README checks (headings, trust command string, six screenshot names, accepted-risk sentence, `--legacy-peer-deps`, links to the two docs).
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 5. Link and consistency pass
  - Enable the relative-link check (placeholders under `docs/img/` excepted) and the cross-document check that tool names and API paths match the code.
  - Test: all `docs.test.ts` cases pass with no `todo` left.
  - _Requirements: 4.1, 4.2, 4.3_

- [x] 6. Screenshots
  - Manual: take the six screenshots from `kirocrew app dev seance-crew`, save them under `docs/img/` with the names from the README list, and replace the placeholder list with image links.
  - Manual check: each image exists and shows the named subject; the docs test link check now includes them.
  - _Requirements: 3.3_

## Notes

- Depends on all four other specs being implemented, because the documents describe real behavior. Task 6 needs a running `kirocrew app dev seance-crew`.
- Never put a secret, a real account name other than the default `crew`, or the forbidden trademark word in a document or screenshot.
- Tasks 2 to 5 all edit `backend/test/docs.test.ts`, so they run one after another.
- Verify each task with `pnpm typecheck && pnpm test && pnpm lint`; manual checks (timed demo run, screenshots) are recorded in the PR description.

## Task Dependency Graph

```json
{
  "waves": [
    {
      "id": 0,
      "tasks": [
        "1"
      ]
    },
    {
      "id": 1,
      "tasks": [
        "2"
      ]
    },
    {
      "id": 2,
      "tasks": [
        "3"
      ]
    },
    {
      "id": 3,
      "tasks": [
        "4"
      ]
    },
    {
      "id": 4,
      "tasks": [
        "5"
      ]
    },
    {
      "id": 5,
      "tasks": [
        "6"
      ]
    }
  ]
}
```
