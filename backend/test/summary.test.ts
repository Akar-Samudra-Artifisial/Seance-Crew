import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { appPaths, ensureDataDir } from "../src/paths.js";
import { createSummaryService, DAY_MS, HISTORY_LIMIT, REDO_AFTER_FIGURE_MS, MAX_SUMMARY_CHANNELS, parseSummaryFile, REGISTER_WAIT_MS, WHOIS_WAIT_MS, type Summary, type SummaryFile } from "../src/summary.js";
import { makeBridge } from "./helpers.js";

const SECRET = "irc-secret-summary-4711";
const CONFIG: Config = { host: "irc.example.org", nick: "crew", secret: SECRET };
const HOUR = 60 * 60_000;

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "seance-summary-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function boot(opts: { registered?: boolean } = {}) {
  const h = makeBridge();
  h.ircd.accounts = { crew: SECRET };
  const paths = appPaths(root);
  ensureDataDir(paths);
  if (opts.registered !== false) {
    h.bridge.start(CONFIG);
    h.ircd.run();
    expect(h.store.state).toBe("registered");
  }
  const logger = createLogger([SECRET], (l) => h.logs.push(l), () => h.clock.now(), "debug");
  const service = createSummaryService({ store: h.store, bridge: h.bridge, paths, clock: h.clock, logger });
  const file = (): SummaryFile => JSON.parse(readFileSync(paths.summaryFile, "utf8")) as SummaryFile;
  /** Let promises and the fake network settle. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 25; i++) {
      h.ircd.run();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  /** Move the fake clock and let everything it triggers settle. */
  const advanceBy = async (ms: number): Promise<void> => {
    h.clock.advance(ms);
    await settle();
  };
  const seed = (lastRunAt: number, history: Summary[] = [fakeSummary(lastRunAt)]): void =>
    writeFileSync(paths.summaryFile, JSON.stringify({ lastRunAt, latest: history.at(-1) ?? null, history } satisfies SummaryFile));
  return { ...h, paths, service, file, settle, advanceBy, seed };
}

const fakeSummary = (at: number, overrides: Partial<Summary> = {}): Summary => ({ date: new Date(at).toISOString().slice(0, 10), generatedAt: at, totalCredits: 1, channels: [{ name: "#old", used: 1, total: 2 }], stale: false, ...overrides });

describe("schedule", () => {
  it("runs once as soon as possible when the file is missing and the bridge is registered", async () => {
    const h = boot();
    h.service.start();
    await h.settle();
    const latest = h.service.latest();
    expect(latest).not.toBeNull();
    expect(latest?.date).toBe(new Date(h.clock.now()).toISOString().slice(0, 10));
    expect(latest?.generatedAt).toBe(h.clock.now());
    expect(latest?.stale).toBe(false);
    expect(h.file().lastRunAt).toBe(h.clock.now());
    expect(h.file().history).toHaveLength(1);
    h.service.stop();
  });

  it("catches up at start when the last run is 25 h old", async () => {
    const h = boot();
    h.seed(h.clock.now() - 25 * HOUR);
    h.service.start();
    await h.settle();
    expect(h.file().history).toHaveLength(2);
    expect(h.file().lastRunAt).toBe(h.clock.now());
    h.service.stop();
  });

  it("does not catch up when the last run is 2 h old, and arms the timer for the remaining 22 h", async () => {
    const h = boot();
    const last = h.clock.now() - 2 * HOUR;
    h.seed(last);
    const timersBefore = h.clock.pending; // the bridge has its own timers
    h.service.start();
    await h.settle();
    expect(h.file().history).toHaveLength(1);
    expect(h.service.latest()?.generatedAt).toBe(last); // the loaded one
    expect(h.clock.pending - timersBefore).toBe(1);
    await h.advanceBy(22 * HOUR - 1);
    expect(h.file().history).toHaveLength(1);
    await h.advanceBy(1);
    expect(h.file().history).toHaveLength(2);
    h.service.stop();
  });

  it("runs 24 h apart, measured from the last run", async () => {
    const h = boot();
    h.service.start();
    await h.settle();
    const first = h.service.latest()?.generatedAt ?? 0;
    await h.advanceBy(DAY_MS);
    await h.advanceBy(DAY_MS);
    const times = h.file().history.map((s) => s.generatedAt);
    expect(times).toHaveLength(3);
    expect(times[1]! - first).toBeGreaterThanOrEqual(DAY_MS);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(DAY_MS);
    h.service.stop();
  });

  it("never re-arms sooner than a minute", async () => {
    const h = boot();
    h.seed(h.clock.now() - DAY_MS + 1_000); // due in 1 s
    h.service.start();
    await h.settle();
    await h.advanceBy(59_000);
    expect(h.file().history).toHaveLength(1);
    await h.advanceBy(1_000);
    expect(h.file().history).toHaveLength(2);
    h.service.stop();
  });

  it("treats a missing, unreadable or invalid file as never ran", async () => {
    for (const body of ["{nope", "[]", '{"lastRunAt":"x"}', ""]) {
      const h = boot();
      writeFileSync(h.paths.summaryFile, body);
      h.service.start();
      await h.settle();
      expect(h.file().history, JSON.stringify(body)).toHaveLength(1);
      h.service.stop();
      rmSync(root, { recursive: true, force: true });
      root = mkdtempSync(path.join(os.tmpdir(), "seance-summary-"));
    }
  });

  it("start() twice does not run twice", async () => {
    const h = boot();
    h.service.start();
    h.service.start();
    await h.settle();
    expect(h.file().history).toHaveLength(1);
    h.service.stop();
  });
});

