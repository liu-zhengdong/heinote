import type { Store } from "./store.ts";

const DEFAULT_FILE_GRACE_MS = 10 * 60_000;
const DEFAULT_REQUEST_TTL_MS = 7 * 86_400_000;
const DEFAULT_MAX_TOMBSTONES = 2000;
const DEFAULT_INTERVAL_MS = 30 * 60_000;

const PATH_LITERAL = /"(?:path|preview)":"((?:\\.|[^"\\])*)"/g;

function extractFilePaths(jsonText: string, out: Set<string>): void {
  PATH_LITERAL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PATH_LITERAL.exec(jsonText)) !== null) {
    const raw = match[1];
    try {
      const decoded = raw.includes("\\") ? (JSON.parse(`"${raw}"`) as string) : raw;
      if (decoded) out.add(decoded);
    } catch {
      if (raw) out.add(raw);
    }
  }
}

export interface FileSweepResult {
  removedRows: number;
  removedBlobs: number;
}

export interface MaintenanceSummary {
  files: FileSweepResult;
  prunedRequests: number;
  compactedTombstones: number;
}

/**
 * Low-priority background storage and metadata housekeeping (UC-59):
 * 1. Reclaims unreferenced `files` index rows and on-disk attachment blobs
 *    older than the grace period (never touching in-flight uploads, active
 *    avatars, cross-scope links, or version snapshot references).
 * 2. Prunes expired `requests` idempotency records past TTL.
 * 3. Compacts excess `record_changes` deletion tombstones while advancing
 *    `record_seq.pruned_before` so stale clients cleanly re-pull (`reset: true`).
 */
export class MaintenanceManager {
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private pausedCheck?: () => boolean;

  constructor(
    private readonly store: Store,
    options: { intervalMs?: number } = {},
  ) {
    this.intervalMs = Math.max(1000, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  setPaused(check: () => boolean): void {
    this.pausedCheck = check;
  }

  start(): void {
    this.stopped = false;
    this.schedule(this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Trigger a deferred housekeeping pass (e.g. shortly after a purge drains). */
  scheduleSoon(delayMs = 5000): void {
    if (this.stopped || !this.store.db.isOpen) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.schedule(delayMs);
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.timer || !this.store.db.isOpen) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopped || !this.store.db.isOpen) return;
      if (this.pausedCheck?.() || this.store.inTransaction) {
        this.schedule(10_000);
        return;
      }
      try {
        this.runOnce();
      } catch (error) {
        if (!this.store.db.isOpen) return;
        console.error("maintenance: 后台回收任务失败", error);
      }
      if (!this.stopped) this.schedule(this.intervalMs);
    }, delayMs);
    this.timer.unref();
  }

