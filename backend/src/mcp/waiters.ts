// One-shot waits on store events for tools that send a line and then wait for its outcome.
// Register the waiter BEFORE sending, so a fast reply cannot be missed; the listener is always removed again.
import type { Clock } from "../clock.js";
import type { EventOf, EventType, Store } from "../irc/store.js";

export type WaitOutcome<E> =
  | { readonly kind: "event"; readonly event: E }
  | { readonly kind: "timeout" }
  /** The bridge left the registered state while waiting, so no reply can come. */
  | { readonly kind: "disconnected" };

export interface Waiter<E> {
  /** Resolves exactly once. */
  readonly promise: Promise<WaitOutcome<E>>;
  /** Drop the listener and the timer without waiting any longer (use when the send failed). */
  cancel(): void;
}

export interface WaitDeps {
  readonly store: Store;
  readonly clock: Clock;
}

export function waitForEvent<T extends EventType>(deps: WaitDeps, type: T, predicate: (event: EventOf<T>) => boolean, timeoutMs: number): Waiter<EventOf<T>> {
  const { store, clock } = deps;
  let finish: (outcome: WaitOutcome<EventOf<T>>) => void = () => undefined;
  let settled = false;
  let off: (() => void) | undefined;
  let offState: (() => void) | undefined;
  let timer: unknown;
  const cleanup = (): void => {
    off?.();
    offState?.();
    if (timer !== undefined) clock.clearTimeout(timer);
    off = undefined;
    offState = undefined;
    timer = undefined;
  };
  const promise = new Promise<WaitOutcome<EventOf<T>>>((resolve) => {
    finish = (outcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
  });
  off = store.on(type, (event) => {
    if (predicate(event)) finish({ kind: "event", event });
  });
  offState = store.on("state", (event) => {
    if (event.state !== "registered") finish({ kind: "disconnected" });
  });
  timer = clock.setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
  return {
    promise,
    cancel: () => {
      settled = true;
      cleanup();
    },
  };
}