describe("not registered", () => {
  it("waits for registration and then runs with refreshed figures", async () => {
    const h = boot({ registered: false });
    h.service.start();
    await h.settle();
    expect(h.service.latest()).toBeNull();
    h.bridge.start(CONFIG);
    await h.settle();
    expect(h.service.latest()?.stale).toBe(false);
    h.service.stop();
  });

  it("falls back after 10 minutes to the last known figures with stale: true", async () => {
    const h = boot({ registered: false });
    h.store.setCreditsFromWhois("#dev", 0.5, 2);
    h.service.start();
    await h.advanceBy(REGISTER_WAIT_MS - 1);
    expect(h.service.latest()).toBeNull();
    await h.advanceBy(1);
    const latest = h.service.latest();
    expect(latest?.stale).toBe(true);
    expect(latest?.channels).toEqual([{ name: "#dev", used: 0.5, total: 2 }]);
    expect(h.ircd.totalConnections).toBe(0);
    h.service.stop();
  });

  it("is stale when the bridge is down at the scheduled time, and sends no WHOIS", async () => {
    const h = boot();
    h.store.setAgent({ nick: "coder", model: "m", tools: [], totalCredits: null });
    h.seed(h.clock.now() - HOUR);
    h.service.start();
    await h.settle();
    h.ircd.drop(h.ircd.last);
    h.ircd.refuseConnections = true;
    await h.settle();
    expect(h.store.state).not.toBe("registered");
    const sentBefore = h.ircd.allLines.filter((l) => l.startsWith("WHOIS")).length;
    await h.advanceBy(23 * HOUR);
    expect(h.service.latest()?.stale).toBe(true);
    expect(h.ircd.allLines.filter((l) => l.startsWith("WHOIS")).length).toBe(sentBefore);
    h.service.stop();
  });
});

describe("content", () => {
  it("asks each known agent once through the send queue, then reports channels highest first with two decimals", async () => {
    const h = boot();
    h.ircd.whois["coder"] = { info: ["model: m", "tools: shell", "credits: #a 0.10 / total 0.50", "credits: #b 0.304 / total 0.50"] };
    h.store.setAgent({ nick: "coder", model: "m", tools: [], totalCredits: null });
    const before = h.ircd.allLines.length;
    h.service.start();
    await h.settle();
    expect(h.ircd.allLines.slice(before).filter((l) => l.startsWith("WHOIS"))).toEqual(["WHOIS coder"]);
    const latest = h.service.latest();
    expect(latest?.stale).toBe(false);
    expect(latest?.channels.map((c) => c.name)).toEqual(["#b", "#a"]);
    expect(latest?.channels[0]).toEqual({ name: "#b", used: 0.3, total: 0.5 });
    expect(latest?.totalCredits).toBe(0.4); // the sum of the rows (0.30 + 0.10), not the agent budget
    h.service.stop();
  });

  it("is stale when an agent never answers, after 15 s", async () => {
    const h = boot();
    h.ircd.silentWhois = true;
    h.store.setAgent({ nick: "coder", model: "m", tools: [], totalCredits: null });
    h.service.start();
    await h.advanceBy(WHOIS_WAIT_MS - 1);
    expect(h.service.latest()).toBeNull();
    await h.advanceBy(1);
    expect(h.service.latest()?.stale).toBe(true);
    h.service.stop();
  });

  it("has a null total and no channels when nothing is known", async () => {
    const h = boot();
    h.service.start();
    await h.settle();
    expect(h.service.latest()).toMatchObject({ totalCredits: null, channels: [], stale: false });
    h.service.stop();
  });

  it("two runNow calls at once share one run", async () => {
    const h = boot();
    const [a, b] = await Promise.all([h.service.runNow(), h.service.runNow()]);
    expect(a).toBe(b);
    expect(h.file().history).toHaveLength(1);
    h.service.stop();
  });
});

