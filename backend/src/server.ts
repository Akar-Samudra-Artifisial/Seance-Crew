// Backend entry point: the single process of the Séance Crew app.
import { readFile } from "node:fs/promises";
import { startApp, type RunningApp } from "./app.js";
import { systemClock } from "./clock.js";
import { registerLockRelease } from "./lock.js";
import { createLogger, parseLogLevel } from "./log.js";
import { AppRootError, appPaths, resolveAppRoot } from "./paths.js";
import { parsePort, PortError } from "./port.js";

const logger = createLogger([], undefined, undefined, parseLogLevel(process.env["SEANCE_CREW_LOG_LEVEL"]));

let app: RunningApp | undefined;
let stopping = false;
let pendingSignal: string | undefined;

/** Log the failure (name and message only, redacted), release the lock and exit with code 1. */
const fatal = (what: string, err: unknown): void => {
  try {
    logger.error(what, { error: err });
  } catch {
    // Nothing else can be done; still exit below.
  }
  try {
    app?.lock?.release();
  } catch {
    // The lock file may already be gone.
  }
  process.exit(1);
};

const shutdown = (signal: string): void => {
  if (stopping) return;
  if (app === undefined) {
    // Still starting: finish startup first, then stop (see main).
    pendingSignal = signal;
    return;
  }
  stopping = true;
  logger.info("shutting down", { signal });
  app
    .stop()
    .then(
      () => 0,
      (err: unknown) => {
        logger.error("shutdown failed", { error: err });
        app?.lock?.release();
        return 1;
      },
    )
    .then((code) => {
      // Give the QUIT line a moment to leave before the process ends.
      setTimeout(() => process.exit(code), 200);
    });
};

// Handlers go in before anything starts, so no failure or signal can skip the lock release.
process.on("uncaughtException", (err) => fatal("uncaught exception", err));
process.on("unhandledRejection", (reason) => fatal("unhandled rejection", reason));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => shutdown(signal));

async function main(): Promise<void> {
  let port: number;
  let root: string;
  try {
    port = parsePort(process.env);
    root = resolveAppRoot(import.meta.url);
  } catch (err) {
    if (err instanceof PortError || err instanceof AppRootError) {
      process.stderr.write(`seance-crew: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  app = await startApp({
    paths: appPaths(root),
    env: process.env,
    port,
    clock: systemClock,
    logger,
    fetch: (url, init) => fetch(url, init),
    readFile: (file) => readFile(file, "utf8"),
  });
  if (app.lock !== null) registerLockRelease(app.lock);
  if (pendingSignal !== undefined) shutdown(pendingSignal);
}

main().catch((err: unknown) => {
  fatal("fatal error while starting", err);
});
