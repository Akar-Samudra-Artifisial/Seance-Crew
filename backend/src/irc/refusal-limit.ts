// Rate limit for refusal reports. A server (or a loop of ours) can produce many refusals; two limits keep the log and
// the channel readable:
//   - per key (numeric plus channel or target): one report per window, and the next report after the window says how
//     many were held back;
//   - global: at most REFUSAL_GLOBAL_BUDGET reports per window across all keys, so a server that sends refusals for
//     many different targets cannot get around the per-key limit. Refusals over the budget are counted and the next
//     allowed report is preceded by one summary.
// Only the reports are limited: the `server-error` events that tools wait on are not. There are no timers: a window is
// evaluated when the next refusal arrives, with the time the caller passes in. The caller passes a monotonic time (the
// store's `monotonicNow()`), so a wall clock that is corrected or changed cannot open or close a window.

export const REFUSAL_WINDOW_MS = 10_000;
export const REFUSAL_MAX_KEYS = 100;
export const REFUSAL_GLOBAL_BUDGET = 20;

export interface RefusalDecision {
  /** True when this refusal should be reported (a log entry and a channel line). */
  readonly report: boolean;
  /** Refusals of this key held back in the window that has just closed; 0 when none or when not reporting. */
  readonly suppressed: number;
  /**
   * Reports held back by the global limit (and counts that were lost when an expired key was dropped or a key could not
   * be stored) since the last report. Non-zero only on a report; the caller logs one summary line for it, first.
   */
  readonly summary: number;
}

interface Slot {
  /** When the current window opened. */
  readonly start: number;
  /** Refusals held back in the current window. */
  readonly held: number;
}

const NOT_REPORTED: RefusalDecision = { report: false, suppressed: 0, summary: 0 };

export class RefusalLimiter {
  private readonly slots = new Map<string, Slot>();
  private globalStart = Number.NEGATIVE_INFINITY;
  private globalCount = 0;
  private globalSuppressed = 0;

  constructor(
    private readonly windowMs: number = REFUSAL_WINDOW_MS,
    private readonly maxKeys: number = REFUSAL_MAX_KEYS,
    private readonly globalBudget: number = REFUSAL_GLOBAL_BUDGET,
  ) {}

  /** The number of keys remembered (never above `maxKeys`). */
  get size(): number {
    return this.slots.size;
  }

  /** Refusals held back by the global limit that no summary has told about yet. */
  get pendingSummary(): number {
    return this.globalSuppressed;
  }

  /** Record one refusal at time `now`. */
  note(key: string, now: number): RefusalDecision {
    // The global window. A clock that steps back opens a new one instead of holding back for ever.
    if (!this.open(this.globalStart, now)) {
      this.globalStart = now;
      this.globalCount = 0;
    }

    const slot = this.slots.get(key);
    if (slot !== undefined && this.open(slot.start, now)) {
      // Inside this key's window: counted on the key, never reported, and never evicted while it is open.
      this.slots.set(key, { start: slot.start, held: slot.held + 1 });
      return NOT_REPORTED;
    }

    // A new window for this key (or a new key): the global budget decides first.
    if (this.globalCount >= this.globalBudget) {
      this.globalSuppressed += 1;
      return NOT_REPORTED;
    }

    if (slot === undefined && !this.makeRoom(now)) {
      // The map is full of keys whose windows are still open: do not store this one, and do not report it.
      this.globalSuppressed += 1;
      return NOT_REPORTED;
    }

    // Report. Re-inserting moves the key to the newest end.
    this.slots.delete(key);
    this.slots.set(key, { start: now, held: 0 });
    this.globalCount += 1;
    const summary = this.globalSuppressed;
    this.globalSuppressed = 0;
    return { report: true, suppressed: slot?.held ?? 0, summary };
  }

  private open(start: number, now: number): boolean {
    return now >= start && now - start < this.windowMs;
  }

  /**
   * Make space for one more key by dropping expired slots, oldest first. A slot whose window is still open is never
   * dropped. The held count of a dropped slot goes to the global counter so it is not lost. Returns false when the map
   * is full and every slot is still open.
   */
  private makeRoom(now: number): boolean {
    while (this.slots.size >= this.maxKeys) {
      let expired: string | undefined;
      for (const [key, slot] of this.slots) {
        if (!this.open(slot.start, now)) {
          expired = key;
          break;
        }
      }
      if (expired === undefined) return false;
      this.globalSuppressed += this.slots.get(expired)?.held ?? 0;
      this.slots.delete(expired);
    }
    return true;
  }
}