describe("persistence", () => {
  it("caps the history at 30, newest last", async () => {
    const h = boot();
    const old = Array.from({ length: HISTORY_LIMIT }, (_, i) => fakeSummary(h.clock.now() - (HISTORY_LIMIT + 2 - i) * DAY_MS));
    h.seed(h.clock.now() - 2 * DAY_MS, old);
    h.service.start();
    await h.settle();
    const history = h.file().history;
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history.at(-1)?.generatedAt).toBe(h.clock.now());
    expect(history[0]?.generatedAt).toBe(old[1]?.generatedAt);
    h.service.stop();
  });

  it("writes mode 600 with no temp file left, and holds no secret or config", async () => {
    const h = boot();
    h.service.start();
    await h.settle();
    expect(statSync(h.paths.summaryFile).mode & 0o777).toBe(0o600);
    expect(readdirSync(h.paths.data).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const text = readFileSync(h.paths.summaryFile, "utf8");
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/secret|token|host|nick/i);
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(["history", "lastRunAt", "latest"]);
    h.service.stop();
  });

  it("a write that fails half way leaves no temp file behind and no partial target", async () => {
    const h = boot();
    // The target is a non-empty directory, so the rename fails after the temp file was written.
    mkdirSync(h.paths.summaryFile);
    writeFileSync(path.join(h.paths.summaryFile, "keep"), "x");
    h.service.start();
    await h.settle();
    expect(readdirSync(h.paths.data).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(statSync(h.paths.summaryFile).isDirectory()).toBe(true);
    expect(h.logs.some((l) => l.includes("could not write the daily summary"))).toBe(true);
    h.service.stop();
  });

  it("a failed write is logged and the summary is still served", async () => {
    const h = boot();
    rmSync(h.paths.data, { recursive: true, force: true });
    h.service.start();
    await h.settle();
    expect(h.service.latest()).not.toBeNull();
    expect(h.logs.some((l) => l.includes("could not write the daily summary"))).toBe(true);
    expect(h.logs.join("\n")).not.toContain(SECRET);
    h.service.stop();
  });
});

describe("stop and isolation", () => {
  it("stop() clears the timer and every listener", async () => {
    const h = boot();
    const listeners = h.store.listenerCount("state");
    h.seed(h.clock.now() - HOUR);
    const timersBefore = h.clock.pending; // the bridge has its own timers
    h.service.start();
    await h.settle();
    expect(h.clock.pending).toBe(timersBefore + 1);
    h.service.stop();
    h.service.stop();
    expect(h.clock.pending).toBe(timersBefore);
    expect(h.store.listenerCount("state")).toBe(listeners);
    await h.advanceBy(3 * DAY_MS);
    expect(h.file().history).toHaveLength(1);
  });

  it("stop() while waiting for registration clears the fallback timer and the listener", async () => {
    const h = boot({ registered: false });
    const listeners = h.store.listenerCount("state");
    const timersBefore = h.clock.pending;
    h.service.start();
    expect(h.clock.pending).toBe(timersBefore + 1);
    h.service.stop();
    expect(h.clock.pending).toBe(timersBefore);
    expect(h.store.listenerCount("state")).toBe(listeners);
  });

  it("opens no extra socket across several runs", async () => {
    const h = boot();
    h.store.setAgent({ nick: "coder", model: "m", tools: [], totalCredits: null });
    h.service.start();
    await h.settle();
    for (let i = 0; i < 3; i++) {
      await h.service.runNow();
      await h.settle();
    }
    expect(h.file().history).toHaveLength(4);
    expect(h.ircd.totalConnections).toBe(1);
    h.service.stop();
  });

  it("the backend has no summary command-line flag or CLI mode, and the service starts no process", () => {
    const srcDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(path.join(dir, entry.name));
        else if (entry.name.endsWith(".ts")) files.push(path.join(dir, entry.name));
      }
    };
    walk(srcDir);
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toContain("process.argv");
    }
    const own = readFileSync(path.join(srcDir, "summary.ts"), "utf8");
    expect(own).not.toMatch(/child_process|new WebSocket|spawn\(|exec\(/);
  });
});

