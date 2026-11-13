// Injectable time source so every timer in the backend can be driven by a fake clock in tests.

export interface Clock {
  now(): number;
  /** Milliseconds from an arbitrary origin; never steps back; only for measuring elapsed time. Optional: a fake may omit it. */
  monotonic?(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // Timers must never keep the process alive on their own.
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};
