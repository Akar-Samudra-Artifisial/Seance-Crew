import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LineError } from "../src/irc/line.js";
import { SendQueue } from "../src/irc/queue.js";
import { FakeClock } from "./fakeClock.js";

const setup = (maxDepth?: number) => {
  const clock = new FakeClock();
  const sent: Array<{ line: string; at: number }> = [];
  const queue = new SendQueue({
    send: (line) => sent.push({ line, at: clock.now() }),
    clock,
    ...(maxDepth === undefined ? {} : { maxDepth }),
  });
  return { clock, sent, queue };
};

describe("SendQueue", () => {
  it("sends a burst of 8 immediately, then one line per second", () => {
    const { clock, sent, queue } = setup();
    const start = clock.now();
    for (let i = 0; i < 20; i++) queue.push(`L${i}`);
    expect(sent).toHaveLength(8);
    expect(queue.depth).toBe(12);
    clock.advance(999);
    expect(sent).toHaveLength(8);
    clock.advance(1);
    expect(sent).toHaveLength(9);
    clock.advance(11_000);
    expect(sent).toHaveLength(20);
    expect(sent.map((s) => s.line)).toEqual(Array.from({ length: 20 }, (_, i) => `L${i}`));
    for (let i = 8; i < 20; i++) expect(sent[i]?.at).toBe(start + (i - 7) * 1000);
  });

  it("refills up to the burst after idle time but never beyond it", () => {
    const { clock, sent, queue } = setup();
    for (let i = 0; i < 8; i++) queue.push(`A${i}`);
    clock.advance(60_000);
    for (let i = 0; i < 12; i++) queue.push(`B${i}`);
    expect(sent).toHaveLength(16);
    expect(queue.depth).toBe(4);
  });

  it("sends urgent lines immediately and does not consume tokens", () => {
    const { sent, queue } = setup();
    for (let i = 0; i < 8; i++) queue.push(`L${i}`);
    for (let i = 0; i < 5; i++) queue.push(`L${8 + i}`);
    queue.push("PONG x", "urgent");
    queue.push("QUIT", "urgent");
    expect(sent.map((s) => s.line).slice(-2)).toEqual(["PONG x", "QUIT"]);
    expect(queue.depth).toBe(5);
  });

  it("accepts low priority lines while 100 are waiting and rejects them only when more than 100 are", () => {
    const { queue } = setup();
    for (let i = 0; i < 108; i++) queue.push(`N${i}`);
    expect(queue.depth).toBe(100);
    expect(() => queue.push("PRIVMSG #c :100th", "low")).not.toThrow();
    expect(queue.depth).toBe(101);
    expect(() => queue.push("PRIVMSG #c :x", "low")).toThrow(LineError);
    expect(queue.depth).toBe(101);
  });

  it("drains normal lines before low ones, each in FIFO order", () => {
    const { clock, sent, queue } = setup();
    for (let i = 0; i < 8; i++) queue.push(`A${i}`); // uses the burst
    queue.push("L1", "low");
    queue.push("N1", "normal");
    queue.push("L2", "low");
    queue.push("N2", "normal");
    clock.advance(10_000);
    expect(sent.slice(8).map((s) => s.line)).toEqual(["N1", "N2", "L1", "L2"]);
  });

  it("rejects low priority lines once more than 100 lines are waiting but keeps accepting normal and urgent ones", () => {
    const { sent, queue } = setup();
    for (let i = 0; i < 109; i++) queue.push(`N${i}`);
    expect(queue.depth).toBe(101);
    expect(() => queue.push("PRIVMSG #c :x", "low")).toThrow(LineError);
    try {
      queue.push("WHOIS a", "low");
    } catch (err) {
      expect((err as LineError).code).toBe("queue-full");
    }
    expect(() => queue.push("MODE #c +o a", "normal")).not.toThrow();
    expect(() => queue.push("PONG t", "urgent")).not.toThrow();
    expect(sent.at(-1)?.line).toBe("PONG t");
  });

  it("clear drops waiting lines and cancels the timer", () => {
    const { clock, sent, queue } = setup();
    for (let i = 0; i < 12; i++) queue.push(`L${i}`);
    queue.clear();
    expect(queue.depth).toBe(0);
    expect(clock.pending).toBe(0);
    clock.advance(10_000);
    expect(sent).toHaveLength(8);
  });
});

describe("Property 2: send rate is bounded", () => {
  it("never emits more than 8 normal lines at once or more than burst + elapsed seconds in total", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 3000 }), fc.integer({ min: 1, max: 6 })), { maxLength: 40 }), (steps) => {
        const { clock, sent, queue } = setup();
        const start = clock.now();
        let n = 0;
        for (const [wait, count] of steps) {
          clock.advance(wait);
          for (let i = 0; i < count; i++) queue.push(`L${n++}`);
          const elapsed = clock.now() - start;
          expect(sent.length).toBeLessThanOrEqual(8 + Math.floor(elapsed / 1000));
        }
        const perMoment = new Map<number, number>();
        for (const s of sent) perMoment.set(s.at, (perMoment.get(s.at) ?? 0) + 1);
        for (const count of perMoment.values()) expect(count).toBeLessThanOrEqual(8);
      }),
      { numRuns: 200 },
    );
  });
});
