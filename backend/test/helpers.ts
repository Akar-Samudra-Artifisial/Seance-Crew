import { IrcBridge } from "../src/irc/client.js";
import { createIrcBridge } from "../src/irc/rebuild.js";
import { Store } from "../src/irc/store.js";
import { createLogger, type LogLevel } from "../src/log.js";
import type { SocketLike } from "../src/irc/socket.js";
import { FakeClock } from "./fakeClock.js";
import { FakeIrcd } from "./fakeIrcd.js";

export interface MakeBridgeOptions {
  readonly random?: () => number;
  readonly onRegistered?: (b: IrcBridge) => void;
  /** Wire the state rebuild (LIST, NAMES, WHOIS) after registration. Off by default so low-level tests see only their own lines. */
  readonly rebuild?: boolean;
  /** Logger minimum level; tests default to debug so they can see the line trace. */
  readonly logLevel?: LogLevel;
  /** Replace the socket factory (for example to wrap or break the fake socket). */
  readonly createSocket?: (url: string, ircd: FakeIrcd) => SocketLike;
}

export const makeBridge = (opts: MakeBridgeOptions = {}) => {
  const clock = new FakeClock();
  const store = new Store(clock);
  const ircd = new FakeIrcd();
  const logs: string[] = [];
  const logger = createLogger([], (l) => logs.push(l), () => clock.now(), opts.logLevel ?? "debug");
  const base = {
    store,
    clock,
    logger,
    createSocket: (url: string): SocketLike => (opts.createSocket === undefined ? ircd.connect(url) : opts.createSocket(url, ircd)),
    random: opts.random ?? (() => 0),
  };
  let bridge: IrcBridge;
  let rebuilder: ReturnType<typeof createIrcBridge>["rebuilder"] | undefined;
  if (opts.rebuild === true) {
    const created = createIrcBridge(base);
    bridge = created.bridge;
    rebuilder = created.rebuilder;
  } else {
    bridge = new IrcBridge({ ...base, ...(opts.onRegistered === undefined ? {} : { onRegistered: opts.onRegistered }) });
  }
  const states: string[] = [];
  store.on("state", (e) => states.push(e.state));
  /** Advance time in 500 ms steps, letting the in-process network settle after each step. */
  const advance = (ms: number): void => {
    for (let left = ms; left > 0; left -= 500) {
      clock.advance(Math.min(500, left));
      ircd.run();
    }
  };
  return { clock, store, ircd, logs, bridge, rebuilder, states, advance };
};
