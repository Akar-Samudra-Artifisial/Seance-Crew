// refusal-hardening Requirement 8: the refusal limiter measures time with a monotonic source.
import { describe, expect, it } from "vitest";
import { isParseError, parse } from "../vendor/irc-protocol/src/index.js";
import { systemClock, type Clock } from "../src/clock.js";
import { createDispatcher } from "../src/irc/dispatch.js";
import { REFUSAL_GLOBAL_BUDGET, REFUSAL_WINDOW_MS } from "../src/irc/refusal-limit.js";
import { Store } from "../src/irc/store.js";
import { createLogger } from "../src/log.js";
import { FakeClock } from "./fakeClock.js";

/** A clock whose wall time and monotonic time move independently, like a host whose clock is corrected. */
class SplitClock implements Clock {
  wall = 1_700_000_000_000;
  mono = 5_000;
  now(): number {
    return this.wall;
  }
  monotonic(): number {
    return this.mono;
  }
  setTimeout(): unknown {
    return 0;
  }
  clearTimeout(): void {}
}

describe("systemClock.monotonic", () => {
  it("exists, is a number and never goes down", () => {
    expect(typeof systemClock.monotonic).toBe("function");
    let last = systemClock.monotonic?.() ?? Number.NaN;
    expect(Number.isFinite(last)).toBe(true);
    for (let i = 0; i < 1_000; i += 1) {
      const next = systemClock.monotonic?.() ?? Number.NaN;
      expect(next).toBeGreaterThanOrEqual(last);
      last = next;
    }
  });
});

describe("Store.monotonicNow", () => {
  it("returns the clock's monotonic() when it has one, and not its now()", () => {
    const clock = new SplitClock();
    const store = new Store(clock);
    expect(store.monotonicNow()).toBe(5_000);
    clock.wall -= 3_600_000; // the wall clock steps back an hour
    clock.mono += 250;
    expect(store.monotonicNow()).toBe(5_250);
    expect(store.now()).toBe(clock.wall); // people-facing time stays on the wall clock
  });

  it("falls back to now() when the clock has no monotonic source", () => {
    const clock = new FakeClock(1_000_000);
    expect("monotonic" in clock).toBe(false);
    const store = new Store(clock);
    expect(store.monotonicNow()).toBe(1_000_000);
    clock.advance(2_500);
    expect(store.monotonicNow()).toBe(1_002_500);
  });
});

