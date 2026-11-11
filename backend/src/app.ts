// Wires paths, lock, config, bridge and HTTP together. server.ts is the thin process entry around this.
import type http from "node:http";
import { createApiRoute } from "./api/routes.js";
import type { Clock } from "./clock.js";
import { loadConfig, type FetchLike } from "./config.js";
import { createConfigWatcher, type ConfigWatcher } from "./config-watch.js";
import { createCreditsSnapshot } from "./credits-snapshot.js";
import { closeServer, createHttpServer, listen, type Route } from "./http.js";
import type { IrcBridge } from "./irc/client.js";
import type { SocketFactory } from "./irc/socket.js";
import { createIrcBridge, type Rebuilder } from "./irc/rebuild.js";
import { Store } from "./irc/store.js";
import { acquireLock, type Lock, type LockDeps } from "./lock.js";
import type { Logger } from "./log.js";
import { createMcpRoute } from "./mcp/handler.js";
import { createToolRegistry } from "./mcp/tools.js";
import type { SummaryProvider } from "./mcp/types.js";
import { ensureDataDir, type AppPaths } from "./paths.js";
import { createSummaryService, type SummaryService } from "./summary.js";

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
  /** Replaces the built-in daily summary as the provider for the `credits` tool and GET /api/summary (tests). */
  readonly summary?: SummaryProvider;
  /**
   * Run the in-process background services: the credits snapshot (data/credits.json) and the daily summary
   * (data/summary.json). Off by default so tests that boot the app stay free of timers and files; server.ts turns it on.
   */
  readonly background?: boolean;
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
  /** The daily summary service; null unless `background` was set. */
  readonly summaryService: SummaryService | null;
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
  // Credits snapshot and daily summary run inside this process on the shared store and send queue: no cron, no second
  // process, no second connection. Seed the snapshot before the bridge connects so last known figures show at once.
  const snapshot = deps.background === true ? createCreditsSnapshot({ store, paths, clock, logger }) : null;
  const summaryService = deps.background === true ? createSummaryService({ store, bridge, paths, clock, logger }) : null;
  snapshot?.load();
  // One provider for both surfaces (GET /api/summary and the `credits` tool), so they always agree.
  const summaryProvider: SummaryProvider | undefined = deps.summary ?? summaryService ?? undefined;

  // /mcp needs the live port for its Host check, which is known only after listen.
  let listenPort = 0;
  const registry = createToolRegistry({ store, bridge, clock, logger, ...(summaryProvider === undefined ? {} : { summary: summaryProvider }) });
  const mcpRoute = createMcpRoute({ port: () => listenPort, gatewayOrigin: deps.env["KIROCREW_GATEWAY_ORIGIN"], registry, logger });
  // /api/* shares the registry (and so the rate limits and channel locks) with /mcp; it is closed without a proxy secret.
  const apiRoute = createApiRoute({
    port: () => listenPort,
    gatewayOrigin: deps.env["KIROCREW_GATEWAY_ORIGIN"],
    proxySecret: () => deps.env["KIROCREW_PROXY_SECRET"],
    store,
    bridge,
    registry,
    now: () => clock.now(),
    ...(summaryProvider === undefined ? {} : { summary: summaryProvider }),
  });
  const server = createHttpServer({ logger, routes: [mcpRoute, apiRoute, ...(deps.routes ?? [])] });
  let port: number;
  try {
    port = await listen(server, deps.port);
    listenPort = port;
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
  // A duplicate instance (no lock) must not touch the data files the real instance owns.
  if (lock !== null) {
    snapshot?.start();
    summaryService?.start();
  }

  return {
    server,
    port,
    store,
    bridge,
    rebuilder,
    lock,
    watcher,
    summaryService,
    stop: async () => {
      if (sweepTimer !== undefined) clock.clearTimeout(sweepTimer);
      sweepTimer = undefined;
      // Stop the timer first so no run starts during shutdown; the snapshot writes once more if a change is waiting.
      summaryService?.stop();
      snapshot?.stop();
      watcher?.stop();
      bridge.stop();
      await closeServer(server);
      lock?.release();
    },
  };
}
