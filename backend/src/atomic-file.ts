// Atomic, private file writes for the files under data/: temp file in the same directory, then rename.
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";

/**
 * Write `text` to `file` so a reader sees either the old or the new content, never a partial file. Mode 600.
 * The temp file is created exclusively (flag "wx", so it never follows or reuses an existing path), flushed to disk
 * before the rename, and removed again when anything fails. Its name has a random suffix, not only the pid.
 */
export function writeFileAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    }
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing more to clean up.
    }
    throw err;
  }
}
