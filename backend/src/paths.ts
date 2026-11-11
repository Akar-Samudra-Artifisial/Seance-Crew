// App paths. The only module that looks at import.meta.url; everything else receives AppPaths.
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AppPaths {
  readonly root: string;
  readonly data: string;
  readonly secretFile: string;
  readonly lockFile: string;
  readonly creditsFile: string;
  readonly summaryFile: string;
}

export class AppRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppRootError";
  }
}

/**
 * Walk up from the directory of `importMetaUrl` to the first directory that contains `app.json`.
 * Installed: `<app>/backend/dist/server.js` gives `<app>`. Development: `backend/src/*.ts` gives the repository root.
 * Never reads process.cwd() or the environment.
 */
export function resolveAppRoot(
  importMetaUrl: string,
  exists: (file: string) => boolean = existsSync,
): string {
  const start = path.dirname(fileURLToPath(importMetaUrl));
  let dir = start;
  for (;;) {
    if (exists(path.join(dir, "app.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new AppRootError(`app.json not found while walking up from ${start}`);
    }
    dir = parent;
  }
}

export function appPaths(root: string): AppPaths {
  const data = path.join(root, "data");
  return {
    root,
    data,
    secretFile: path.join(root, ".app_secret"),
    lockFile: path.join(data, "bridge.lock"),
    creditsFile: path.join(data, "credits.json"),
    summaryFile: path.join(data, "summary.json"),
  };
}

/** Create `<appRoot>/data` with mode 700 when missing (and tighten an existing one). */
export function ensureDataDir(paths: AppPaths): void {
  mkdirSync(paths.data, { recursive: true, mode: 0o700 });
  chmodSync(paths.data, 0o700);
}