  /** Reclaim unreferenced `files` rows older than `graceMs` and any on-disk
   *  blobs whose hash is no longer referenced by any remaining `files` row. */
  sweepFiles(options: { graceMs?: number; batchSize?: number } = {}): FileSweepResult {
    if (this.stopped || !this.store.db.isOpen || this.store.inTransaction) return { removedRows: 0, removedBlobs: 0 };
    const graceMs = Math.max(0, options.graceMs ?? DEFAULT_FILE_GRACE_MS);
    const batchSize = Math.max(1, options.batchSize ?? 200);
    const cutoff = new Date(Date.now() - graceMs).toISOString();

    const candidates = this.store.all(
      "SELECT scope, path, hash FROM files WHERE created_at IS NULL OR created_at <= ?",
      cutoff,
    ).map((row) => ({ scope: String(row.scope), path: String(row.path), hash: String(row.hash) }));
    if (!candidates.length) return { removedRows: 0, removedBlobs: 0 };

    // Active avatars are keyed by `(avatar:<userId>, path)`.
    const activeAvatars = new Set<string>();
    const hasAvatars = Boolean(this.store.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='avatars'"));
    if (hasAvatars) {
      for (const row of this.store.all("SELECT user_id, path FROM avatars")) {
        activeAvatars.add(`avatar:${String(row.user_id)}\0${String(row.path)}`);
      }
    }

    // Global path scan across all pages, blocks, and reassembled version
    // snapshots so cross-scope links and history snapshots are never broken.
    const referencedPaths = new Set<string>();
    let lastRowId = 0;
    while (true) {
      const chunk = this.store.all(
        "SELECT rowid, value FROM records WHERE rowid > ? AND collection IN ('pages','blocks') ORDER BY rowid ASC LIMIT 500",
        lastRowId,
      );
      if (!chunk.length) break;
      for (const row of chunk) {
        lastRowId = Number(row.rowid);
        extractFilePaths(String(row.value), referencedPaths);
      }
    }

    // Reassemble multi-part version payloads in PK order so even paths spanning
    // a 12KB part boundary or escaped inside `payload` are captured accurately.
    const versionGroups = new Map<string, Array<{ part: number; payload: string }>>();
    let lastVerRowId = 0;
    while (true) {
      const chunk = this.store.all(
        "SELECT rowid, scope, value FROM records WHERE rowid > ? AND collection='versions' ORDER BY rowid ASC LIMIT 500",
        lastVerRowId,
      );
      if (!chunk.length) break;
      for (const row of chunk) {
        lastVerRowId = Number(row.rowid);
        try {
          const parsed = JSON.parse(String(row.value)) as { page?: string; version?: string; generation?: string; part?: number; payload?: string };
          if (typeof parsed.payload !== "string") continue;
          const key = `${String(row.scope)}\0${parsed.page ?? ""}\0${parsed.version ?? ""}\0${parsed.generation ?? ""}`;
          const list = versionGroups.get(key);
          if (list) list.push({ part: Number(parsed.part ?? 0), payload: parsed.payload });
          else versionGroups.set(key, [{ part: Number(parsed.part ?? 0), payload: parsed.payload }]);
        } catch {
          extractFilePaths(String(row.value), referencedPaths);
        }
      }
    }
    for (const parts of versionGroups.values()) {
      parts.sort((a, b) => a.part - b.part);
      extractFilePaths(parts.map((entry) => entry.payload).join(""), referencedPaths);
    }

    const dead = candidates.filter((item) => {
      if (item.scope.startsWith("avatar:")) return !activeAvatars.has(`${item.scope}\0${item.path}`);
      return !referencedPaths.has(item.path);
    });
    if (!dead.length) return { removedRows: 0, removedBlobs: 0 };

    let removedRows = 0;
    const touchedHashes = new Set<string>();
    for (let i = 0; i < dead.length; i += batchSize) {
      const slice = dead.slice(i, i + batchSize);
      this.store.db.exec("BEGIN IMMEDIATE");
      try {
        const del = this.store.db.prepare("DELETE FROM files WHERE scope=? AND path=? AND (created_at IS NULL OR created_at <= ?)");
        for (const item of slice) {
          const info = del.run(item.scope, item.path, cutoff);
          if (Number(info.changes) > 0) {
            removedRows += Number(info.changes);
            touchedHashes.add(item.hash);
          }
        }
        this.store.db.exec("COMMIT");
      } catch (error) {
        try { this.store.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
        throw error;
      }
    }

    let removedBlobs = 0;
    for (const hash of touchedHashes) {
      if (this.store.files.unlinkIfUnreferenced(hash)) removedBlobs += 1;
    }
    return { removedRows, removedBlobs };
  }

  /** Prune expired `requests` idempotency cache entries in bounded batches. */
  pruneRequests(options: { ttlMs?: number; limit?: number } = {}): number {
    if (this.stopped || !this.store.db.isOpen || this.store.inTransaction) return 0;
    const ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_REQUEST_TTL_MS);
    const limit = Math.max(1, options.limit ?? 500);
    const cutoff = new Date(Date.now() - ttlMs).toISOString();
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const info = this.store.db.prepare(
        "DELETE FROM requests WHERE rowid IN (SELECT rowid FROM requests WHERE created_at IS NOT NULL AND created_at <= ? LIMIT ?)",
      ).run(cutoff, limit);
      this.store.db.exec("COMMIT");
      return Number(info.changes);
    } catch (error) {
      try { this.store.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
  }

  /** Compact excess `record_changes` deletion tombstones and advance
   *  `record_seq.pruned_before` so older client watermarks trigger `reset: true`. */
  compactTombstones(options: { maxTombstones?: number; batchSize?: number } = {}): number {
    if (this.stopped || !this.store.db.isOpen || this.store.inTransaction) return 0;
    const maxTombstones = Math.max(0, options.maxTombstones ?? DEFAULT_MAX_TOMBSTONES);
    const batchSize = Math.max(1, options.batchSize ?? 500);

    const overflowing = this.store.all(
      "SELECT scope, collection, count(*) AS n FROM record_changes WHERE deleted=1 GROUP BY scope, collection HAVING n > ?",
      maxTombstones,
    );
    let totalCompacted = 0;
    for (const row of overflowing) {
      const scope = String(row.scope);
      const collection = String(row.collection);
      let excess = Number(row.n) - maxTombstones;
      while (excess > 0) {
        const take = Math.min(excess, batchSize);
        this.store.db.exec("BEGIN IMMEDIATE");
        try {
          const doomed = this.store.all(
            "SELECT id, seq FROM record_changes WHERE scope=? AND collection=? AND deleted=1 ORDER BY seq ASC LIMIT ?",
            scope,
            collection,
            take,
          );
          if (!doomed.length) {
            this.store.db.exec("COMMIT");
            break;
          }
          const maxSeq = Number(doomed[doomed.length - 1].seq);
          const ids = doomed.map((entry) => String(entry.id));
          const marks = ids.map(() => "?").join(",");
          const info = this.store.db.prepare(
            `DELETE FROM record_changes WHERE scope=? AND collection=? AND deleted=1 AND id IN (${marks})`,
          ).run(scope, collection, ...ids);
          this.store.db.prepare(
            "UPDATE record_seq SET pruned_before = MAX(pruned_before, ?) WHERE scope=? AND collection=?",
          ).run(maxSeq, scope, collection);
          this.store.db.exec("COMMIT");
          const deleted = Number(info.changes);
          totalCompacted += deleted;
          excess -= deleted;
          if (deleted < take) break;
        } catch (error) {
          try { this.store.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
          throw error;
        }
      }
    }
    return totalCompacted;
  }

  /** Run one bounded maintenance cycle across files, requests, and tombstones. */
  runOnce(options: { fileGraceMs?: number; requestTtlMs?: number; maxTombstones?: number } = {}): MaintenanceSummary {
    const files = this.sweepFiles({ graceMs: options.fileGraceMs });
    const prunedRequests = this.pruneRequests({ ttlMs: options.requestTtlMs });
    const compactedTombstones = this.compactTombstones({ maxTombstones: options.maxTombstones });
    return { files, prunedRequests, compactedTombstones };
  }
}
