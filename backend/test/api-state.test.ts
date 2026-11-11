import { describe, expect, it } from "vitest";
import { buildState, STATE_MAX_BYTES, type StateBridge } from "../src/api/state.js";
import { Store } from "../src/irc/store.js";
import { FakeClock } from "./fakeClock.js";

const bridge = (state: StateBridge["state"] = "registered"): StateBridge => ({ state, currentConfig: { host: "irc.example.org", nick: "crew" } });

function makeStore(): Store {
  const store = new Store(new FakeClock());
  store.ownNick = "crew";
  return store;
}

describe("store revision", () => {
  it("increments on each event", () => {
    const store = makeStore();
    const seen = [store.revision];
    store.setState("registered");
    seen.push(store.revision);
    store.addLine("#a", "bob", "privmsg", "hi");
    seen.push(store.revision);
    store.addCommit(store.ensureChannel("#a"), { agent: "coder", sha: "abc1234", files: 2, ts: 1 });
    seen.push(store.revision);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1] ?? 0);
  });
});

describe("buildState", () => {
  it("has the State shape with agents, last 5 commits and open inbox", () => {
    const store = makeStore();
    const c = store.ensureChannel("#fix-bug");
    c.topic = "fix it";
    store.setMember(c, "crew", "o");
    store.setMember(c, "coder", "v");
    store.setMember(c, "bob", "");
    store.setAgent({ nick: "coder", model: "m1", tools: [], totalCredits: 3 });
    c.readyAgents.add("coder");
    for (let i = 0; i < 7; i++) store.addCommit(c, { agent: "coder", sha: `sha${i}`, files: i, ts: i });
    store.addNeedsOp("coder", "write", "#fix-bug", []);
    store.addLine("#fix-bug", "bob", "privmsg", "hello");
    c.namesLoaded = true;
    const state = buildState(store, bridge());
    expect(state.bridge).toEqual({ state: "registered", host: "irc.example.org", nick: "crew" });
    expect(state.revision).toBe(store.revision);
    expect(state.truncated).toBe(false);
    const ch = state.channels[0];
    expect(ch?.name).toBe("#fix-bug");
    expect(ch?.topic).toBe("fix it");
    expect(ch?.count).toBe(3);
    expect(ch?.agents).toEqual([{ nick: "coder", modes: "v", model: "m1", ready: true }]);
    expect(ch?.commits.map((k) => k.sha)).toEqual(["sha2", "sha3", "sha4", "sha5", "sha6"]);
    expect(ch?.commitCount).toBe(7); // every commit the store keeps, not only the 5 sent
    expect(ch?.lines.map((l) => l.text)).toEqual(["hello"]);
    expect(state.inbox).toHaveLength(1);
    expect(state.inbox[0]).toMatchObject({ channel: "#fix-bug", agent: "coder", action: "write" });
    expect(state.totalCredits).toBe(3);
  });

  it("counts up to the store limit of 50 commits while sending only 5", () => {
    const store = makeStore();
    const c = store.ensureChannel("#many");
    for (let i = 0; i < 60; i++) store.addCommit(c, { agent: "coder", sha: `s${i}`, files: 1, ts: i });
    const ch = buildState(store, bridge()).channels[0];
    expect(ch?.commitCount).toBe(50);
    expect(ch?.commits).toHaveLength(5);
  });

  it("reports credits as null when unknown", () => {
    const store = makeStore();
    store.ensureChannel("#a");
    const state = buildState(store, bridge());
    expect(state.channels[0]?.credits).toEqual({ used: null, total: null });
    expect(state.totalCredits).toBeNull();
  });

  it("keeps only the newest 200 lines per channel", () => {
    const store = makeStore();
    for (let i = 1; i <= 300; i++) store.addLine("#a", "bob", "privmsg", `m${i}`);
    const lines = buildState(store, bridge()).channels[0]?.lines ?? [];
    expect(lines).toHaveLength(200);
    expect(lines[0]?.text).toBe("m101");
    expect(lines.at(-1)?.text).toBe("m300");
  });

  it("never contains the secret, even when the bridge config holds one", () => {
    const store = makeStore();
    store.ensureChannel("#a");
    const withSecret = { state: "registered", currentConfig: { host: "h", nick: "crew", secret: "hunter2-secret" } } as StateBridge;
    const text = JSON.stringify(buildState(store, withSecret));
    expect(text).not.toContain("hunter2-secret");
    expect(text).not.toContain("secret");
  });

  it("uses empty host and the own nick when the bridge has no config", () => {
    const store = makeStore();
    const state = buildState(store, { state: "unconfigured", currentConfig: null });
    expect(state.bridge).toEqual({ state: "unconfigured", host: "", nick: "crew" });
  });

  it("caps 10 channels with 200 long lines each at 256 KiB, keeping the newest lines", () => {
    const store = makeStore();
    const long = "x".repeat(400);
    for (let ch = 0; ch < 10; ch++) {
      for (let i = 1; i <= 200; i++) store.addLine(`#c${ch}`, "bob", "privmsg", `${long}${i}`);
    }
    const state = buildState(store, bridge());
    expect(state.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(state), "utf8")).toBeLessThanOrEqual(STATE_MAX_BYTES);
    for (const c of state.channels) {
      expect(c.lines.length).toBeGreaterThan(0);
      expect(c.lines.at(-1)?.text.endsWith("200")).toBe(true);
    }
    // Dropping is balanced: the fattest channel loses first.
    const counts = state.channels.map((c) => c.lines.length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("carries a bootId that is stable within a process and can be overridden", () => {
    const store = makeStore();
    const a = buildState(store, bridge());
    expect(a.bootId).toMatch(/^[0-9a-f-]{36}$/);
    expect(buildState(store, bridge()).bootId).toBe(a.bootId);
    expect(buildState(store, bridge(), { bootId: "boot-2" }).bootId).toBe("boot-2");
  });

  describe("the cap covers the whole response, not only log lines", () => {
    const size = (s: unknown): number => Buffer.byteLength(JSON.stringify(s), "utf8");

    it("clears huge topics (oldest channel first) once the lines are gone", () => {
      const store = makeStore();
      for (let i = 0; i < 10; i++) store.ensureChannel(`#c${i}`).topic = "t".repeat(100 * 1024);
      const state = buildState(store, bridge());
      expect(state.truncated).toBe(true);
      expect(size(state)).toBeLessThanOrEqual(STATE_MAX_BYTES);
      // Oldest first: the first channels lose their topic before the last ones.
      const blank = state.channels.map((c) => c.topic === "");
      expect(blank[0]).toBe(true);
      expect(blank.lastIndexOf(true)).toBeGreaterThanOrEqual(blank.indexOf(false) - 1);
      expect(state.channels.length).toBe(10);
    });

    it("drops whole channels, oldest first, when even the empty channels do not fit", () => {
      const store = makeStore();
      for (let i = 0; i < 40; i++) store.ensureChannel(`#channel-${String(i).padStart(2, "0")}`);
      const state = buildState(store, bridge(), { maxBytes: 2_000 });
      expect(state.truncated).toBe(true);
      expect(size(state)).toBeLessThanOrEqual(2_000);
      expect(state.channels.length).toBeLessThan(40);
      expect(state.channels.at(-1)?.name).toBe("#channel-39");
      expect(state.channels[0]?.name).not.toBe("#channel-00");
    });

    it("drops commits and inbox items before channels", () => {
      const store = makeStore();
      const c = store.ensureChannel("#a");
      for (let i = 0; i < 5; i++) store.addCommit(c, { agent: "coder", sha: `sha${i}`, files: 1, ts: i });
      for (let i = 0; i < 30; i++) store.addNeedsOp(`agent${i}`, `action ${"x".repeat(200)} ${i}`, "#a", []);
      const full = size(buildState(store, bridge()));
      const state = buildState(store, bridge(), { maxBytes: full - 1_500 });
      expect(state.truncated).toBe(true);
      expect(size(state)).toBeLessThanOrEqual(full - 1_500);
      expect(state.channels).toHaveLength(1);
      expect(state.inbox.length).toBeLessThan(30);
      expect(state.inbox.at(-1)?.agent).toBe("agent29");
    });

    it("leaves a state that fits untouched", () => {
      const store = makeStore();
      store.ensureChannel("#a").topic = "keep me";
      const state = buildState(store, bridge());
      expect(state.truncated).toBe(false);
      expect(state.channels[0]?.topic).toBe("keep me");
    });
  });

  it("does not truncate a small state", () => {
    const store = makeStore();
    store.addLine("#a", "bob", "privmsg", "hi");
    const state = buildState(store, bridge());
    expect(state.truncated).toBe(false);
    expect(state.channels[0]?.lines).toHaveLength(1);
  });
});
