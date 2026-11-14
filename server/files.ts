import { createHash, randomUUID } from "node:crypto";
import { closeSync, createReadStream, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

// This module owns both the attachment index and its immutable files.
export class FileStore {
  private readonly directory: string;

  constructor(private readonly db: DatabaseSync, dataDir: string) {
    this.directory = resolve(dataDir, "attachments");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.db.exec("CREATE TABLE IF NOT EXISTS files(scope TEXT NOT NULL, path TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(scope,path))");
  }

  // Calls remain synchronous until the index commits. Different bytes cannot win the same path.
  private batched = false;
  private pending: Array<{ scope: string; path: string; type: string; size: number; hash: string }> = [];
  private pendingKeys = new Map<string, string>();
  private touchedDirs = new Set<string>();
  private checkStmt?: ReturnType<DatabaseSync["prepare"]>;
  private insertStmt?: ReturnType<DatabaseSync["prepare"]>;

  /** Import-scale writes: defer the per-file directory fsyncs and index
      rows to endBatch, which fsyncs each touched shard once and commits
      all index rows in one transaction. Bytes still fsync before any
      index row can name them. */
  beginBatch(): void { this.batched = true; }
  endBatch(): void {
    if (!this.batched) return;
    this.batched = false;
    try {
      for (const folder of [...this.touchedDirs, this.directory]) {
        const descriptor = openSync(folder, "r");
        try { fsyncSync(descriptor); }
        finally { closeSync(descriptor); }
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of this.pending)
          (this.insertStmt ??= this.db.prepare("INSERT INTO files(scope,path,type,size,hash) VALUES(?,?,?,?,?)")).run(row.scope, row.path, row.type, row.size, row.hash);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    } finally {
      this.pending = [];
      this.pendingKeys.clear();
      this.touchedDirs.clear();
    }
  }

  write(scope: string, path: string, type: string, bytes: Buffer): boolean {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const known = (this.checkStmt ??= this.db.prepare("SELECT hash FROM files WHERE scope=? AND path=?")).get(scope, path);
    if (known && known.hash !== hash) return false;
    // Rows queued this batch are invisible to SELECT; consult the queue too
    // so two entries sanitized to the same path still conflict properly.
    const queued = this.pendingKeys.get(`${scope}\0${path}`);
    if (queued !== undefined) return queued === hash;
    const directory = join(this.directory, hash.slice(0, 2));
    const destination = join(directory, hash);
    if (!existsSync(destination)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      try {
        const descriptor = openSync(temporary, "wx", 0o600);
        try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); }
        finally { closeSync(descriptor); }
        renameSync(temporary, destination);
        if (this.batched) {
          // endBatch persists these directories before any index row.
          this.touchedDirs.add(directory);
        } else {
          // Persist the rename and its shard directory before recording a reference.
          for (const folder of [directory, this.directory]) {
            const descriptor = openSync(folder, "r");
            try { fsyncSync(descriptor); }
            finally { closeSync(descriptor); }
          }
        }
      } finally {
        rmSync(temporary, { force: true });
      }
    }
    if (known) return true;
    if (this.batched) { this.pending.push({ scope, path, type, size: bytes.length, hash }); this.pendingKeys.set(`${scope}\0${path}`, hash); }
    else (this.insertStmt ??= this.db.prepare("INSERT INTO files(scope,path,type,size,hash) VALUES(?,?,?,?,?)")).run(scope, path, type, bytes.length, hash);
    return true;
  }

  read(scope: string, path: string) {
    const row = this.db.prepare("SELECT type,size,hash FROM files WHERE scope=? AND path=?").get(scope, path);
    if (!row) return;
    const hash = String(row.hash);
    const location = join(this.directory, hash.slice(0, 2), hash);
    let descriptor: number;
    try { descriptor = openSync(location, "r"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    return { type: String(row.type), size: Number(row.size), stream: createReadStream(location, { fd: descriptor }) };
  }
}
