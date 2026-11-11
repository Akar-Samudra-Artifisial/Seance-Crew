// IrcBridge: the single connection to the Séance server.
// State machine: unconfigured -> connecting -> registered -> reconnecting, plus the terminal states auth-failed,
// nick-rejected, config-invalid and duplicate-instance (no reconnect until the config changes).
import { isParseError, LineFramer, parse, type IrcMessage } from "../../vendor/irc-protocol/src/index.js";
import type { Clock } from "../clock.js";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import { createDispatcher, type DispatchHooks, type Dispatcher } from "./dispatch.js";
import { buildLine, LineError } from "./line.js";
import { SendQueue, type Priority } from "./queue.js";
import { createWebSocket, READY_STATE, type SocketFactory, type SocketLike } from "./socket.js";
import { type BridgeState, type Store } from "./store.js";

export const REGISTRATION_TIMEOUT_MS = 15_000;
export const IDLE_PING_AFTER_MS = 120_000;
export const IDLE_GRACE_MS = 30_000;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 60_000;
export const BACKOFF_JITTER = 0.25;
/** After close() the socket has this long to fire onclose; then the bridge treats it as closed. */
export const CLOSE_WATCHDOG_MS = 5_000;
export const QUIT_MESSAGE = "seance-crew shutting down";

/** Delay before reconnect attempt number `attempt` (0 = first retry): exponential, capped, plus up to 25 percent jitter. */
export function backoffDelay(attempt: number, random: () => number): number {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.round(base * (1 + Math.min(1, Math.max(0, random())) * BACKOFF_JITTER));
}

export interface BridgeOptions {
  readonly store: Store;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly createSocket?: SocketFactory;
  readonly random?: () => number;
  /** Called after every transition to `registered` (first connect and reconnects). */
  readonly onRegistered?: (bridge: IrcBridge) => void;
  /** Called when the connection ends, before any reconnect is scheduled. */
  readonly onDisconnected?: () => void;
  readonly dispatchHooks?: DispatchHooks;
}

export interface SendOptions {
  readonly priority?: Priority;
}

const AUTH_ERROR_TEXT = /authenticat|password|\bpass\b|access denied|not authorized/i;

export class IrcBridge {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly createSocket: SocketFactory;
  private readonly random: () => number;
  private readonly options: BridgeOptions;
  private readonly dispatcher: Dispatcher;

  private config: Config | null = null;
  private socket: SocketLike | undefined;
  private framer = new LineFramer();
  private queue: SendQueue | undefined;
  private registerTimer: unknown;
  private idleTimer: unknown;
  private graceTimer: unknown;
  private reconnectTimer: unknown;
  private closeTimer: unknown;
  private attempt = 0;
  private stopped = false;
  private restartAfterClose = false;
  private hooksSet: DispatchHooks;

  constructor(options: BridgeOptions) {
    this.options = options;
    this.store = options.store;
    this.clock = options.clock;
    this.logger = options.logger;
    this.createSocket = options.createSocket ?? createWebSocket;
    this.random = options.random ?? Math.random;
    this.hooksSet = options.dispatchHooks ?? {};
    this.dispatcher = createDispatcher(this.store, { requestWhois: (nick) => this.hooksSet.requestWhois?.(nick) }, this.logger);
  }

  get state(): BridgeState {
    return this.store.state;
  }

  get currentConfig(): Config | null {
    return this.config;
  }

  /** Install or replace the dispatch hooks (the WHOIS scheduler lives outside the client). */
  setDispatchHooks(hooks: DispatchHooks): void {
    this.hooksSet = hooks;
  }

  /** True while a socket exists that is not CLOSED. */
  get hasSocket(): boolean {
    return this.socket !== undefined && this.socket.readyState !== READY_STATE.CLOSED;
  }

  // ---- lifecycle ---------------------------------------------------------------------

