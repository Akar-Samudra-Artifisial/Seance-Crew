import { describe, expect, it } from "vitest";
import { REFUSAL_GLOBAL_BUDGET, REFUSAL_MAX_KEYS, REFUSAL_WINDOW_MS, RefusalLimiter } from "../src/irc/refusal-limit.js";

describe("RefusalLimiter: one report per key per window", () => {
  it("reports the first refusal of a key and holds back the rest of the window", () => {
    const l = new RefusalLimiter();
    expect(l.note("404 #a", 0)).toEqual({ report: true, suppressed: 0, summary: 0 });
    for (let i = 1; i <= 19; i += 1) expect(l.note("404 #a", i * 100)).toEqual({ report: false, suppressed: 0, summary: 0 });
  });

  it("reports again once the window has closed and tells how many were held back", () => {
    const l = new RefusalLimiter();
    l.note("404 #a", 0);
    for (let i = 0; i < 19; i += 1) l.note("404 #a", 1_000);
    expect(l.note("404 #a", REFUSAL_WINDOW_MS - 1)).toEqual({ report: false, suppressed: 0, summary: 0 });
    expect(l.note("404 #a", REFUSAL_WINDOW_MS)).toEqual({ report: true, suppressed: 20, summary: 0 });
    // The count was handed over once: the next window starts clean.
    expect(l.note("404 #a", REFUSAL_WINDOW_MS + 1)).toEqual({ report: false, suppressed: 0, summary: 0 });
    expect(l.note("404 #a", 2 * REFUSAL_WINDOW_MS)).toEqual({ report: true, suppressed: 1, summary: 0 });
  });

  it("says nothing extra when nothing was held back", () => {
    const l = new RefusalLimiter();
    l.note("404 #a", 0);
    expect(l.note("404 #a", REFUSAL_WINDOW_MS + 5)).toEqual({ report: true, suppressed: 0, summary: 0 });
  });

  it("does not mix keys: another numeric, channel or target is its own window", () => {
    const l = new RefusalLimiter();
    for (const key of ["404 #a", "403 #a", "404 #b", "441 #a coder", "461 kick"]) expect(l.note(key, 5).report, key).toBe(true);
    for (const key of ["404 #a", "403 #a", "404 #b"]) expect(l.note(key, 6).report, key).toBe(false);
  });

  it("opens a new window when the clock steps back, instead of holding back for ever", () => {
    const l = new RefusalLimiter();
    l.note("404 #a", 50_000);
    expect(l.note("404 #a", 1_000).report).toBe(true);
  });
});

describe("RefusalLimiter: the global budget (Requirement 5.1, 5.2)", () => {
  it("allows at most 20 reports per window across 200 different keys, and counts the rest", () => {
    const l = new RefusalLimiter();
    let reports = 0;
    for (let i = 0; i < 200; i += 1) if (l.note(`404 #t${i}`, i * 10).report) reports += 1;
    expect(reports).toBe(REFUSAL_GLOBAL_BUDGET);
    expect(REFUSAL_GLOBAL_BUDGET).toBe(20);
    expect(l.pendingSummary).toBe(180);
  });

  it("hands the count over once, with the first report allowed after the budget refills", () => {
    const l = new RefusalLimiter();
    for (let i = 0; i < 200; i += 1) l.note(`404 #t${i}`, i * 10);
    const next = l.note("404 #new", REFUSAL_WINDOW_MS + 5_000);
    expect(next).toEqual({ report: true, suppressed: 0, summary: 180 });
    expect(l.pendingSummary).toBe(0);
    expect(l.note("404 #newer", REFUSAL_WINDOW_MS + 5_001).summary).toBe(0);
  });

  it("does not give a summary to a refusal that is itself not reported", () => {
    const l = new RefusalLimiter();
    for (let i = 0; i < 25; i += 1) expect(l.note(`404 #t${i}`, 0).summary).toBe(0);
    expect(l.pendingSummary).toBe(5);
  });

  it("a key inside its own window is held on the key and does not use the budget", () => {
    const l = new RefusalLimiter();
    l.note("404 #a", 0);
    for (let i = 0; i < 100; i += 1) l.note("404 #a", 1);
    expect(l.pendingSummary).toBe(0);
    for (let i = 0; i < 19; i += 1) expect(l.note(`404 #t${i}`, 2).report).toBe(true); // 1 + 19 = 20
    expect(l.note("404 #over", 3).report).toBe(false);
  });

  it("a key whose window closed while the budget is used up keeps its held count for its next report", () => {
    const l = new RefusalLimiter();
    l.note("404 #a", 0);
    for (let i = 0; i < 4; i += 1) l.note("404 #a", 1);
    // Use up the budget of the later window.
    const later = REFUSAL_WINDOW_MS + 1;
    for (let i = 0; i < 20; i += 1) l.note(`404 #x${i}`, later);
    expect(l.note("404 #a", later + 1)).toEqual({ report: false, suppressed: 0, summary: 0 });
    const afterRefill = later + REFUSAL_WINDOW_MS;
    expect(l.note("404 #a", afterRefill)).toMatchObject({ report: true, suppressed: 4 });
  });
});

