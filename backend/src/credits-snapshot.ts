// Credits snapshot: data/credits.json holds the last known credits so a restart does not start from "unavailable".
// The writer coalesces changes to at most one write per 10 s; the loader seeds the store with stale values at start.
import { readFileSync } from "node:fs";
import { isValidChannel } from "../vendor/irc-protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import type { Clock } from "./clock.js";
import type { Store } from "./irc/store.js";
import type { Logger } from "./log.js";
import type { AppPaths } from "./paths.js";

export const SNAPSHOT_INTERVAL_MS = 10_000;
/** Bounds on what a (possibly hand-edited) file can make the store remember. */
const MAX_SNAPSHOT_CHANNELS = 500;

export interface CreditsSnapshotFile {
  readonly updatedAt: number;
  readonly total: number | null;
  /** `updatedAt` is when that channel's figure was last refreshed; old values keep their own time across restarts. */
  readonly channels: ReadonlyArray<{ readonly name: string; readonly used: number; readonly total: number | null; readonly updatedAt: number }>;
}

export interface CreditsSnapshot {
  /** Seed the store from the file. A missing or malformed file is ignored. Returns how many channels were seeded. */
  load(): number;
  /** Start writing after credit changes. */
  start(): void;
  /** Stop listening, and write once more if a change is waiting. */
  stop(): void;
}

export interface CreditsSnapshotDeps {
  readonly store: Store;
  readonly paths: AppPaths;
  readonly clock: Clock;
  readonly logger: Logger;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Parse the file text; null unless it has the expected shape (entries with bad values are skipped). */
export function parseSnapshot(text: string): CreditsSnapshotFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o["channels"])) return null;
  const fileTime = isFiniteNumber(o["updatedAt"]) ? o["updatedAt"] : 0;
  const channels: Array<{ name: string; used: number; total: number | null; updatedAt: number }> = [];
  for (const entry of o["channels"].slice(0, MAX_SNAPSHOT_CHANNELS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e["name"] !== "string" || !isValidChannel(e["name"]) || !isFiniteNumber(e["used"])) continue;
    const total = e["total"] === null || e["total"] === undefined ? null : e["total"];
    if (total !== null && !isFiniteNumber(total)) continue;
    // Files from before per-channel times fall back to the file's time.
    channels.push({ name: e["name"], used: e["used"], total, updatedAt: isFiniteNumber(e["updatedAt"]) ? e["updatedAt"] : fileTime });
  }
  return {
    updatedAt: fileTime,
    total: isFiniteNumber(o["total"]) ? o["total"] : null,
    channels,
  };
}

export function createCreditsSnapshot({ store, paths, clock, logger }: CreditsSnapshotDeps): CreditsSnapshot {
  let off: (() => void) | undefined;
  let timer: unknown;
  let dirty = false;
  /** lower-cased channel name -> when its figure was last refreshed (loaded from the file, or set by a credits event). */
  const creditTimes = new Map<string, number>();

  const write = (): void => {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
    dirty = false;
    const now = clock.now();
    // Only credits figures, never config, token or secret.
    const snapshot: CreditsSnapshotFile = {
      updatedAt: now,
      total: store.totalCredits(),
      // listChannels(), like store.totalCredits() and the credits tool: the total equals the sum of these rows.
      channels: store
        .listChannels()
        .filter((c) => c.credits.used !== null)
        .map((c) => ({ name: c.name, used: c.credits.used as number, total: c.credits.total, updatedAt: creditTimes.get(c.name.toLowerCase()) ?? now })),
    };
    try {
      writeFileAtomic(paths.creditsFile, `${JSON.stringify(snapshot)}\n`);
    } catch (err) {
      // Retried at the next credits change; the redacting logger removes any secret from the error text.
      dirty = true;
      logger.warn("could not write the credits snapshot", { error: err });
    }
  };

  return {
    load() {
      let text: string;
      try {
        text = readFileSync(paths.creditsFile, "utf8");
      } catch {
        return 0;
      }
      const parsed = parseSnapshot(text);
      if (parsed === null) {
        logger.warn("ignoring a malformed credits snapshot");
        return 0;
      }
      for (const c of parsed.channels) {
        store.seedCredits(c.name, c.used, c.total);
        // Only a figure the snapshot actually seeded keeps the old time; one the store already had is newer.
        if (store.channel(c.name)?.credits.source === "snapshot") creditTimes.set(c.name.toLowerCase(), c.updatedAt);
      }
      return parsed.channels.length;
    },
    start() {
      if (off !== undefined) return;
      off = store.on("credits", (e) => {
        dirty = true;
        creditTimes.set(e.channel.toLowerCase(), clock.now());
        // Trailing edge: the first change arms one timer; later changes inside the window ride along.
        if (timer === undefined) timer = clock.setTimeout(write, SNAPSHOT_INTERVAL_MS);
      });
    },
    stop() {
      off?.();
      off = undefined;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
      if (dirty) write();
    },
  };
}
