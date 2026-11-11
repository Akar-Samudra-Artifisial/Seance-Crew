// Daily credit summary. A timer inside the backend process, using the existing IRC connection and the in-memory store.
// No cron, no second process, no second socket, no model call. State is data/summary.json.
import { readFileSync } from "node:fs";
import { isValidChannel } from "../vendor/irc-protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import type { Clock } from "./clock.js";
import type { Store } from "./irc/store.js";
import type { Logger } from "./log.js";
import type { McpBridge } from "./mcp/types.js";
import type { AppPaths } from "./paths.js";

export const DAY_MS = 24 * 60 * 60_000;
/** Without a registered bridge this long after start, the first run uses last known figures. */
export const REGISTER_WAIT_MS = 10 * 60_000;
/** How long a run waits for the WHOIS replies it asked for. */
export const WHOIS_WAIT_MS = 15_000;
export const MIN_REARM_MS = 60_000;
export const HISTORY_LIMIT = 30;
export const MAX_SUMMARY_CHANNELS = 500;
/** A run that found no figures at all is repeated this long after the first credits figure arrives. */
export const REDO_AFTER_FIGURE_MS = 30_000;
const isEmpty = (s: { totalCredits: number | null; channels: readonly unknown[] }): boolean => s.totalCredits === null && s.channels.length === 0;

export type Summary = {
  /** UTC, YYYY-MM-DD. */
  readonly date: string;
  /** Milliseconds since the epoch. */
  readonly generatedAt: number;
  readonly totalCredits: number | null;
  /** Highest `used` first. */
  readonly channels: ReadonlyArray<{ readonly name: string; readonly used: number; readonly total: number | null }>;
  /** True when the figures were not refreshed in this run. */
  readonly stale: boolean;
};

export interface SummaryFile {
  readonly lastRunAt: number;
  readonly latest: Summary | null;
  /** At most 30, newest last. */
  readonly history: readonly Summary[];
}

export interface SummaryService {
  /** Load the file and schedule: catch-up run when due, otherwise a timer for the remaining time. */
  start(): void;
  /** Clear every timer and listener. Safe to call twice. */
  stop(): void;
  /** The latest summary or null. Feeds GET /api/summary and the `credits` tool. */
  latest(): Summary | null;
  /** Run now (tests and catch-up use this). Runs never overlap: a second call returns the one in progress. */
  runNow(): Promise<Summary>;
}

export interface SummaryDeps {
  readonly store: Store;
  readonly bridge: McpBridge;
  readonly paths: AppPaths;
  readonly clock: Clock;
  readonly logger: Logger;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseSummary(raw: unknown): Summary | null {
  if (!isRecord(raw) || typeof raw["date"] !== "string" || !isNum(raw["generatedAt"]) || typeof raw["stale"] !== "boolean" || !Array.isArray(raw["channels"])) return null;
  const total = raw["totalCredits"];
  if (total !== null && !isNum(total)) return null;
  const channels: Array<{ name: string; used: number; total: number | null }> = [];
  // Same rules as credits-snapshot.ts: a valid channel name, and a cap on how many a hand-edited file can make us keep.
  for (const c of raw["channels"].slice(0, MAX_SUMMARY_CHANNELS)) {
    if (!isRecord(c) || typeof c["name"] !== "string" || !isValidChannel(c["name"]) || !isNum(c["used"])) continue;
    if (c["total"] !== null && !isNum(c["total"])) continue;
    channels.push({ name: c["name"], used: c["used"], total: c["total"] });
  }
  return { date: raw["date"], generatedAt: raw["generatedAt"], totalCredits: total, channels, stale: raw["stale"] };
}

/** Parse summary.json; null for anything that is not a valid file (counts as "never ran"). */
export function parseSummaryFile(text: string): SummaryFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !isNum(raw["lastRunAt"]) || !Array.isArray(raw["history"])) return null;
  const latest = raw["latest"] === null ? null : parseSummary(raw["latest"]);
  if (raw["latest"] !== null && latest === null) return null;
  const history = raw["history"].flatMap((h) => {
    const s = parseSummary(h);
    return s === null ? [] : [s];
  });
  return { lastRunAt: raw["lastRunAt"], latest, history: history.slice(-HISTORY_LIMIT) };
}

