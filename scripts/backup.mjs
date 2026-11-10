import { DatabaseSync, backup } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { cp } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

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
const staging = mkdtempSync(join(dirname(destination), ".notes-backup-"));
try {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try { await backup(database, join(staging, "notes.sqlite")); }
  finally { database.close(); }
  // Files commit before their index and remain immutable. Copy after the database snapshot.
  await cp(attachments, join(staging, "attachments"), {
    recursive: true,
    filter: (path) => !basename(path).endsWith(".tmp"),
  });
  checkDestination(destination);
  renameSync(staging, destination);
  console.log(`Backup: ${destination}`);
} finally {
  // Only remove the private staging directory created by this invocation.
  if (dirname(staging) !== dirname(destination) || !basename(staging).startsWith(".notes-backup-")) throw new Error("Unexpected backup staging path.");
  rmSync(staging, { recursive: true, force: true });
}
