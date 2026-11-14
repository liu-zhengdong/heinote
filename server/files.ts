import { createHash, randomUUID } from "node:crypto";
import { closeSync, createReadStream, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

// This module owns both the attachment index and its immutable files.
export class FileStore {
  private readonly directory: string;

  constructor(private readonly db: DatabaseSync, dataDir: string) {
    this.directory = resolve(dataDir, "attachments");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.db.exec("CREATE TABLE IF NOT EXISTS files(scope TEXT NOT NULL, path TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(scope,path))");
    this.reconcileOrphans();
  }

  /** Bytes without an index row can never be read. Index rows now commit
      inside the records transaction, so only a crash (or an older version)
      leaves these; clean them plus any interrupted temporaries. */
  private reconcileOrphans(): void {
    let indexed: Set<string> | undefined;
    let removed = 0;
    for (const shard of readdirSync(this.directory, { withFileTypes: true })) {
      if (!shard.isDirectory() || shard.name.length !== 2) continue;
      const folder = join(this.directory, shard.name);
      for (const name of readdirSync(folder)) {
        if (name.startsWith(".")) { rmSync(join(folder, name), { force: true }); continue; }
        indexed ??= new Set((this.db.prepare("SELECT DISTINCT hash FROM files").all() as Array<{ hash: unknown }>).map((row) => String(row.hash)));
        if (!indexed.has(name)) { rmSync(join(folder, name), { force: true }); removed += 1; }
      }
    }
    if (removed) console.warn(`files: 回收了 ${removed} 个无索引的附件文件`);
  }

  // Calls remain synchronous until the index commits. Different bytes cannot win the same path.
  private batched = false;
  private pending: Array<{ scope: string; path: string; type: string; size: number; hash: string }> = [];
  private pendingKeys = new Map<string, string>();
  private touchedDirs = new Set<string>();
  /** Blobs written this batch, hash → file, so abortBatch can reclaim the
      bytes the rolled-back index no longer names. */
  private newBlobs = new Map<string, string>();
  private checkStmt?: ReturnType<DatabaseSync["prepare"]>;
  private insertStmt?: ReturnType<DatabaseSync["prepare"]>;

  /** Import-scale writes: defer the per-file directory fsyncs and index
      rows. commitBatch runs inside the records transaction so an index
      row can never outlive the content it names. */
  beginBatch(): void { this.batched = true; this.newBlobs.clear(); }

  /** Fsync the touched shards, then insert all deferred index rows.
      Import calls this inside the records transaction; the fsyncs keep
      the bytes durable before the commit can name them. */
  commitBatch(): void {
    if (!this.batched) return;
    this.batched = false;
    try {
      for (const folder of [...this.touchedDirs, this.directory]) {
        const descriptor = openSync(folder, "r");
        try { fsyncSync(descriptor); }
        finally { closeSync(descriptor); }
      }
      for (const row of this.pending)
        (this.insertStmt ??= this.db.prepare("INSERT INTO files(scope,path,type,size,hash) VALUES(?,?,?,?,?)")).run(row.scope, row.path, row.type, row.size, row.hash);
    } finally {
      this.pending = [];
      this.pendingKeys.clear();
      this.touchedDirs.clear();
      // newBlobs stays: if the surrounding transaction still rolls back,
      // abortBatch reclaims these bytes.
    }
  }

  /** The batch failed: drop queued index rows and delete this batch's
      bytes that no surviving index row references. Idempotent. */
  abortBatch(): void {
    if (!this.newBlobs.size && !this.pending.length) { this.batched = false; return; }
    this.batched = false;
    const indexed = new Set((this.db.prepare("SELECT DISTINCT hash FROM files").all() as Array<{ hash: unknown }>).map((row) => String(row.hash)));
    let removed = 0;
    try {
      for (const [hash, file] of this.newBlobs) {
        if (indexed.has(hash)) continue;
        rmSync(file, { force: true });
        removed += 1;
      }
    } finally {
      this.pending = [];
      this.pendingKeys.clear();
      this.touchedDirs.clear();
      this.newBlobs.clear();
    }
    if (removed) console.warn(`files: 回收了 ${removed} 个未入索引的附件文件`);
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
          // commitBatch persists these directories before any index row.
          this.touchedDirs.add(directory);
          this.newBlobs.set(hash, destination);
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
