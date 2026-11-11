import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCreditsSnapshot, parseSnapshot, SNAPSHOT_INTERVAL_MS } from "../src/credits-snapshot.js";
import { Store } from "../src/irc/store.js";
import { createLogger } from "../src/log.js";
import { appPaths, ensureDataDir } from "../src/paths.js";
import { FakeClock } from "./fakeClock.js";

const SECRET = "irc-secret-snapshot-4711";
let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "seance-snap-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup() {
  const paths = appPaths(root);
  ensureDataDir(paths);
  const clock = new FakeClock();
  const store = new Store(clock);
  const logs: string[] = [];
  const logger = createLogger([SECRET], (l) => logs.push(l), () => clock.now(), "debug");
  const snapshot = createCreditsSnapshot({ store, paths, clock, logger });
  type Row = { name: string; used: number; total: number | null; updatedAt: number };
  const readRaw = () => JSON.parse(readFileSync(paths.creditsFile, "utf8")) as { updatedAt: number; total: number | null; channels: Row[] };
  /** The file with the per-channel times left out (they have their own tests). */
  const read = () => {
    const raw = readRaw();
    return { ...raw, channels: raw.channels.map(({ updatedAt: _t, ...rest }) => rest) };
  };
  return { paths, clock, store, logs, snapshot, read, readRaw };
}

