import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announcementsFor, diffStates } from "../src/diff.js";
import { BACKOFF_MS, createPoller, POLL_MS, SUMMARY_MS, type Poller } from "../src/poller.js";
import type { PollStatus, State, Summary } from "../src/types.js";

const stateAt = (revision: number, patch: Partial<State> = {}): State => ({
  bootId: "boot-1",
  revision,
  serverTime: 1,
  bridge: { state: "registered", host: "h", nick: "crew" },
  channels: [],
  inbox: [],
  totalCredits: null,
  truncated: false,
  ...patch,
});

interface Rig {
  readonly poller: Poller;
  readonly calls: string[];
  readonly states: State[];
  readonly statuses: PollStatus[];
  readonly summaries: Array<Summary | null>;
  hidden: boolean;
  answer: (path: string) => unknown;
}

function rig(): Rig {
  const r: Rig = {
    calls: [],
    states: [],
    statuses: [],
    summaries: [],
    hidden: false,
    answer: (path) => (path.startsWith("/apps/seance-crew/api/summary") ? { summary: null } : stateAt(1)),
    poller: undefined as unknown as Poller,
  };
  (r as { poller: Poller }).poller = createPoller({
    get: async (path) => {
      r.calls.push(path);
      const out = r.answer(path);
      if (out instanceof Error) throw out;
      return out;
    },
    isHidden: () => r.hidden,
    now: () => Date.now(),
    onState: (s) => r.states.push(s),
    onStatus: (s) => r.statuses.push(s),
    onSummary: (s) => r.summaries.push(s),
  });
  return r;
}