  /** Start (or restart after a config change) with a complete config. Opens at most one socket. */
  start(config: Config): void {
    if (this.stopped || this.store.state === "duplicate-instance") return;
    this.logger.addSecret(config.secret);
    this.config = config;
    this.store.ownNick = config.nick;
    this.attempt = 0;
    this.clearReconnect();
    if (this.hasSocket) return;
    this.connect();
  }

  /**
   * Apply a (possibly changed) config. Reconnects when host, nick or secret changed, and leaves auth-failed or
   * unconfigured by connecting. A config that is identical to the running one is a no-op.
   */
  applyConfig(config: Config): void {
    if (this.stopped || this.store.state === "duplicate-instance") return;
    const current = this.config;
    const same = current !== null && current.host === config.host && current.nick === config.nick && current.secret === config.secret;
    // An identical config never triggers a reconnect, not even from auth-failed: that state waits for a change.
    if (same) return;
    this.logger.addSecret(config.secret);
    this.config = config;
    this.store.ownNick = config.nick;
    this.attempt = 0;
    this.clearReconnect();
    if (this.hasSocket) {
      // Reconnect as soon as the old socket is really closed (never two sockets at once).
      this.restartAfterClose = true;
      this.closeSocket(1000, "config changed");
      return;
    }
    this.connect();
  }

  /** Another instance holds the lock: never open a connection. */
  setDuplicateInstance(): void {
    this.store.setState("duplicate-instance");
  }

  /** The gateway delivered a config that failed validation (host, nick or secret): close the socket and wait. */
  setConfigInvalid(): void {
    this.config = null;
    this.restartAfterClose = false;
    this.clearReconnect();
    this.store.setState("config-invalid");
    this.closeSocket(1000, "config invalid");
  }

  /** Config removed or incomplete: close the socket and wait. */
  setUnconfigured(): void {
    this.config = null;
    this.restartAfterClose = false;
    this.clearReconnect();
    this.closeSocket(1000, "unconfigured");
    this.store.setState("unconfigured");
  }

  /** Shutdown: send QUIT, close, and never reconnect. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearReconnect();
    this.clearTimers();
    const socket = this.socket;
    if (socket !== undefined && socket.readyState === READY_STATE.OPEN) {
      try {
        const line = buildLine("QUIT", [QUIT_MESSAGE]);
        this.log("->", line);
        socket.send(line);
      } catch (err) {
        this.logger.warn("QUIT could not be sent", { error: err });
      }
      socket.close(1000, "shutdown");
    }
    this.queue?.clear();
  }

  // ---- sending ---------------------------------------------------------------------------

  /** Queue one validated line. Throws LineError. Rejected (not buffered) unless the bridge is registered. */
  send(command: string, params: readonly string[], options: SendOptions = {}): void {
    if (this.store.state !== "registered" || this.queue === undefined) {
      throw new LineError("not-registered", `the bridge is ${this.store.state}, not registered`);
    }
    this.queue.push(buildLine(command, params), options.priority ?? "normal");
  }

  // ---- connection --------------------------------------------------------------------------