describe("credits snapshot writer", () => {
  it("coalesces many changes into one write per 10 s", () => {
    const h = setup();
    h.snapshot.start();
    h.store.setCreditsFromWhois("#a", 1, 10);
    h.store.setCreditsFromWhois("#a", 2, 10);
    h.store.setCreditsFromWhois("#b", 3, 10);
    h.clock.advance(SNAPSHOT_INTERVAL_MS - 1);
    expect(() => statSync(h.paths.creditsFile)).toThrow(); // nothing yet
    h.clock.advance(1);
    const first = h.read();
    expect(first.channels).toEqual([
      { name: "#a", used: 2, total: 10 },
      { name: "#b", used: 3, total: 10 },
    ]);
    // A change after the write starts a new window.
    h.store.setCreditsFromWhois("#a", 4, 10);
    h.clock.advance(SNAPSHOT_INTERVAL_MS - 1);
    expect(h.read().channels[0]?.used).toBe(2);
    h.clock.advance(1);
    expect(h.read().channels[0]?.used).toBe(4);
    h.snapshot.stop();
  });

  it("writes nothing while credits do not change, and arms no timer", () => {
    const h = setup();
    h.snapshot.start();
    expect(h.clock.pending).toBe(0);
    h.clock.advance(60_000);
    expect(() => statSync(h.paths.creditsFile)).toThrow();
    h.snapshot.stop();
  });

  it("writes once more on stop when a change is waiting, and nothing otherwise", () => {
    const h = setup();
    h.snapshot.start();
    h.store.setCreditsFromWhois("#a", 5, 10);
    h.snapshot.stop();
    expect(h.read().channels).toEqual([{ name: "#a", used: 5, total: 10 }]);
    expect(h.clock.pending).toBe(0);
    const before = readFileSync(h.paths.creditsFile, "utf8");
    h.snapshot.stop();
    expect(readFileSync(h.paths.creditsFile, "utf8")).toBe(before);
  });

  it("stops listening after stop", () => {
    const h = setup();
    h.snapshot.start();
    const listeners = h.store.listenerCount("credits");
    h.snapshot.stop();
    expect(h.store.listenerCount("credits")).toBe(listeners - 1);
    h.store.setCreditsFromWhois("#a", 1, 2);
    expect(h.clock.pending).toBe(0);
  });

  it("writes the file with mode 600, atomically, with no temp file left behind", () => {
    const h = setup();
    h.snapshot.start();
    h.store.setCreditsFromWhois("#a", 1, 10);
    h.clock.advance(SNAPSHOT_INTERVAL_MS);
    expect(statSync(h.paths.creditsFile).mode & 0o777).toBe(0o600);
    expect(readdirSync(h.paths.data).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    h.snapshot.stop();
  });

  it("holds only credits figures: no secret, token or config", () => {
    const h = setup();
    h.snapshot.start();
    h.store.setCreditsFromWhois("#a", 1, 10);
    h.clock.advance(SNAPSHOT_INTERVAL_MS);
    const text = readFileSync(h.paths.creditsFile, "utf8");
    expect(text).not.toContain(SECRET);
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(["channels", "total", "updatedAt"]);
    h.snapshot.stop();
  });

  it("logs a failed write without the secret and tries again at the next change", () => {
    const h = setup();
    h.snapshot.start();
    rmSync(h.paths.data, { recursive: true, force: true }); // the directory is gone, so the write fails
    h.store.setCreditsFromWhois("#a", 1, 10);
    h.clock.advance(SNAPSHOT_INTERVAL_MS);
    expect(h.logs.some((l) => l.includes("could not write the credits snapshot"))).toBe(true);
    expect(h.logs.join("\n")).not.toContain(SECRET);
    ensureDataDir(h.paths);
    h.store.setCreditsFromWhois("#a", 2, 10);
    h.clock.advance(SNAPSHOT_INTERVAL_MS);
    expect(h.read().channels[0]?.used).toBe(2);
    h.snapshot.stop();
  });
});

describe("credits snapshot loader", () => {
  const writeSnapshot = (file: string, body: unknown) => writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));

  it("seeds the store with last known values marked as a snapshot, hidden until a LIST shows the channel", () => {
    const h = setup();
    writeSnapshot(h.paths.creditsFile, { updatedAt: 1, total: 6, channels: [{ name: "#a", used: 4, total: 10 }, { name: "#b", used: 2, total: null }] });
    expect(h.snapshot.load()).toBe(2);
    const a = h.store.channel("#a");
    expect(a?.credits).toEqual({ used: 4, total: 10, source: "snapshot" });
    expect(h.store.channel("#b")?.credits.total).toBeNull();
    expect(h.store.listChannels()).toEqual([]); // not present on the server yet
    h.store.applyList([{ name: "#a", count: 2, topic: "" }]);
    expect(h.store.listChannels().map((c) => c.name)).toEqual(["#a"]);
    expect(h.store.totalCredits()).toBe(4);
  });

  it("is replaced by the first WHOIS figure", () => {
    const h = setup();
    writeSnapshot(h.paths.creditsFile, { updatedAt: 1, total: 4, channels: [{ name: "#a", used: 4, total: 10 }] });
    h.snapshot.load();
    h.store.setCreditsFromWhois("#a", 7, 10);
    expect(h.store.channel("#a")?.credits).toEqual({ used: 7, total: 10, source: "whois" });
  });

  it("does not overwrite a figure the store already has", () => {
    const h = setup();
    h.store.setCreditsFromWhois("#a", 7, 10);
    writeSnapshot(h.paths.creditsFile, { updatedAt: 1, total: 4, channels: [{ name: "#a", used: 4, total: 10 }] });
    h.snapshot.load();
    expect(h.store.channel("#a")?.credits.used).toBe(7);
  });

  it("drops seeded channels nobody lists after 10 minutes", () => {
    const h = setup();
    writeSnapshot(h.paths.creditsFile, { updatedAt: 1, total: 4, channels: [{ name: "#gone", used: 4, total: 10 }] });
    h.snapshot.load();
    h.clock.advance(10 * 60_000);
    expect(h.store.sweep()).toEqual(["#gone"]);
  });

  it.each([
    ["missing file", null],
    ["not JSON", "{nope"],
    ["an array", "[]"],
    ["no channels list", '{"updatedAt":1}'],
    ["empty file", ""],
  ])("ignores a %s", (_name, body) => {
    const h = setup();
    if (body !== null) writeSnapshot(h.paths.creditsFile, body);
    expect(h.snapshot.load()).toBe(0);
    expect(h.store.allChannels()).toEqual([]);
  });

  it("skips entries with bad names or values and keeps the good ones", () => {
    const h = setup();
    writeSnapshot(h.paths.creditsFile, {
      updatedAt: 1,
      total: null,
      channels: [{ name: "nohash", used: 1, total: 1 }, { name: "#a", used: -1, total: 1 }, { name: "#b", used: "x", total: 1 }, { name: "#c", used: 1, total: "x" }, null, { name: "#ok", used: 1, total: 2 }],
    });
    expect(h.snapshot.load()).toBe(1);
    expect(h.store.allChannels().map((c) => c.name)).toEqual(["#ok"]);
  });

  it("a malformed file is replaced on the next write", () => {
    const h = setup();
    writeSnapshot(h.paths.creditsFile, "{nope");
    h.snapshot.load();
    h.snapshot.start();
    h.store.setCreditsFromWhois("#a", 1, 2);
    h.clock.advance(SNAPSHOT_INTERVAL_MS);
    expect(h.read().channels).toEqual([{ name: "#a", used: 1, total: 2 }]);
    h.snapshot.stop();
  });
});

