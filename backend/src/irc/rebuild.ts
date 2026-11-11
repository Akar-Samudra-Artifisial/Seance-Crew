// State rebuild after every registration: LIST, then NAMES per listed channel, then WHOIS per member.
// Also owns the WHOIS scheduler used for later JOINs and "is ready" notices.
import { irc_lower, isValidNick } from "../../vendor/irc-protocol/src/index.js";
import type { Clock } from "../clock.js";
import type { Logger } from "../log.js";
import { IrcBridge, type BridgeOptions } from "./client.js";
import type { Priority } from "./queue.js";
import type { Store } from "./store.js";

export const REBUILD_WHOIS_IN_FLIGHT = 5;
export const LIVE_WHOIS_IN_FLIGHT = 1;
export const MAX_NAMES_CHANNELS = 50;
export const LIST_TIMEOUT_MS = 15_000;
export const NAMES_TIMEOUT_MS = 30_000;
export const WHOIS_TIMEOUT_MS = 10_000;
export const WHOIS_QUEUE_LIMIT = 200;

export type SendFn = (command: string, params: readonly string[], priority: Priority) => void;
type Phase = "idle" | "list" | "names" | "whois" | "done";

export interface Rebuilder {
  /** Begin a rebuild (call after every transition to registered). */
  readonly start: () => void;
  /** Stop everything in progress (call when the connection ends). */
  readonly cancel: () => void;
  /** Schedule a WHOIS for a nick (deduplicated, rate-limited). */
  readonly requestWhois: (nick: string) => void;
  readonly phase: () => Phase;
}

export function createRebuilder(deps: { readonly store: Store; readonly clock: Clock; readonly logger: Logger; readonly send: SendFn }): Rebuilder {
  const { store, clock, logger, send } = deps;
  let phase: Phase = "idle";
  let generation = 0;
  let limit = LIVE_WHOIS_IN_FLIGHT;
  let scanning = false;
  let phaseTimer: unknown;
  let pendingNames = new Set<string>();
  const queued: string[] = [];
  const queuedKeys = new Set<string>();
  const inFlight = new Map<string, unknown>();

  const clearPhaseTimer = (): void => {
    if (phaseTimer !== undefined) clock.clearTimeout(phaseTimer);
    phaseTimer = undefined;
  };

  const trySend = (command: string, params: readonly string[]): boolean => {
    try {
      send(command, params, "low");
      return true;
    } catch (err) {
      logger.warn("rebuild could not send", { command, error: err });
      return false;
    }
  };

  const finishWhois = (key: string): void => {
    const timer = inFlight.get(key);
    if (timer === undefined) return;
    clock.clearTimeout(timer);
    inFlight.delete(key);
    pump();
  };

  const pump = (): void => {
    while (inFlight.size < limit && queued.length > 0) {
      const nick = queued.shift();
      if (nick === undefined) break;
      const key = irc_lower(nick);
      queuedKeys.delete(key);
      if (!trySend("WHOIS", [nick])) continue;
      inFlight.set(key, clock.setTimeout(() => finishWhois(key), WHOIS_TIMEOUT_MS));
    }
    if (phase === "whois" && inFlight.size === 0 && queued.length === 0) {
      phase = "done";
      limit = LIVE_WHOIS_IN_FLIGHT;
      logger.info("state rebuild finished", { channels: store.listChannels().length, agents: store.agents().length });
    }
  };

  let droppedWhois = 0;
  const flushDropped = (): void => {
    if (droppedWhois === 0) return;
    logger.warn("WHOIS queue is full; nicks were dropped", { dropped: droppedWhois, limit: WHOIS_QUEUE_LIMIT });
    droppedWhois = 0;
  };

  const requestWhois = (nick: string): void => {
    // The nick ends up in a WHOIS line; only plain valid nicks are ever sent.
    if (!isValidNick(nick)) return;
    const key = irc_lower(nick);
    if (key === irc_lower(store.ownNick) || inFlight.has(key) || queuedKeys.has(key)) return;
    if (queued.length >= WHOIS_QUEUE_LIMIT) {
      droppedWhois += 1;
      // During a rebuild the count is logged once at the end of the scan; later requests log right away.
      if (!scanning) flushDropped();
      return;
    }
    queued.push(nick);
    queuedKeys.add(key);
    pump();
  };

  const startWhois = (generationAtStart: number): void => {
    if (generationAtStart !== generation) return;
    clearPhaseTimer();
    phase = "whois";
    limit = REBUILD_WHOIS_IN_FLIGHT;
    const seen = new Set<string>();
    scanning = true;
    for (const channel of store.listChannels()) {
      for (const member of channel.members.values()) {
        const key = irc_lower(member.nick);
        if (key === irc_lower(store.ownNick) || seen.has(key)) continue;
        seen.add(key);
        requestWhois(member.nick);
      }
    }
    scanning = false;
    flushDropped();
    pump();
  };

  const startNames = (generationAtStart: number): void => {
    if (generationAtStart !== generation) return;
    clearPhaseTimer();
    phase = "names";
    const channels = store.listChannels().slice(0, MAX_NAMES_CHANNELS);
    pendingNames = new Set();
    for (const channel of channels) {
      if (trySend("NAMES", [channel.name])) pendingNames.add(irc_lower(channel.name));
    }
    if (pendingNames.size === 0) {
      startWhois(generationAtStart);
      return;
    }
    phaseTimer = clock.setTimeout(() => {
      logger.warn("NAMES replies timed out; continuing with WHOIS", { missing: pendingNames.size });
      startWhois(generationAtStart);
    }, NAMES_TIMEOUT_MS);
  };

  store.on("list-done", () => {
    if (phase === "list") startNames(generation);
  });
  store.on("names-done", (event) => {
    if (phase !== "names") return;
    pendingNames.delete(irc_lower(event.channel));
    if (pendingNames.size === 0) startWhois(generation);
  });
  store.on("whois-done", (event) => {
    finishWhois(irc_lower(event.nick));
  });

  const cancel = (): void => {
    generation += 1;
    clearPhaseTimer();
    for (const timer of inFlight.values()) clock.clearTimeout(timer);
    inFlight.clear();
    queued.length = 0;
    queuedKeys.clear();
    pendingNames = new Set();
    droppedWhois = 0;
    phase = "idle";
    limit = LIVE_WHOIS_IN_FLIGHT;
  };

  return {
    start: () => {
      cancel();
      store.resetMembership();
      phase = "list";
      const g = generation;
      if (!trySend("LIST", [])) {
        phase = "idle";
        return;
      }
      phaseTimer = clock.setTimeout(() => {
        logger.warn("LIST reply timed out; continuing with the channels already known");
        startNames(g);
      }, LIST_TIMEOUT_MS);
    },
    cancel,
    requestWhois,
    phase: () => phase,
  };
}

/** Create the bridge together with its rebuilder, wired both ways. */
export function createIrcBridge(options: Omit<BridgeOptions, "onRegistered" | "onDisconnected" | "dispatchHooks">): { readonly bridge: IrcBridge; readonly rebuilder: Rebuilder } {
  const rebuilder = createRebuilder({
    store: options.store,
    clock: options.clock,
    logger: options.logger,
    send: (command, params, priority) => bridge.send(command, params, { priority }),
  });
  const bridge: IrcBridge = new IrcBridge({
    ...options,
    onRegistered: () => rebuilder.start(),
    onDisconnected: () => rebuilder.cancel(),
    dispatchHooks: { requestWhois: (nick) => rebuilder.requestWhois(nick) },
  });
  return { bridge, rebuilder };
}
