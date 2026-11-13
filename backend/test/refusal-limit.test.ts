import { describe, expect, it } from "vitest";
import { REFUSAL_MAX_KEYS, REFUSAL_WINDOW_MS, RefusalLimiter } from "../src/irc/refusal-limit.js";

describe("RefusalLimiter", () => {
  it("reports the first refusal of a key and holds back the rest of the window", () => {
    const l = new RefusalLimiter();
    expect(l.note("404 #a", 0)).toEqual({ report: true, suppressed: 0 });
    for (let i = 1; i <= 19; i += 1) expect(l.note("404 #a", i * 100)).toEqual({ report: false, suppressed: 0 });
  });

  it("reports again once the window has closed and tells how many were held back", () => {
    const l = new RefusalLimiter();
    l.note("404 #a", 0);
    for (let i = 0; i < 19; i += 1) l.note("404 #a", 1_000);
    expect(l.note("404 #a", REFUSAL_WINDOW_MS - 1)).toEqual({ report: false, suppressed: 0 });
    expect(l.note("404 #a", REFUSAL_WINDOW_MS)).toEqual({ report: true, suppressed: 20 });
    // The count was handed over once: the next window starts clean.
    expect(l.note("404 #a", REFUSAL_WINDOW_MS + 1)).toEqual({ report: false, suppressed: 0 });
    expect(l.note("404 #a", 2 * REFUSAL_WINDOW_MS)).toEqual({ report: true, suppressed: 1 });
  });

  it("says nothing extra when nothing was held back", () => {
    const l = new RefusalLimiter();
    l.note("404 #a", 0);
    expect(l.note("404 #a", REFUSAL_WINDOW_MS + 5)).toEqual({ report: true, suppressed: 0 });
  });

  it("does not mix keys: another numeric, channel or target is its own window", () => {
    const l = new RefusalLimiter();
    for (const key of ["404 #a", "403 #a", "404 #b", "441 #a", "461 kick"]) expect(l.note(key, 5).report, key).toBe(true);
    for (const key of ["404 #a", "403 #a", "404 #b"]) expect(l.note(key, 6).report, key).toBe(false);
  });

  it("opens a new window when the clock steps back, instead of holding back for ever", () => {
    const l = new RefusalLimiter();
    l.note("404 #a", 50_000);
    expect(l.note("404 #a", 1_000).report).toBe(true);
  });

  it("keeps at most 100 keys and drops the oldest first", () => {
    const l = new RefusalLimiter();
    for (let i = 0; i < REFUSAL_MAX_KEYS + 40; i += 1) l.note(`404 #c${i}`, i);
    expect(l.size).toBe(REFUSAL_MAX_KEYS);
    // The oldest were forgotten, so they are reported as new; the newest are still held back.
    expect(l.note("404 #c0", 150).report).toBe(true);
    expect(l.note(`404 #c${REFUSAL_MAX_KEYS + 39}`, 151).report).toBe(false);
    expect(l.size).toBe(REFUSAL_MAX_KEYS);
  });

  it("a renewed key moves to the newest end and is not the next one dropped", () => {
    const l = new RefusalLimiter(10, 3);
    l.note("a", 0);
    l.note("b", 1);
    l.note("c", 2);
    l.note("a", 20); // a's window closed: re-inserted as newest
    l.note("d", 21); // drops the oldest, which is now b
    expect(l.note("a", 22).report).toBe(false);
    expect(l.note("b", 23).report).toBe(true);
  });
});
