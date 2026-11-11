import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { backoffDelay } from "../src/irc/client.js";
import { Store } from "../src/irc/store.js";
import { createIrcBridge } from "../src/irc/rebuild.js";
import { createLogger } from "../src/log.js";
import { FakeClock } from "./fakeClock.js";
import { FakeIrcd } from "./fakeIrcd.js";
import { makeBridge } from "./helpers.js";

const CONFIG: Config = { host: "irc.example.org", nick: "crew", secret: "s3cret" };

/** A server with two channels, one agent (coder) and one human (alice). */
const populate = (ircd: FakeIrcd): void => {
  ircd.channels = [
    { name: "#dev", count: 3, topic: "work", names: ["@crew", "+coder", "alice"] },
    { name: "#ops", count: 2, topic: "ops", names: ["@crew", "coder"] },
  ];
  ircd.whois["coder"] = { info: ["model: claude", "tools: shell", "credits: #dev 0.10 / total 0.25"] };
  ircd.whois["alice"] = { channels: "#dev" };
};

describe("backoff and reconnect", () => {
  it("retries after 1 s, 2 s, 4 s ... capped at 60 s while connection attempts fail", () => {
    const { bridge, ircd, clock, store } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    ircd.refuseConnections = true;
    ircd.drop(ircd.last);
    ircd.run();
    const attempts: number[] = [];
    const start = clock.now();
    let seen = ircd.totalConnections;
    for (let t = 0; t < 400_000; t += 100) {
      clock.advance(100);
      ircd.run();
      if (ircd.totalConnections !== seen) {
        attempts.push(clock.now() - start);
        seen = ircd.totalConnections;
      }
    }
    const gaps = attempts.slice(0, 9).map((at, i) => at - (attempts[i - 1] ?? 0));
    // First retry 1 s after the drop; each further failed attempt doubles the wait up to 60 s.
    expect(gaps.map((g) => Math.round(g / 100) * 100)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    expect(store.state).toBe("reconnecting");
  });

  it("resets the backoff once a connection registers", () => {
    const { bridge, ircd, clock, advance } = makeBridge();
    bridge.start(CONFIG);
    ircd.run();
    for (let i = 0; i < 3; i++) {
      ircd.drop(ircd.last);
      ircd.run();
      const before = ircd.totalConnections;
      clock.advance(999);
      ircd.run();
      expect(ircd.totalConnections).toBe(before);
      clock.advance(1);
      ircd.run();
      expect(ircd.totalConnections).toBe(before + 1);
      advance(5_000);
    }
  });

  it("applies the injected jitter within 25 percent", () => {
    const { bridge, ircd, clock } = makeBridge({ random: () => 1 });
    bridge.start(CONFIG);
    ircd.run();
    ircd.drop(ircd.last);
    ircd.run();
    clock.advance(1249);
    ircd.run();
    expect(ircd.totalConnections).toBe(1);
    clock.advance(1);
    ircd.run();
    expect(ircd.totalConnections).toBe(2);
  });
});

describe("Property 8: backoff stays in bounds", () => {
  it("is within [min(60000, 1000 * 2^n), 1.25 * that] for any attempt and random value", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40 }), fc.double({ min: 0, max: 1, noNaN: true }), (n, r) => {
        const base = Math.min(60_000, 1000 * 2 ** n);
        const delay = backoffDelay(n, () => r);
        expect(delay).toBeGreaterThanOrEqual(base);
        expect(delay).toBeLessThanOrEqual(Math.ceil(base * 1.25));
      }),
      { numRuns: 300 },
    );
  });
});

