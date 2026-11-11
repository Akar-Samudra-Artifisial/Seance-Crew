// A repeating timer and the "server time that keeps moving" arithmetic, free of React so they can be tested.

export const AGE_TICK_MS = 30_000;

/** Call `onTick` every `intervalMs` until the returned function is called. */
export function startTicker(intervalMs: number, onTick: () => void): () => void {
  const id = setInterval(onTick, intervalMs);
  return () => clearInterval(id);
}

export interface Anchor {
  /** Server time (ms) of the last state. */
  readonly server: number;
  /** Local time (ms) when that state arrived. */
  readonly local: number;
}

/** The current server time, estimated from the last state and the local time that has passed since it arrived. */
export function agedNow(anchor: Anchor, localNow: number): number {
  return anchor.server + Math.max(0, localNow - anchor.local);
}