describe("the dispatcher's refusal limiter with a wall clock that steps back", () => {
  const SRV = "seance.local";
  const setup = () => {
    const clock = new SplitClock();
    const store = new Store(clock);
    store.ownNick = "crew";
    const logs: string[] = [];
    const logger = createLogger([], (l) => logs.push(l), () => clock.now(), "debug");
    const dispatcher = createDispatcher(store, {}, logger);
    const feed = (line: string): void => {
      const m = parse(line);
      if (isParseError(m)) throw new Error(`bad test line: ${line}`);
      dispatcher.handle(m);
    };
    // A tracked channel, so reports also add a channel line.
    feed(`:${SRV} 353 crew = #fix :@crew coder`);
    feed(`:${SRV} 366 crew #fix :End of /NAMES list.`);
    const refuse = (target: string): void => feed(`:${SRV} 404 crew ${target} :Cannot send to channel`);
    const reports = () => logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r["msg"] === "server refused a command");
    const summaries = () => logs.map((l) => JSON.parse(l) as { msg: string }).filter((r) => r.msg.includes("(global limit)"));
    const lines = () => store.channel("#fix")?.ring.newest(100).filter((l) => l.kind === "system") ?? [];
    return { clock, store, refuse, reports, summaries, lines };
  };

  it("gives no extra report and no early budget refill when now() jumps back an hour", () => {
    const h = setup();
    h.refuse("#fix"); // the first report opens the windows
    expect(h.reports()).toHaveLength(1);

    h.clock.wall -= 3_600_000; // NTP puts the clock back an hour
    h.clock.mono += 4_000; // 4 s of real time have passed

    h.refuse("#fix"); // the same key, inside its (monotonic) window
    expect(h.reports()).toHaveLength(1);
    expect(h.lines()).toHaveLength(1);

    for (let i = 0; i < REFUSAL_GLOBAL_BUDGET + 30; i += 1) h.refuse(`#other${i}`);
    // The budget was 20 reports for the whole window: 1 used above, so 19 more, and then it stays used up.
    expect(h.reports()).toHaveLength(REFUSAL_GLOBAL_BUDGET);
    h.clock.wall -= 3_600_000; // and again, a second step back
    for (let i = 0; i < 10; i += 1) h.refuse(`#more${i}`);
    expect(h.reports()).toHaveLength(REFUSAL_GLOBAL_BUDGET);
    expect(h.summaries()).toHaveLength(0);
  });

  it("opens the next window only when monotonic time has moved a full window, and carries the suppressed count", () => {
    const h = setup();
    h.refuse("#fix");
    h.clock.wall -= 3_600_000;
    h.clock.mono += 4_000;
    h.refuse("#fix");
    h.refuse("#fix");
    for (let i = 0; i < REFUSAL_GLOBAL_BUDGET + 30; i += 1) h.refuse(`#other${i}`);
    expect(h.reports()).toHaveLength(REFUSAL_GLOBAL_BUDGET);

    // Still short of a full window of monotonic time: nothing more is reported.
    h.clock.mono += REFUSAL_WINDOW_MS - 4_000 - 1;
    h.refuse("#fix");
    expect(h.reports()).toHaveLength(REFUSAL_GLOBAL_BUDGET);

    // A full window has passed: the key and the budget are open again, and the counts are told.
    h.clock.mono += 1;
    h.refuse("#fix");
    expect(h.reports()).toHaveLength(REFUSAL_GLOBAL_BUDGET + 1);
    const last = h.reports().at(-1);
    expect(last).toMatchObject({ target: "#fix", suppressed: 3 });
    expect(String(last?.["reason"])).toContain("(3 more suppressed)");
    expect(h.summaries()).toHaveLength(1);
    expect(h.summaries()[0]?.msg).toMatch(/^\d+ refusal reports suppressed \(global limit\)$/);
    expect(h.lines().at(-1)?.text).toContain("(3 more suppressed)");
  });

  it("a wall clock that jumps FORWARD does not close a window either", () => {
    const h = setup();
    h.refuse("#fix");
    h.clock.wall += 24 * 3_600_000; // a day forward
    h.clock.mono += 1_000;
    h.refuse("#fix");
    expect(h.reports()).toHaveLength(1);
  });

  it("keeps the people-facing timestamps on the wall clock", () => {
    const h = setup();
    h.refuse("#fix");
    h.clock.wall += 1_234;
    h.refuse("#other");
    // The channel line carries the wall time of the moment it was added.
    expect(h.lines()[0]?.ts).toBe(1_700_000_000_000);
    expect(h.store.now()).toBe(1_700_000_001_234);
  });
});

describe("existing fakes without monotonic keep working", () => {
  it("a FakeClock-driven store still limits by now(): one report per window, then the next window", () => {
    const clock = new FakeClock(1_000_000);
    const store = new Store(clock);
    store.ownNick = "crew";
    const logs: string[] = [];
    const dispatcher = createDispatcher(store, {}, createLogger([], (l) => logs.push(l), () => clock.now(), "debug"));
    const feed = (line: string): void => {
      const m = parse(line);
      if (isParseError(m)) throw new Error("bad line");
      dispatcher.handle(m);
    };
    const count = () => logs.filter((l) => l.includes("server refused a command")).length;
    feed(":seance.local 404 crew #a :x");
    feed(":seance.local 404 crew #a :x");
    expect(count()).toBe(1);
    clock.advance(REFUSAL_WINDOW_MS);
    feed(":seance.local 404 crew #a :x");
    expect(count()).toBe(2);
  });
});
