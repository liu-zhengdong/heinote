import { backup, DatabaseSync } from "node:sqlite";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/* Shared online-snapshot helpers (UC-31). Plain JS so both the tsx server
   and the plain-node `scripts/backup.mjs` use the same implementation.
   Staging + rename keeps the published snapshot atomic: a reader either
   sees the complete directory or nothing. */

/** Create a private staging directory inside `parentDir`; callers fill it,
 *  then `finalize` renames it to the published name. */
export function stagedDirectory(parentDir) {
  const dir = mkdtempSync(join(parentDir, ".notes-backup-"));
  return {
    dir,
    /** Atomically publish the staging dir as `name` inside parentDir. */
    finalize(name) {
      const target = join(parentDir, name);
      renameSync(dir, target);
      return target;
    },
    /** Remove the staging dir when not finalized; safe to call always. */
    cleanup() {
      if (dirname(dir) !== parentDir || !basename(dir).startsWith(".notes-backup-")) {
        throw new Error(`Unexpected backup staging path: ${dir}`);
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Online SQLite backup of `databasePath` into `<stagingDir>/notes.sqlite`. */
export async function snapshotDatabaseFile(databasePath, stagingDir) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    await backup(database, join(stagingDir, "notes.sqlite"));
  } finally {
    database.close();
  }
}
