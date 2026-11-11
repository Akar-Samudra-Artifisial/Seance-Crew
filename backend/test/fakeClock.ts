import type { Clock } from "../src/clock.js";

interface Timer {
  readonly id: number;
  readonly at: number;
  readonly fn: () => void;
}

/** Deterministic clock: time only moves when a test calls advance(). */
export class FakeClock implements Clock {
  private time: number;
  private nextId = 1;
  private timers: Timer[] = [];

  constructor(start = 1_000_000) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const timer: Timer = { id: this.nextId++, at: this.time + Math.max(0, ms), fn };
    this.timers.push(timer);
    return timer.id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  get pending(): number {
    return this.timers.length;
  }

  /** Move time forward, firing due timers in order (timers may schedule more timers). */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.time = Math.max(this.time, due.at);
      due.fn();
    }
    this.time = target;
  }
}
