import { existsSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { cp } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { snapshotDatabaseFile, stagedDirectory } from "../server/snapshot.mjs";

const source = realpathSync(resolve(process.env.DATA_DIR ?? "data"));
const databasePath = join(source, "notes.sqlite");
if (!existsSync(databasePath)) throw new Error(`Database does not exist: ${databasePath}`);
const attachments = realpathSync(join(source, "attachments"));
const requested = resolve(process.argv[2] ?? `backups/notes-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const checkDestination = (destination) => {
  if (existsSync(destination)) throw new Error(`Backup already exists: ${destination}`);
  if (destination === attachments || destination.startsWith(`${attachments}${sep}`)) throw new Error("Backup cannot be inside the attachment directory.");
};
checkDestination(requested);
mkdirSync(dirname(requested), { recursive: true, mode: 0o700 });
// Resolve the parent too, so a symlink cannot place a backup inside attachments.
const destination = join(realpathSync(dirname(requested)), basename(requested));
checkDestination(destination);
const staging = stagedDirectory(dirname(destination));
try {
  await snapshotDatabaseFile(databasePath, staging.dir);
  // Files commit before their index and remain immutable. Copy after the database snapshot.
  await cp(attachments, join(staging.dir, "attachments"), {
    recursive: true,
    filter: (path) => !basename(path).endsWith(".tmp"),
  });
  checkDestination(destination);
  staging.finalize(basename(destination));
  console.log(`Backup: ${destination}`);
} finally {
  staging.cleanup();
}
