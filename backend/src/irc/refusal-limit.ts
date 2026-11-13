// Rate limit for refusal reports. A server (or a loop of ours) can produce many identical refusals; each key
// (numeric plus channel or target) gets at most one report per window, and the next report after the window says how
// many were held back. Only the reports are limited: the `server-error` events that tools wait on are not.

export const REFUSAL_WINDOW_MS = 10_000;
export const REFUSAL_MAX_KEYS = 100;

export interface RefusalDecision {
  /** True when this refusal should be reported (a log entry and a channel line). */
  readonly report: boolean;
  /** Refusals of the same key held back in the window that has just closed; 0 when none or when not reporting. */
  readonly suppressed: number;
}

interface Slot {
  /** When the current window opened. */
  readonly start: number;
  /** Refusals held back in the current window. */
  readonly held: number;
}

export class RefusalLimiter {
  private readonly slots = new Map<string, Slot>();

  constructor(
    private readonly windowMs: number = REFUSAL_WINDOW_MS,
    private readonly maxKeys: number = REFUSAL_MAX_KEYS,
  ) {}

  /** The number of keys remembered (never above `maxKeys`). */
  get size(): number {
    return this.slots.size;
  }

  /** Record one refusal at time `now`. */
  note(key: string, now: number): RefusalDecision {
    const slot = this.slots.get(key);
    if (slot !== undefined && now - slot.start < this.windowMs && now >= slot.start) {
      this.slots.set(key, { start: slot.start, held: slot.held + 1 });
      return { report: false, suppressed: 0 };
    }
    // A new window: report, and carry the count held back in the old one. Re-inserting moves the key to the newest end.
    this.slots.delete(key);
    while (this.slots.size >= this.maxKeys) {
      const oldest = this.slots.keys().next();
      if (oldest.done === true) break;
      this.slots.delete(oldest.value);
    }
    this.slots.set(key, { start: now, held: 0 });
    return { report: true, suppressed: slot?.held ?? 0 };
  }
}
