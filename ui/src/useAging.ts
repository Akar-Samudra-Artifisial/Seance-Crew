// Time that keeps moving between polls, so "5 s ago" and "was denied 2 min ago" do not go stale. Timers are removed on
// unmount (see ticker.ts).
import { useEffect, useRef, useState } from "react";
import { agedNow, AGE_TICK_MS, startTicker, type Anchor } from "./ticker.js";

/** How often the "updated … ago" text on the status line is refreshed. */
export const UPDATED_TICK_MS = 5_000;

/** Server time that keeps moving: re-rendered every `tickMs`, anchored to the last server time seen. */
export function useAgingNow(serverNow: number, tickMs: number = AGE_TICK_MS): number {
  const anchor = useRef<Anchor>({ server: serverNow, local: Date.now() });
  if (anchor.current.server !== serverNow) anchor.current = { server: serverNow, local: Date.now() };
  const [, setTick] = useState(0);
  useEffect(() => startTicker(tickMs, () => setTick((t) => t + 1)), [tickMs]);
  return agedNow(anchor.current, Date.now());
}

/** The browser clock, re-read every `tickMs`. For ages measured against a local timestamp such as `lastSuccess`. */
export function useNow(tickMs: number = UPDATED_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => startTicker(tickMs, () => setNow(Date.now())), [tickMs]);
  return now;
}