  private connect(): void {
    const config = this.config;
    if (config === null || this.stopped || this.hasSocket) return;
    this.store.setState("connecting");
    this.framer = new LineFramer();
    let socket: SocketLike;
    try {
      socket = this.createSocket(`wss://${config.host}/ws`);
    } catch (err) {
      // Same path as a connection that closed right away: back off and try again.
      this.logger.error("the socket could not be created", { error: err });
      this.onClosed(undefined);
      return;
    }
    this.socket = socket;
    this.queue = new SendQueue({
      clock: this.clock,
      send: (line) => {
        if (socket.readyState !== READY_STATE.OPEN) return;
        this.log("->", line);
        socket.send(line);
      },
    });
    this.registerTimer = this.clock.setTimeout(() => {
      this.registerTimer = undefined;
      if (this.socket === socket && this.store.state !== "registered") {
        this.logger.warn("registration timed out", { afterMs: REGISTRATION_TIMEOUT_MS });
        this.beginClose(socket, 4000, "registration timeout");
      }
    }, REGISTRATION_TIMEOUT_MS);

    socket.onopen = () => {
      if (this.socket !== socket) return;
      try {
        const queue = this.queue;
        queue?.push(buildLine("PASS", [`${config.nick}:${config.secret}`]), "normal");
        queue?.push(buildLine("NICK", [config.nick]), "normal");
        queue?.push(buildLine("USER", [config.nick, "0", "*", "seance-crew"], { forceTrailing: true }), "normal");
      } catch (err) {
        this.logger.error("handshake could not be built", { error: err });
        this.beginClose(socket, 4001, "bad handshake");
      }
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.onFrame(event.data);
    };
    socket.onerror = (event) => {
      this.logger.warn("socket error", { event: describeError(event) });
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.onClosed(event.code);
    };
  }

  private onFrame(data: unknown): void {
    if (typeof data !== "string") {
      this.store.diagnostics.binaryFrames += 1;
      return;
    }
    for (const framed of this.framer.push(data)) {
      if (framed.kind === "overlong") {
        this.store.diagnostics.overlongLines += 1;
        continue;
      }
      const message = parse(framed.line);
      if (isParseError(message)) {
        this.store.diagnostics.droppedLines += 1;
        continue;
      }
      try {
        this.onLine(message, framed.line);
      } catch (err) {
        // Server input must never crash the process. Log the kind of failure only, never the line.
        this.store.diagnostics.droppedLines += 1;
        this.logger.warn("a line from the server could not be handled and was dropped", {
          command: message.command,
          error: err instanceof LineError ? `LineError:${err.code}` : err instanceof Error ? err.name : "unknown",
        });
      }
    }
  }

  private onLine(message: IrcMessage, raw: string): void {
    this.log("<-", raw);
    this.armIdle();
    switch (message.command) {
      case "PING": {
        // Urgent: bypasses the bucket.
        this.queue?.push(buildLine("PONG", [message.params[0] ?? ""]), "urgent");
        return;
      }
      case "001": {
        this.onRegistered(message);
        return;
      }
      case "464": {
        if (this.store.state === "registered") {
          this.logger.warn("ignoring 464 after registration");
          return;
        }
        this.onAuthFailed("the server rejected the credentials (464)");
        return;
      }
      case "432":
      case "433": {
        if (this.store.state === "registered") {
          this.dispatcher.handle(message);
          return;
        }
        this.onNickRejected(message.command);
        return;
      }
      case "ERROR": {
        if (this.store.state !== "registered" && AUTH_ERROR_TEXT.test(message.params.join(" "))) {
          this.onAuthFailed("the server closed the link with an authentication error");
        }
        return;
      }
      default:
        this.dispatcher.handle(message);
    }
  }

  private onRegistered(message: IrcMessage): void {
    if (this.registerTimer !== undefined) {
      this.clock.clearTimeout(this.registerTimer);
      this.registerTimer = undefined;
    }
    const confirmed = message.params[0];
    if (confirmed !== undefined && confirmed !== "" && confirmed !== "*") this.store.ownNick = confirmed;
    this.attempt = 0;
    this.store.setState("registered");
    this.armIdle();
    this.options.onRegistered?.(this);
  }

  private onAuthFailed(reason: string): void {
    if (this.store.state === "auth-failed") return;
    this.logger.error("authentication failed; not reconnecting until the config changes", { reason });
    this.clearReconnect();
    this.store.setState("auth-failed");
    this.closeSocket(1000, "auth failed");
  }

  /** 432/433 during registration: the nick is the account name, so this is a config problem, not a transient one. */
  private onNickRejected(numeric: string): void {
    if (this.store.state === "nick-rejected") return;
    this.logger.error("the server rejected the nick; not reconnecting until the config changes", { numeric });
    this.clearReconnect();
    this.store.setState("nick-rejected");
    this.closeSocket(1000, "nick rejected");
  }

