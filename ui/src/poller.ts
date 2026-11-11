// The polling schedule, free of React so it can be tested with fake timers.
//   state:   every 3 s while the tab is visible, every 10 s after a failure, paused while hidden, `?since=<revision>`
//   summary: on start and every 60 s while visible
//   refresh(): an immediate state poll (used after every action)
import { ROUTES, stateUrl } from "./api.js";
import type { PollStatus, State, Summary, SummaryResponse, Unchanged } from "./types.js";

export const POLL_MS = 3_000;
export const BACKOFF_MS = 10_000;
export const SUMMARY_MS = 60_000;

export interface PollerDeps {
  /** GET a path under /api/*; rejects on failure. */
  readonly get: (path: string) => Promise<unknown>;
  readonly isHidden: () => boolean;
  readonly now: () => number;
  readonly onState: (state: State) => void;
  readonly onStatus: (status: PollStatus) => void;
  readonly onSummary: (summary: Summary | null) => void;
}

export interface Poller {
  start(): void;
  stop(): void;
  /** Poll the state now (after an action). Safe to call while a poll is in flight. */
  refresh(): void;
  /** Call when document.visibilityState changes. */
  visibilityChanged(): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isUnchanged(v: unknown): v is Unchanged {
  return isRecord(v) && v["changed"] === false && typeof v["revision"] === "number";
}

function isState(v: unknown): v is State {
  return isRecord(v) && typeof v["revision"] === "number" && Array.isArray(v["channels"]) && Array.isArray(v["inbox"]) && isRecord(v["bridge"]);
}

export function createPoller(deps: PollerDeps): Poller {
  let stopped = true;
  let revision: number | null = null;
  let bootId: string | null = null;
  let lastSuccess: number | null = null;
  let stateTimer: ReturnType<typeof setTimeout> | undefined;
  let summaryTimer: ReturnType<typeof setTimeout> | undefined;
  let stateInFlight = false;
  let rerun = false;
  let summaryInFlight = false;

  const clearState = (): void => {
    if (stateTimer !== undefined) clearTimeout(stateTimer);
    stateTimer = undefined;
  };
  const clearSummary = (): void => {
    if (summaryTimer !== undefined) clearTimeout(summaryTimer);
    summaryTimer = undefined;
  };

  const scheduleState = (ms: number): void => {
    clearState();
    if (stopped || deps.isHidden()) return;
    stateTimer = setTimeout(() => void pollState(), ms);
  };
  const scheduleSummary = (): void => {
    clearSummary();
    if (stopped || deps.isHidden()) return;
    summaryTimer = setTimeout(() => void pollSummary(), SUMMARY_MS);
  };

  async function pollState(): Promise<void> {
    clearState();
    if (stopped) return;
    if (deps.isHidden()) return; // visibilityChanged() resumes
    if (stateInFlight) {
      rerun = true;
      return;
    }
    stateInFlight = true;
    let delay = POLL_MS;
    try {
      const path = stateUrl(revision);
      const body = await deps.get(path);
      if (stopped) return;
      if (isUnchanged(body)) {
        if (bootId !== null && body.bootId !== undefined && body.bootId !== bootId) {
          // The backend restarted and its revision counter happens to match ours: forget it and reload everything now.
          revision = null;
          bootId = body.bootId;
          rerun = true;
        } else {
          revision = body.revision;
        }
      } else if (isState(body)) {
        revision = body.revision;
        bootId = typeof body.bootId === "string" ? body.bootId : bootId;
        deps.onState(body);
      } else {
        throw new Error("unexpected answer from the state route");
      }
      lastSuccess = deps.now();
      deps.onStatus({ ok: true, lastSuccess });
    } catch {
      if (stopped) return;
      delay = BACKOFF_MS;
      deps.onStatus({ ok: false, lastSuccess });
    } finally {
      stateInFlight = false;
    }
    if (stopped) return;
    if (rerun) {
      rerun = false;
      void pollState();
      return;
    }
    scheduleState(delay);
  }

  async function pollSummary(): Promise<void> {
    clearSummary();
    if (stopped || deps.isHidden() || summaryInFlight) return;
    summaryInFlight = true;
    try {
      const body = await deps.get(ROUTES.summary);
      if (!stopped && isRecord(body) && "summary" in body) deps.onSummary((body as unknown as SummaryResponse).summary);
    } catch {
      // Keep the last summary; the next cycle tries again.
    } finally {
      summaryInFlight = false;
    }
    scheduleSummary();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      void pollState();
      void pollSummary();
    },
    stop() {
      stopped = true;
      clearState();
      clearSummary();
    },
    refresh() {
      if (stopped) return;
      void pollState();
    },
    visibilityChanged() {
      if (stopped) return;
      if (deps.isHidden()) {
        clearState();
        clearSummary();
        return;
      }
      void pollState();
      void pollSummary();
    },
  };
}