describe("one source for rows and total", () => {
  it("leaves a seeded channel the bridge is not in out of the file, so the total equals the sum of the rows", () => {
    const h = setup();
    writeFileSync(h.paths.creditsFile, JSON.stringify({ updatedAt: 1, total: 4, channels: [{ name: "#gone", used: 4, total: 10, updatedAt: 1 }] }));
    h.snapshot.load();
    h.snapshot.start();
    h.store.setCreditsFromWhois("#live", 1.5, 10);
    h.clock.advance(SNAPSHOT_INTERVAL_MS);
    const file = h.read();
    expect(file.channels).toEqual([{ name: "#live", used: 1.5, total: 10 }]);
    expect(file.total).toBe(file.channels.reduce((a, c) => a + c.used, 0));
    h.snapshot.stop();
  });
});

describe("per-channel updatedAt", () => {
  it("gives a fresh figure the time of its change", () => {
    const h = setup();
    h.snapshot.start();
    h.clock.advance(5_000);
    h.store.setCreditsFromWhois("#a", 1, 2);
    const changedAt = h.clock.now();
    h.clock.advance(SNAPSHOT_INTERVAL_MS);
    expect(h.readRaw().channels[0]?.updatedAt).toBe(changedAt);
    expect(h.readRaw().updatedAt).toBe(h.clock.now());
    h.snapshot.stop();
  });

  it("keeps an old value's own time across a restart while another channel changes", () => {
    const h = setup();
    h.clock.advance(4 * 60 * 60_000); // the fake clock starts near 0; times in the file are never negative
    const old = h.clock.now() - 3 * 60 * 60_000;
    writeFileSync(h.paths.creditsFile, JSON.stringify({ updatedAt: old + 1_000, total: 4, channels: [{ name: "#old", used: 4, total: 10, updatedAt: old }] }));
    h.snapshot.load();
    h.store.applyList([{ name: "#old", count: 1, topic: "" }]); // the channel exists again, but its figure is still the old one
    h.snapshot.start();
    h.store.setCreditsFromWhois("#new", 1, 2);
    const newAt = h.clock.now();
    h.clock.advance(SNAPSHOT_INTERVAL_MS);
    const rows = Object.fromEntries(h.readRaw().channels.map((c) => [c.name, c.updatedAt]));
    expect(rows["#old"]).toBe(old);
    expect(rows["#new"]).toBe(newAt);
    h.snapshot.stop();
  });

  it("a refreshed figure replaces the old time", () => {
    const h = setup();
    const old = h.clock.now() - 60_000;
    writeFileSync(h.paths.creditsFile, JSON.stringify({ updatedAt: old, total: 4, channels: [{ name: "#a", used: 4, total: 10, updatedAt: old }] }));
    h.snapshot.load();
    h.store.applyList([{ name: "#a", count: 1, topic: "" }]);
    h.snapshot.start();
    h.store.setCreditsFromWhois("#a", 5, 10);
    const at = h.clock.now();
    h.clock.advance(SNAPSHOT_INTERVAL_MS);
    expect(h.readRaw().channels[0]?.updatedAt).toBe(at);
    h.snapshot.stop();
  });

  it("falls back to the file's time for entries without their own, and reads the field when present", () => {
    const parsed = parseSnapshot(JSON.stringify({ updatedAt: 7, total: null, channels: [{ name: "#a", used: 1, total: 1 }, { name: "#b", used: 1, total: 1, updatedAt: 3 }] }));
    expect(parsed?.channels.map((c) => c.updatedAt)).toEqual([7, 3]);
  });
});

describe("parseSnapshot", () => {
  it("caps the number of channels it accepts", () => {
    const channels = Array.from({ length: 600 }, (_, i) => ({ name: `#c${i}`, used: 1, total: 1 }));
    expect(parseSnapshot(JSON.stringify({ updatedAt: 1, total: null, channels }))?.channels).toHaveLength(500);
  });
});
