// Send queue: token bucket (burst 8, then 1 line per second) with a priority bypass for PONG and QUIT.
import type { Clock } from "../clock.js";
import { LineError } from "./line.js";

/**
 * urgent: PONG, QUIT. Bypass the bucket and the depth limit.
 * normal: handshake, MODE, KICK, INVITE. Queued, never rejected for depth.
 * low:    say, LIST, WHOIS. Rejected when the queue is deeper than maxDepth.
 */
export type Priority = "urgent" | "normal" | "low";

export interface SendQueueOptions {
  readonly send: (line: string) => void;
  readonly clock: Clock;
  readonly burst?: number;
  readonly refillMs?: number;
  readonly maxDepth?: number;
}

export class SendQueue {
  private readonly sendLine: (line: string) => void;
  private readonly clock: Clock;
  private readonly burst: number;
  private readonly refillMs: number;
  private readonly maxDepth: number;
  /** Two FIFOs: normal lines always go out before low ones. */
  private readonly normalLines: string[] = [];
  private readonly lowLines: string[] = [];
  private tokens: number;
  private last: number;
  private timer: unknown;

  constructor(options: SendQueueOptions) {
    this.sendLine = options.send;
    this.clock = options.clock;
    this.burst = options.burst ?? 8;
    this.refillMs = options.refillMs ?? 1000;
    this.maxDepth = options.maxDepth ?? 100;
    this.tokens = this.burst;
    this.last = this.clock.now();
  }

  get depth(): number {
    return this.normalLines.length + this.lowLines.length;
  }

  push(line: string, priority: Priority = "normal"): void {
    if (priority === "urgent") {
      this.sendLine(line);
      return;
    }
    // Req 5.5: rejected only when MORE than maxDepth lines are already waiting.
    if (priority === "low" && this.depth > this.maxDepth) {
      throw new LineError("queue-full", `send queue is full (more than ${this.maxDepth} lines waiting)`);
    }
    (priority === "low" ? this.lowLines : this.normalLines).push(line);
    this.drain();
  }

  /** Drop everything that is waiting (used when the socket closes). */
  clear(): void {
    this.normalLines.length = 0;
    this.lowLines.length = 0;
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private refill(): void {
    const now = this.clock.now();
    this.tokens = Math.min(this.burst, this.tokens + (now - this.last) / this.refillMs);
    this.last = now;
  }

  private drain(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.refill();
    while (this.depth > 0 && this.tokens >= 1 - 1e-9) {
      this.tokens -= 1;
      const line = this.normalLines.length > 0 ? this.normalLines.shift() : this.lowLines.shift();
      if (line !== undefined) this.sendLine(line);
    }
    if (this.depth > 0) {
      const wait = Math.max(1, Math.ceil((1 - this.tokens) * this.refillMs));
      this.timer = this.clock.setTimeout(() => {
        this.timer = undefined;
        this.drain();
      }, wait);
    }
  }
}
