// Wires paths, lock, config, bridge and HTTP together. server.ts is the thin process entry around this.
import type http from "node:http";
import type { Clock } from "./clock.js";
import { loadConfig, type FetchLike } from "./config.js";
import { createConfigWatcher, type ConfigWatcher } from "./config-watch.js";
import { closeServer, createHttpServer, listen, type Route } from "./http.js";
import type { IrcBridge } from "./irc/client.js";
import type { SocketFactory } from "./irc/socket.js";
import { createIrcBridge, type Rebuilder } from "./irc/rebuild.js";
import { Store } from "./irc/store.js";
import { acquireLock, type Lock, type LockDeps } from "./lock.js";
import type { Logger } from "./log.js";
import { ensureDataDir, type AppPaths } from "./paths.js";

export const SWEEP_INTERVAL_MS = 60_000;

export interface AppDeps {
  readonly paths: AppPaths;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly port: number;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly fetch: FetchLike;
  readonly readFile: (file: string) => Promise<string>;
  readonly createSocket?: SocketFactory;
  readonly lockDeps?: LockDeps;
  readonly routes?: readonly Route[];
  readonly random?: () => number;
}

export interface RunningApp {
  readonly server: http.Server;
  readonly port: number;
  readonly store: Store;
  readonly bridge: IrcBridge;
  readonly rebuilder: Rebuilder;
  readonly lock: Lock | null;
  readonly watcher: ConfigWatcher | null;
  stop(): Promise<void>;
}

export async function startApp(deps: AppDeps): Promise<RunningApp> {
  const { paths, logger, clock } = deps;
  ensureDataDir(paths);

  const store = new Store(clock);
  const { bridge, rebuilder } = createIrcBridge({
    store,
    clock,
    logger,
    ...(deps.createSocket === undefined ? {} : { createSocket: deps.createSocket }),
    ...(deps.random === undefined ? {} : { random: deps.random }),
  });

  const lockResult = acquireLock(paths, deps.lockDeps);
  const lock = lockResult.kind === "acquired" ? lockResult.lock : null;
  if (lockResult.kind === "duplicate") {
    logger.warn("another instance holds data/bridge.lock; not connecting to the server", { holderPid: lockResult.holder?.pid });
    bridge.setDuplicateInstance();
  }

  // One info line per state change (no credentials in it); /health itself never carries the state.
  store.on("state", (event) => logger.info("bridge state", { state: event.state }));
  const server = createHttpServer({ logger, ...(deps.routes === undefined ? {} : { routes: deps.routes }) });
  let port: number;
  try {
    port = await listen(server, deps.port);
  } catch (err) {
    // The process is about to fail: do not leave a lock behind that blocks the next start.
    lock?.release();
    throw err;
  }
  lock?.setPort(port);
  // Req 8.4: forget channels left 10 minutes ago even when no LIST ever runs. The clock's timers are unref'd.
  let sweepTimer: unknown;
  const scheduleSweep = (): void => {
    sweepTimer = clock.setTimeout(() => {
      store.sweep();
      scheduleSweep();
    }, SWEEP_INTERVAL_MS);
  };
  scheduleSweep();
  logger.info("seance-crew backend listening", { port });

  let watcher: ConfigWatcher | null = null;
  if (lock !== null) {
    watcher = createConfigWatcher({
      load: () => loadConfig({ paths, env: deps.env, fetch: deps.fetch, readFile: deps.readFile }),
      bridge,
      clock,
      logger,
    });
    await watcher.start();
  }

  return {
    server,
    port,
    store,
    bridge,
    rebuilder,
    lock,
    watcher,
    stop: async () => {
      if (sweepTimer !== undefined) clock.clearTimeout(sweepTimer);
      sweepTimer = undefined;
      watcher?.stop();
      bridge.stop();
      await closeServer(server);
      lock?.release();
    },
  };
}
