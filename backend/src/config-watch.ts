// Polls the app config through the gateway: connects when a secret appears, reconnects when it changes.
import type { Clock } from "./clock.js";
import { ConfigError, type ConfigResult } from "./config.js";
import type { IrcBridge } from "./irc/client.js";
import type { Logger } from "./log.js";

export const CONFIG_POLL_MS = 30_000;

export interface ConfigWatcher {
  /** Do the first load (awaited) and start polling. */
  readonly start: () => Promise<void>;
  readonly stop: () => void;
  /** Run one poll now. Resolves when it is finished. */
  readonly poll: () => Promise<void>;
}

export interface ConfigWatcherDeps {
  readonly load: () => Promise<ConfigResult>;
  readonly bridge: IrcBridge;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly intervalMs?: number;
}

export function createConfigWatcher(deps: ConfigWatcherDeps): ConfigWatcher {
  const { load, bridge, clock, logger } = deps;
  const interval = deps.intervalMs ?? CONFIG_POLL_MS;
  let timer: unknown;
  let stopped = false;
  let polling: Promise<void> | undefined;
  let lastProblem = "";
  let announcedUnconfigured = false;

  const run = async (): Promise<void> => {
    try {
      const result = await load();
      logger.addSecret(result.appSecret);
      logger.addSecret(result.token);
      lastProblem = "";
      if (stopped) return;
      if (result.kind === "ok") {
        announcedUnconfigured = false;
        bridge.applyConfig(result.config);
      } else {
        if (bridge.currentConfig !== null) {
          logger.warn("the Séance secret was removed from the config; disconnecting");
          bridge.setUnconfigured();
        }
        if (!announcedUnconfigured) {
          announcedUnconfigured = true;
          logger.warn("no Séance secret is configured; open the app settings and set host, nick and secret");
        }
      }
    } catch (err) {
      // A gateway hiccup must not drop a working connection. Log each distinct problem once.
      const message = err instanceof ConfigError ? err.message : "configuration could not be loaded";
      // A config that arrived but is invalid is different: stop connecting with the old values and wait for a fix.
      if (err instanceof ConfigError && err.step === "validate" && !stopped) bridge.setConfigInvalid();
      if (message !== lastProblem) {
        lastProblem = message;
        logger.error(message);
      }
    }
  };

  const poll = (): Promise<void> => {
    polling ??= run().finally(() => {
      polling = undefined;
    });
    return polling;
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = clock.setTimeout(() => {
      timer = undefined;
      void poll().finally(schedule);
    }, interval);
  };

  return {
    start: async () => {
      await poll();
      schedule();
    },
    stop: () => {
      stopped = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
    },
    poll,
  };
}