describe("RefusalLimiter: eviction only drops expired keys (Requirement 5.3, 5.4, 5.5)", () => {
  /** A limiter with a big budget, so only the key map is under test. */
  const wide = () => new RefusalLimiter(REFUSAL_WINDOW_MS, REFUSAL_MAX_KEYS, 10_000);

  it("never evicts or resets a key whose window is still open, however many new keys arrive", () => {
    const l = wide();
    l.note("404 #tracked", 0); // the oldest key
    for (let i = 0; i < REFUSAL_MAX_KEYS * 3; i += 1) l.note(`404 #flood${i}`, 1 + i);
    expect(l.size).toBe(REFUSAL_MAX_KEYS);
    // Still inside its window and still remembered: the repeat is held back, not reported as new.
    expect(l.note("404 #tracked", 500).report).toBe(false);
  });

  it("does not store a new key when the map is full of open windows, does not report it, and counts it", () => {
    const l = wide();
    for (let i = 0; i < REFUSAL_MAX_KEYS; i += 1) expect(l.note(`404 #k${i}`, i).report).toBe(true);
    expect(l.size).toBe(REFUSAL_MAX_KEYS);
    expect(l.note("404 #extra", 200)).toEqual({ report: false, suppressed: 0, summary: 0 });
    expect(l.size).toBe(REFUSAL_MAX_KEYS);
    expect(l.pendingSummary).toBe(1);
    // It was never stored, so it is reported as a new key once there is room.
    expect(l.note("404 #extra", REFUSAL_WINDOW_MS + 1_000)).toMatchObject({ report: true, summary: 1 });
  });

  it("drops expired keys oldest first to make room", () => {
    const l = wide();
    for (let i = 0; i < REFUSAL_MAX_KEYS; i += 1) l.note(`404 #k${i}`, i);
    // k0 .. k9 are expired at this time (start + 10 s <= now), the rest are still open.
    const now = REFUSAL_WINDOW_MS + 9;
    expect(l.note("404 #new", now).report).toBe(true);
    expect(l.size).toBe(REFUSAL_MAX_KEYS);
    expect(l.note("404 #k10", now).report).toBe(false); // an open key: kept
    expect(l.note("404 #k0", now).report).toBe(true); // the oldest expired key was dropped, so it is new again
  });

  it("adds the held count of a dropped expired key to the next global summary, so it is not lost", () => {
    const l = wide();
    l.note("404 #loud", 0);
    for (let i = 0; i < 7; i += 1) l.note("404 #loud", 1); // 7 held on the key
    for (let i = 1; i < REFUSAL_MAX_KEYS; i += 1) l.note(`404 #k${i}`, 2);
    const now = REFUSAL_WINDOW_MS + 5; // #loud expired, the rest are open until 10_002
    const decision = l.note("404 #fresh", now);
    expect(decision).toEqual({ report: true, suppressed: 0, summary: 7 });
    expect(l.pendingSummary).toBe(0);
  });

  it("a renewed key moves to the newest end and is not the next one dropped", () => {
    const l = new RefusalLimiter(10, 3, 100);
    l.note("a", 0);
    l.note("b", 1);
    l.note("c", 2);
    l.note("a", 20); // a's window closed: re-inserted as the newest (b and c are expired too)
    l.note("d", 21); // makes room by dropping the oldest expired key, which is now b
    expect(l.note("a", 22).report).toBe(false);
    expect(l.note("b", 23).report).toBe(true);
  });
});