describe("state rebuild after registration", () => {
  it("rebuilds channels, members and agents with LIST, NAMES and WHOIS; only a 320 model line makes an agent", () => {
    const { bridge, ircd, store, advance } = makeBridge({ rebuild: true });
    populate(ircd);
    bridge.start(CONFIG);
    ircd.run();
    advance(20_000);
    expect(store.listChannels().map((c) => c.name)).toEqual(["#dev", "#ops"]);
    expect(store.channel("#dev")?.members.get("coder")?.modes).toBe("v");
    expect(store.channel("#ops")?.members.get("alice")).toBeUndefined();
    expect(store.agents().map((a) => a.nick)).toEqual(["coder"]);
    expect(store.isAgent("alice")).toBe(false);
    expect(store.channel("#dev")?.credits).toMatchObject({ used: 0.1, total: 0.25, source: "whois" });
    const lines = ircd.lines;
    expect(lines.indexOf("LIST")).toBeGreaterThan(2);
    expect(lines.filter((l) => l === "WHOIS coder")).toHaveLength(1); // coder is in two channels, asked once
    expect(lines).toContain("NAMES #dev");
    expect(lines).toContain("NAMES #ops");
    expect(lines.indexOf("NAMES #dev")).toBeGreaterThan(lines.indexOf("LIST"));
    expect(lines.indexOf("WHOIS alice")).toBeGreaterThan(lines.indexOf("NAMES #ops"));
  });

  it("rebuilds again after a dropped connection and does not keep stale members", () => {
    const { bridge, ircd, store, advance } = makeBridge({ rebuild: true });
    populate(ircd);
    bridge.start(CONFIG);
    ircd.run();
    advance(20_000);
    store.setMember(store.channel("#dev")!, "ghost", "");
    ircd.channels = [{ name: "#dev", count: 2, topic: "work", names: ["@crew", "+coder"] }];
    ircd.drop(ircd.last);
    ircd.run();
    advance(30_000);
    expect(ircd.totalConnections).toBe(2);
    expect(store.state).toBe("registered");
    expect(store.channel("#dev")?.members.has("ghost")).toBe(false);
    expect(store.channel("#ops")?.leftAt).not.toBeNull();
    expect(store.agents().map((a) => a.nick)).toEqual(["coder"]);
  });

  it("paces the rebuild through the send queue: the burst of 8 includes the handshake", () => {
    const { bridge, ircd, store, advance } = makeBridge({ rebuild: true });
    const names = Array.from({ length: 12 }, (_, i) => `u${i}`);
    ircd.channels = [{ name: "#big", count: 13, topic: "", names: ["@crew", ...names] }];
    bridge.start(CONFIG);
    ircd.run();
    // Handshake (3) + LIST + NAMES = 5 lines; only 3 more fit in the burst of 8.
    expect(ircd.lines.length).toBeLessThanOrEqual(8);
    advance(60_000);
    expect(ircd.lines.filter((l) => l.startsWith("WHOIS"))).toHaveLength(12);
    expect(store.agents()).toHaveLength(0);
  });

  it("keeps at most 5 WHOIS lines in flight when the server does not answer", () => {
    const { bridge, ircd, advance } = makeBridge({ rebuild: true });
    const names = Array.from({ length: 12 }, (_, i) => `u${i}`);
    ircd.channels = [{ name: "#big", count: 13, topic: "", names: ["@crew", ...names] }];
    ircd.silentWhois = true;
    const whoisCount = (): number => ircd.lines.filter((l) => l.startsWith("WHOIS")).length;
    bridge.start(CONFIG);
    ircd.run();
    advance(9_000);
    expect(whoisCount()).toBe(5); // the pool is full and nothing was answered yet
    advance(6_000);
    expect(whoisCount()).toBeGreaterThan(5); // timeouts (10 s) free slots
    expect(whoisCount()).toBeLessThanOrEqual(10);
    advance(60_000);
    expect(whoisCount()).toBe(12);
  });

  it("starts empty after a process restart and reports lost for sequence numbers from before it", () => {
    const first = makeBridge({ rebuild: true });
    populate(first.ircd);
    first.bridge.start(CONFIG);
    first.ircd.run();
    first.advance(20_000);
    first.ircd.sendLines(first.ircd.last, [":alice!a@h PRIVMSG #dev :before restart"]);
    first.ircd.run();
    const oldSeq = first.store.channel("#dev")!.ring.lastSeq;
    expect(oldSeq).toBeGreaterThan(0);

    // A new process: new store, new bridge, nothing carried over.
    const clock = new FakeClock();
    const store = new Store(clock);
    expect(store.listChannels()).toHaveLength(0);
    expect(store.inbox()).toHaveLength(0);
    const ircd = new FakeIrcd();
    populate(ircd);
    const logger = createLogger([], () => undefined, () => clock.now());
    const { bridge } = createIrcBridge({ store, clock, logger, createSocket: (u) => ircd.connect(u) });
    bridge.start(CONFIG);
    ircd.run();
    for (let i = 0; i < 40; i++) {
      clock.advance(500);
      ircd.run();
    }
    const ring = store.channel("#dev")!.ring;
    expect(ring.size).toBe(0);
    expect(ring.since(oldSeq + 10).lost).toBe(true);
    expect(store.channel("#dev")!.commits).toHaveLength(0);
  });

  it("does nothing on a cancelled rebuild (connection dropped mid-way)", () => {
    const { bridge, ircd, store, rebuilder, advance } = makeBridge({ rebuild: true });
    populate(ircd);
    bridge.start(CONFIG);
    ircd.run();
    expect(rebuilder?.phase()).not.toBe("idle");
    ircd.drop(ircd.last);
    ircd.run();
    expect(rebuilder?.phase()).toBe("idle");
    advance(1_000);
    expect(store.state).toBe("registered");
  });
});
