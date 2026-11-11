// Per-context guards for the acting tools: rate limits against runaway or injected callers, and a per-channel lock so
// that a numeric error reply cannot be attributed to the wrong call.
import { irc_lower } from "../../vendor/irc-protocol/src/index.js";
import type { McpContext } from "./types.js";

export const SAY_LIMIT = 20;
export const SAY_WINDOW_MS = 60_000;
export const SUMMON_LIMIT = 3;
export const SUMMON_WINDOW_MS = 10 * 60_000;

export type Take = { readonly ok: true } | { readonly ok: false; readonly retryAfterSec: number };

/** At most `max` takes within any `windowMs`. */
export class SlidingWindow {
  private hits: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private prune(now: number): void {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
  }

  get idle(): boolean {
    return this.hits.length === 0;
  }

  take(now: number): Take {
    this.prune(now);
    if (this.hits.length >= this.max) {
      const oldest = this.hits[0] ?? now;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)) };
    }
    this.hits.push(now);
    return { ok: true };
  }

  hasRoom(now: number): boolean {
    this.prune(now);
    return this.hits.length < this.max;
  }
}

interface ContextState {
  readonly say: SlidingWindow;
  readonly summon: Map<string, SlidingWindow>;
  readonly locks: Map<string, Promise<void>>;
}

const states = new WeakMap<McpContext, ContextState>();

function stateOf(ctx: McpContext): ContextState {
  let state = states.get(ctx);
  if (state === undefined) {
    state = { say: new SlidingWindow(SAY_LIMIT, SAY_WINDOW_MS), summon: new Map(), locks: new Map() };
    states.set(ctx, state);
  }
  return state;
}

/** `say`: 20 lines per minute in total. */
export function takeSay(ctx: McpContext): Take {
  return stateOf(ctx).say.take(ctx.clock.now());
}

/** `summon`: 3 calls per channel per 10 minutes. */
export function takeSummon(ctx: McpContext, channel: string): Take {
  const { summon } = stateOf(ctx);
  const now = ctx.clock.now();
  for (const [key, window] of summon) {
    if (window.hasRoom(now) && window.idle) summon.delete(key);
  }
  const key = irc_lower(channel);
  let window = summon.get(key);
  if (window === undefined) {
    window = new SlidingWindow(SUMMON_LIMIT, SUMMON_WINDOW_MS);
    summon.set(key, window);
  }
  return window.take(now);
}

/**
 * Run `fn` after every earlier call on the same channel has finished. The acting tools wait for server replies that
 * name only the channel or the nick, so two calls in flight on one channel could otherwise be mixed up.
 */
export async function withChannelLock<T>(ctx: McpContext, channel: string, fn: () => Promise<T>): Promise<T> {
  const { locks } = stateOf(ctx);
  const key = irc_lower(channel);
  const previous = locks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  locks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}