describe("one source for rows and total", () => {
  it("leaves a seeded channel the bridge is not in out of the rows, so the total equals the sum of the rows", async () => {
    const h = boot();
    h.store.setCreditsFromWhois("#live", 1.5, 10);
    h.store.applyList([{ name: "#live", count: 1, topic: "" }]);
    h.store.seedCredits("#gone", 4, 10); // seeded from the snapshot, not on the server: hidden (left)
    h.service.start();
    await h.settle();
    const latest = h.service.latest();
    expect(latest?.channels).toEqual([{ name: "#live", used: 1.5, total: 10 }]);
    const sum = Math.round((latest?.channels ?? []).reduce((a, c) => a + c.used, 0) * 100) / 100;
    expect(latest?.totalCredits).toBe(sum);
    h.service.stop();
  });
});

describe("a run that finds no figures", () => {
  it("runs again shortly after the first figure arrives, replacing the empty entry and keeping the schedule", async () => {
    const h = boot();
    h.service.start();
    await h.settle();
    expect(h.service.latest()).toMatchObject({ totalCredits: null, channels: [] });
    const lastRunAt = h.file().lastRunAt;
    h.store.applyList([{ name: "#live", count: 1, topic: "" }]);
    h.store.setCreditsFromWhois("#live", 1.5, 10);
    await h.advanceBy(REDO_AFTER_FIGURE_MS);
    const latest = h.service.latest();
    expect(latest).toMatchObject({ totalCredits: 1.5, channels: [{ name: "#live", used: 1.5, total: 10 }] });
    expect(latest?.totalCredits).toBe((latest?.channels ?? []).reduce((a, c) => a + c.used, 0));
    expect(h.file().history).toHaveLength(1);
    expect(h.file().lastRunAt).toBe(lastRunAt);
    h.service.stop();
  });

  it("does nothing extra while no figure arrives", async () => {
    const h = boot();
    h.service.start();
    await h.settle();
    await h.advanceBy(60 * 60_000);
    expect(h.file().history).toHaveLength(1);
    h.service.stop();
  });

  it("stop() removes the figure listener", async () => {
    const h = boot();
    const listeners = h.store.listenerCount("credits");
    h.service.start();
    await h.settle();
    expect(h.store.listenerCount("credits")).toBe(listeners + 1);
    h.service.stop();
    expect(h.store.listenerCount("credits")).toBe(listeners);
  });
});

describe("stop() during a run", () => {
  it("does not record a run time, so the next start runs again instead of waiting 24 h", async () => {
    const h = boot();
    h.ircd.silentWhois = true; // the run waits for a WHOIS reply that never comes
    h.store.setAgent({ nick: "coder", model: "m", tools: [], totalCredits: null });
    h.service.start();
    await h.advanceBy(5_000);
    expect(h.service.latest()).toBeNull();
    h.service.stop(); // aborts the wait
    await h.settle();
    expect(() => statSync(h.paths.summaryFile)).toThrow(); // nothing written
    expect(h.service.latest()).toBeNull();
    // A new start sees "never ran" and runs.
    h.ircd.silentWhois = false;
    h.ircd.whois["coder"] = { info: ["model: m"] };
    h.service.start();
    await h.settle();
    expect(h.file().history).toHaveLength(1);
    h.service.stop();
  });

  it("a run that finishes before stop() is kept", async () => {
    const h = boot();
    h.service.start();
    await h.settle();
    h.service.stop();
    expect(h.file().history).toHaveLength(1);
  });
});

describe("parseSummaryFile validation", () => {
  const base = (channels: unknown[]) => JSON.stringify({ lastRunAt: 1, latest: null, history: [{ date: "2026-01-01", generatedAt: 1, totalCredits: null, stale: false, channels }] });

  it("skips channel names the vendored validator rejects and keeps valid ones", () => {
    const parsed = parseSummaryFile(base([{ name: "nohash", used: 1, total: 1 }, { name: "#a,#b", used: 1, total: 1 }, { name: "#ok", used: 2, total: null }]));
    expect(parsed?.history[0]?.channels).toEqual([{ name: "#ok", used: 2, total: null }]);
  });

  it("caps the channels per summary at 500", () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ name: `#c${i}`, used: 1, total: 1 }));
    expect(parseSummaryFile(base(many))?.history[0]?.channels).toHaveLength(MAX_SUMMARY_CHANNELS);
  });
});

describe("parseSummaryFile", () => {
  it("accepts a valid file and drops invalid history entries", () => {
    const good = fakeSummary(1);
    const parsed = parseSummaryFile(JSON.stringify({ lastRunAt: 5, latest: good, history: [good, { nope: true }] }));
    expect(parsed).toEqual({ lastRunAt: 5, latest: good, history: [good] });
  });

  it("rejects a bad latest", () => {
    expect(parseSummaryFile(JSON.stringify({ lastRunAt: 5, latest: { date: 1 }, history: [] }))).toBeNull();
  });
});