const stateCalls = (r: Rig): string[] => r.calls.filter((c) => c.startsWith("/apps/seance-crew/api/state"));
const summaryCalls = (r: Rig): string[] => r.calls.filter((c) => c.startsWith("/apps/seance-crew/api/summary"));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("poller schedule", () => {
  it("polls at once, then every 3 s, passing the last revision as ?since=", async () => {
    const r = rig();
    r.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(stateCalls(r)).toEqual(["/apps/seance-crew/api/state"]);
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(stateCalls(r)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(stateCalls(r)).toEqual(["/apps/seance-crew/api/state", "/apps/seance-crew/api/state?since=1"]);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(stateCalls(r)).toHaveLength(3);
    r.poller.stop();
  });

  it("does not deliver a state for { changed: false } but still reports success", async () => {
    const r = rig();
    r.answer = (path) => (path.startsWith("/apps/seance-crew/api/summary") ? { summary: null } : path.includes("since=") ? { changed: false, revision: 1 } : stateAt(1));
    r.poller.start();
    await vi.advanceTimersByTimeAsync(POLL_MS + 10);
    expect(r.states).toHaveLength(1);
    expect(r.statuses.every((s) => s.ok)).toBe(true);
    expect(r.statuses).toHaveLength(2);
    r.poller.stop();
  });

  it("delivers the full state when the revision changed", async () => {
    const r = rig();
    let revision = 1;
    r.answer = (path) => (path.startsWith("/apps/seance-crew/api/summary") ? { summary: null } : stateAt(revision));
    r.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    revision = 2;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(r.states.map((s) => s.revision)).toEqual([1, 2]);
    r.poller.stop();
  });

  it("backs off to 10 s after a failure, keeps the last success time, and recovers", async () => {
    const r = rig();
    r.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    const firstSuccess = Date.now();
    r.answer = (path) => (path.startsWith("/apps/seance-crew/api/summary") ? { summary: null } : new Error("down"));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(r.statuses.at(-1)).toEqual({ ok: false, lastSuccess: firstSuccess });
    const callsAfterFailure = stateCalls(r).length;
    await vi.advanceTimersByTimeAsync(BACKOFF_MS - 1);
    expect(stateCalls(r)).toHaveLength(callsAfterFailure);
    await vi.advanceTimersByTimeAsync(1);
    expect(stateCalls(r)).toHaveLength(callsAfterFailure + 1);
    r.answer = (path) => (path.startsWith("/apps/seance-crew/api/summary") ? { summary: null } : { changed: false, revision: 1 });
    await vi.advanceTimersByTimeAsync(BACKOFF_MS);
    expect(r.statuses.at(-1)?.ok).toBe(true);
    const before = stateCalls(r).length;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(stateCalls(r)).toHaveLength(before + 1);
    r.poller.stop();
  });

  it("reloads everything at once when the bootId changes, even if the revision matches", async () => {
    const r = rig();
    r.answer = (path) => {
      if (path.startsWith("/apps/seance-crew/api/summary")) return { summary: null };
      if (!path.includes("since=")) return { ...stateAt(1), bootId: stateBoot };
      return { changed: false, revision: 1, bootId: "boot-2" };
    };
    let stateBoot = "boot-1";
    r.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.states.map((s) => s.bootId)).toEqual(["boot-1"]);
    // The backend restarted: same revision number, new bootId.
    stateBoot = "boot-2";
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(stateCalls(r)).toEqual([
      "/apps/seance-crew/api/state",
      "/apps/seance-crew/api/state?since=1",
      "/apps/seance-crew/api/state", // reloaded right away, without waiting for the next tick and without ?since=
    ]);
    expect(r.states.map((s) => s.bootId)).toEqual(["boot-1", "boot-2"]);
    r.poller.stop();
  });

  it("ignores an unchanged answer without a bootId", async () => {
    const r = rig();
    r.answer = (path) => (path.startsWith("/apps/seance-crew/api/summary") ? { summary: null } : path.includes("since=") ? { changed: false, revision: 1 } : stateAt(1));
    r.poller.start();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(r.states).toHaveLength(1);
    r.poller.stop();
  });

  it("treats an unexpected answer as a failure", async () => {
    const r = rig();
    r.answer = (path) => (path.startsWith("/apps/seance-crew/api/summary") ? { summary: null } : { nope: true });
    r.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.statuses).toEqual([{ ok: false, lastSuccess: null }]);
    expect(r.states).toHaveLength(0);
    r.poller.stop();
  });

  it("pauses while hidden and resumes with an immediate poll when visible again", async () => {
    const r = rig();
    r.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    r.hidden = true;
    r.poller.visibilityChanged();
    const n = r.calls.length;
    await vi.advanceTimersByTimeAsync(SUMMARY_MS * 2);
    expect(r.calls).toHaveLength(n);
    r.hidden = false;
    r.poller.visibilityChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(stateCalls(r).length).toBeGreaterThan(1);
    expect(summaryCalls(r)).toHaveLength(2);
    r.poller.stop();
  });

  it("does not poll again when a poll that was in flight ends while hidden", async () => {
    const r = rig();
    r.poller.start();
    r.hidden = true;
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(stateCalls(r)).toHaveLength(1);
    r.poller.stop();
  });

  it("refresh() polls immediately and a refresh during a poll runs once more afterwards", async () => {
    const r = rig();
    r.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    r.poller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(stateCalls(r)).toHaveLength(2);
    r.poller.refresh();
    r.poller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(stateCalls(r).length).toBeLessThanOrEqual(4);
    expect(stateCalls(r).length).toBeGreaterThanOrEqual(3);
    r.poller.stop();
  });

  it("stops: no timers and no calls after stop()", async () => {
    const r = rig();
    r.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    r.poller.stop();
    const n = r.calls.length;
    await vi.advanceTimersByTimeAsync(SUMMARY_MS * 3);
    expect(r.calls).toHaveLength(n);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("summary cadence", () => {
  it("fetches on load and every 60 s, keeps going after a failure", async () => {
    const r = rig();
    r.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(summaryCalls(r)).toHaveLength(1);
    expect(r.summaries).toEqual([null]);
    await vi.advanceTimersByTimeAsync(SUMMARY_MS - 1);
    expect(summaryCalls(r)).toHaveLength(1);
    r.answer = (path) => (path.startsWith("/apps/seance-crew/api/summary") ? new Error("boom") : stateAt(1));
    await vi.advanceTimersByTimeAsync(1);
    expect(summaryCalls(r)).toHaveLength(2);
    expect(r.summaries).toEqual([null]);
    r.answer = (path) => (path.startsWith("/apps/seance-crew/api/summary") ? { summary: { date: "2026-11-10" } } : stateAt(1));
    await vi.advanceTimersByTimeAsync(SUMMARY_MS);
    expect(summaryCalls(r)).toHaveLength(3);
    expect(r.summaries).toHaveLength(2);
    r.poller.stop();
  });
});

describe("diffStates", () => {
  const withCommit = (rev: number, shas: string[], inboxIds: string[] = []): State =>
    stateAt(rev, {
      channels: [
        {
          name: "#a",
          topic: "",
          count: 1,
          credits: { used: null, total: null },
          agents: [],
          commits: shas.map((sha) => ({ agent: "coder", sha, files: 1, ts: 1 })),
          lines: [],
        },
      ],
      inbox: inboxIds.map((id) => ({ id, channel: "#a", candidates: [], agent: "coder", action: "write", ts: 1 })),
    });

  it("announces nothing on the first load", () => {
    expect(diffStates(null, withCommit(1, ["aaa"], ["i1"]))).toEqual({ newCommits: [], newInbox: [] });
  });

  it("finds new commit shas and new inbox ids only", () => {
    const diff = diffStates(withCommit(1, ["aaa"], ["i1"]), withCommit(2, ["aaa", "bbb"], ["i1", "i2"]));
    expect(diff.newCommits).toEqual([{ channel: "#a", agent: "coder", sha: "bbb" }]);
    expect(diff.newInbox.map((i) => i.id)).toEqual(["i2"]);
    expect(announcementsFor(diff)).toEqual(["New commit bbb by coder in #a.", "coder needs permission in #a: write."]);
  });

  it("finds nothing when nothing is new", () => {
    expect(announcementsFor(diffStates(withCommit(1, ["aaa"]), withCommit(2, ["aaa"])))).toEqual([]);
  });
});