export function createSummaryService({ store, bridge, paths, clock, logger }: SummaryDeps): SummaryService {
  let file: SummaryFile | null = null;
  let runTimer: unknown;
  let fallbackTimer: unknown;
  let offState: (() => void) | undefined;
  let running: Promise<Summary> | null = null;
  let stopped = false;
  let started = false;
  /** Counts stop() calls, so a run can tell that it was aborted while it waited. */
  let epoch = 0;
  const cancelWaits = new Set<() => void>();
  /** After an empty run: the listener for the first credits figure, and the short timer it arms. */
  let offCredits: (() => void) | undefined;
  let redoTimer: unknown;
  /** True only for the redo run: it replaces the empty entry instead of adding one. */
  let redo = false;

  const clearRedo = (): void => {
    offCredits?.();
    offCredits = undefined;
    if (redoTimer !== undefined) clock.clearTimeout(redoTimer);
    redoTimer = undefined;
  };

  const watchForFigures = (): void => {
    if (offCredits !== undefined || redoTimer !== undefined) return;
    offCredits = store.on("credits", () => {
      offCredits?.();
      offCredits = undefined;
      // Give the rebuild a moment to finish the other WHOIS replies, then build the summary again.
      redoTimer = clock.setTimeout(() => {
        redoTimer = undefined;
        redo = true;
        void service.runNow();
      }, REDO_AFTER_FIGURE_MS);
    });
  };

  const clearTimers = (): void => {
    if (runTimer !== undefined) clock.clearTimeout(runTimer);
    if (fallbackTimer !== undefined) clock.clearTimeout(fallbackTimer);
    clearRedo();
    runTimer = undefined;
    fallbackTimer = undefined;
    offState?.();
    offState = undefined;
  };

  const load = (): SummaryFile | null => {
    try {
      return parseSummaryFile(readFileSync(paths.summaryFile, "utf8"));
    } catch {
      return null;
    }
  };

  /** Send one WHOIS per known agent through the shared queue and wait for their replies (at most WHOIS_WAIT_MS). */
  const refresh = (): Promise<boolean> => {
    const nicks = store.agents().map((a) => a.nick);
    if (nicks.length === 0) return Promise.resolve(true);
    const pending = new Set<string>();
    return new Promise<boolean>((resolve) => {
      let done = false;
      let off: (() => void) | undefined;
      let timer: unknown;
      const finish = (ok: boolean): void => {
        if (done) return;
        done = true;
        off?.();
        if (timer !== undefined) clock.clearTimeout(timer);
        cancelWaits.delete(cancel);
        resolve(ok);
      };
      const cancel = (): void => finish(false);
      cancelWaits.add(cancel);
      // Listen before sending, so a quick reply is not missed.
      off = store.on("whois-done", (e) => {
        pending.delete(e.nick.toLowerCase());
        if (pending.size === 0) finish(true);
      });
      timer = clock.setTimeout(() => finish(false), WHOIS_WAIT_MS);
      for (const nick of nicks) {
        try {
          bridge.send("WHOIS", [nick], { priority: "low" });
          pending.add(nick.toLowerCase());
        } catch (err) {
          logger.debug("summary: could not queue a WHOIS", { error: err });
        }
      }
      if (pending.size === 0) finish(false);
    });
  };

  const build = (refreshed: boolean): Summary => {
    const now = clock.now();
    const channels = store
      // listChannels(), like store.totalCredits() and the credits tool: the total equals the sum of these rows.
      .listChannels()
      .filter((c) => c.credits.used !== null)
      .map((c) => ({ name: c.name, used: round2(c.credits.used as number), total: c.credits.total === null ? null : round2(c.credits.total) }))
      .sort((a, b) => b.used - a.used || a.name.localeCompare(b.name));
    const total = store.totalCredits();
    return {
      date: new Date(now).toISOString().slice(0, 10),
      generatedAt: now,
      totalCredits: total === null ? null : round2(total),
      channels,
      stale: !refreshed,
    };
  };

  const persist = (next: SummaryFile): void => {
    try {
      writeFileAtomic(paths.summaryFile, `${JSON.stringify(next)}\n`);
    } catch (err) {
      // Retried at the next run; the redacting logger removes any secret from the error text.
      logger.warn("could not write the daily summary", { error: err });
    }
  };

  const arm = (): void => {
    if (stopped || file === null) return;
    if (runTimer !== undefined) clock.clearTimeout(runTimer);
    const wait = Math.max(MIN_REARM_MS, file.lastRunAt + DAY_MS - clock.now());
    runTimer = clock.setTimeout(() => {
      runTimer = undefined;
      void service.runNow();
    }, wait);
  };

  const run = async (): Promise<Summary> => {
    // Registered: refresh credits through the normal send queue. Otherwise use last known figures and say so.
    const epochAtStart = epoch;
    const refreshed = store.state === "registered" ? await refresh() : false;
    const summary = build(refreshed);
    // stop() aborted this run: do not record a run time, so the next start runs again instead of waiting 24 h.
    if (epoch !== epochAtStart) return summary;
    // A summary taken before the server state was rebuilt has no figures. The redo below replaces it, not adds to it,
    // and keeps the daily schedule; a run that is also due for the day is a normal run.
    const previous = file?.history ?? [];
    const replaceEmpty = redo && file?.latest != null && isEmpty(file.latest) && clock.now() - file.lastRunAt < DAY_MS;
    redo = false;
    const kept = replaceEmpty ? previous.slice(0, -1) : previous;
    const history = [...kept, summary].slice(-HISTORY_LIMIT);
    file = { lastRunAt: replaceEmpty ? file!.lastRunAt : clock.now(), latest: summary, history };
    persist(file);
    if (!stopped) {
      arm();
      // Registration happens before LIST, NAMES and WHOIS have filled the store, so the first run can find nothing
      // (the dashboard then showed "total credits n/a" for a whole day). Run again shortly after the first figure arrives.
      if (isEmpty(summary)) watchForFigures();
    }
    return summary;
  };

  const service: SummaryService = {
    start() {
      if (started) return;
      started = true;
      stopped = false;
      file = load();
      const due = file === null || clock.now() - file.lastRunAt >= DAY_MS;
      if (!due) {
        arm();
        return;
      }
      // Catch-up: once the bridge is registered, or after 10 minutes with last known figures.
      const go = (): void => {
        clearTimers();
        void service.runNow();
      };
      if (store.state === "registered") {
        go();
        return;
      }
      offState = store.on("state", (e) => {
        if (e.state === "registered") go();
      });
      fallbackTimer = clock.setTimeout(go, REGISTER_WAIT_MS);
    },
    stop() {
      stopped = true;
      started = false;
      epoch += 1;
      clearTimers();
      for (const cancel of [...cancelWaits]) cancel();
    },
    latest: () => file?.latest ?? null,
    runNow() {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
  };
  return service;
}