  private onClosed(code: number | undefined): void {
    this.clearTimers();
    this.queue?.clear();
    this.queue = undefined;
    this.socket = undefined;
    this.dispatcher.reset();
    this.options.onDisconnected?.();
    if (this.stopped) return;
    if (this.restartAfterClose) {
      this.restartAfterClose = false;
      if (this.config !== null) {
        this.connect();
        return;
      }
    }
    const state = this.store.state;
    if (state === "auth-failed" || state === "nick-rejected" || state === "config-invalid" || state === "duplicate-instance" || state === "unconfigured") return;
    this.logger.info("connection closed", { code });
    this.store.setState("reconnecting");
    const delay = backoffDelay(this.attempt, this.random);
    this.attempt += 1;
    this.clearReconnect();
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  /** Re-arm the idle detection: PING after 120 s of silence, close after 30 more seconds. */
  private armIdle(): void {
    if (this.idleTimer !== undefined) this.clock.clearTimeout(this.idleTimer);
    if (this.graceTimer !== undefined) this.clock.clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    if (this.store.state !== "registered") return;
    const socket = this.socket;
    this.idleTimer = this.clock.setTimeout(() => {
      this.idleTimer = undefined;
      if (this.socket !== socket || socket === undefined) return;
      try {
        this.queue?.push(buildLine("PING", [this.config?.nick ?? "crew"]), "urgent");
      } catch (err) {
        this.logger.warn("idle PING failed", { error: err });
      }
      this.graceTimer = this.clock.setTimeout(() => {
        this.graceTimer = undefined;
        if (this.socket === socket) {
          this.logger.warn("no data from the server; reconnecting", { afterMs: IDLE_PING_AFTER_MS + IDLE_GRACE_MS });
          this.beginClose(socket, 4002, "idle timeout");
        }
      }, IDLE_GRACE_MS);
    }, IDLE_PING_AFTER_MS);
  }

  private closeSocket(code: number, reason: string): void {
    const socket = this.socket;
    if (socket !== undefined) this.beginClose(socket, code, reason);
  }

  /**
   * Close the socket and start the watchdog: if onclose has not fired after CLOSE_WATCHDOG_MS, detach the handlers
   * and continue as if it had, so a socket that never reports its close cannot wedge the bridge.
   */
  private beginClose(socket: SocketLike, code: number, reason: string): void {
    if (this.socket !== socket) return;
    if (socket.readyState !== READY_STATE.CLOSED && socket.readyState !== READY_STATE.CLOSING) {
      try {
        socket.close(code, reason);
      } catch (err) {
        this.logger.warn("socket close failed", { error: err });
      }
    }
    if (this.closeTimer !== undefined) return;
    this.closeTimer = this.clock.setTimeout(() => {
      this.closeTimer = undefined;
      if (this.socket !== socket) return;
      this.logger.warn("the socket did not report its close in time; treating it as closed", { afterMs: CLOSE_WATCHDOG_MS });
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      this.onClosed(undefined);
    }, CLOSE_WATCHDOG_MS);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== undefined) {
      this.clock.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private clearTimers(): void {
    for (const t of [this.registerTimer, this.idleTimer, this.graceTimer, this.closeTimer]) {
      if (t !== undefined) this.clock.clearTimeout(t);
    }
    this.closeTimer = undefined;
    this.registerTimer = undefined;
    this.idleTimer = undefined;
    this.graceTimer = undefined;
  }

  private log(direction: "->" | "<-", line: string): void {
    this.logger.debug(`${direction} ${line.replace(/\r?\n$/, "")}`);
  }
}

const describeError = (event: unknown): string => {
  if (typeof event === "object" && event !== null && "message" in event) return String((event as { message: unknown }).message);
  return "socket error";
};
