import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, ftruncateSync, mkdirSync, openSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { open as openAsync } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createId } from "../src/core/ids.ts";
import { analyzeBase, evalFormulas, parseFrontmatter, rowFacts, scanInlineTags, type BaseRow, type RowFacts } from "../src/core/base.ts";
import { indexVault, noteToBlocks, planVault } from "../src/core/obsidian.ts";
import { indexNotion, notionPageToBlocks, notionTitle } from "../src/core/notion.ts";
import { storedRuns } from "../src/core/stored-runs.ts";
import type { Block } from "../src/core/types.ts";
import { blockRecordId } from "../src/platform/record-ids.ts";
import { openZipFile, readZip, type ZipEntryRead } from "./import-zip.ts";
import { externalScope } from "./mutation.ts";
import { fail, HttpError, type Actor, type Row, type Store, type Write } from "./store.ts";
import { recordTokenEvent } from "./token-identity.ts";

export { openZipFile, readZip, type ZipEntryRead };

/* Notes from elsewhere: an Obsidian vault or a Notion export zip. Uploads land
   directly on disk via chunked resumable sessions (zero full-archive heap
   buffering), parse inside a low-priority child process without holding the
   site write lock, and finally commit into a single atomic SQLite transaction. */

export const DEFAULT_PART_SIZE = 8 * 1024 * 1024;
export const MIN_PART_SIZE = 1024;
export const MAX_PART_SIZE = 16 * 1024 * 1024;
export const IMPORT_SESSION_TTL_MS = 24 * 3600_000;
export const COMPLETED_JOB_WINDOW_MS = 10 * 60_000;
const DISK_RESERVE_BYTES = 32 * 1024 * 1024;
const MAX_ATTACHMENT = 7.5 * 1024 * 1024;
const WORKER_MAX_HEAP_MB = Math.max(128, Number(process.env.IMPORT_WORKER_MAX_HEAP_MB ?? 512) || 512);

export type ImportSource = "obsidian" | "notion";
export type ImportStatus = "uploading" | "queued" | "scanning" | "importing" | "committing" | "done" | "failed";

export interface ImportInitiator {
  userId: string;
  displayName: string;
  tokenId?: string;
  avatar?: string;
}

export interface ImportReport {
  rootPageId: string;
  parentPageId?: string;
  topLevelPageIds: string[];
  title: string;
  pages: number;
  attachments: number;
  links: number;
  unresolved: string[];
  warnings: string[];
}

export interface ImportJob {
  id: string;
  userId: string;
  source: ImportSource;
  status: ImportStatus;
  phase: string;
  done: number;
  total: number;
  targetScope: string;
  parentId?: string;
  title: string;
  totalBytes: number;
  partSize: number;
  partCount: number;
  uploadedBytes: number;
  receivedParts?: number[];
  sha256?: string;
  archivePath?: string;
  expiresAt?: number;
  result?: ImportReport;
  error?: string;
  created: number;
  updatedAt: number;
  dismissed?: boolean;
  initiator?: ImportInitiator;
  /** Position among waiting jobs (1 = next to run), only while queued. */
  queuePosition?: number;
}

export interface ImportJobDto {
  id: string;
  source: ImportSource;
  status: ImportStatus;
  phase: string;
  done: number;
  total: number;
  targetScope: string;
  parentId?: string;
  title: string;
  totalBytes: number;
  partSize: number;
  partCount: number;
  uploadedBytes: number;
  receivedParts?: number[];
  expiresAt?: number;
  result?: ImportReport;
  error?: string;
  created: number;
  updatedAt: number;
  dismissed?: boolean;
  initiator?: ImportInitiator;
  queuePosition?: number;
}

interface InternalJobState {
  job: ImportJob;
  actor?: Actor;
  receivedSet: Set<number>;
  lastWsNotify: number;
}

const states = new Map<string, InternalJobState>();
const queue: string[] = [];
const children = new Map<string, ChildProcess>();
let persistence: Store | undefined;
let currentJobId: string | undefined;
let committingJobId: string | undefined;
let updateListener: ((targetScope: string, userId: string) => void) | undefined;

const PIPELINE_STATUSES: readonly ImportStatus[] = ["queued", "scanning", "importing", "committing"];
const ACTIVE_STATUSES: readonly ImportStatus[] = ["uploading", ...PIPELINE_STATUSES];

const JOB_TABLE = `CREATE TABLE IF NOT EXISTS import_jobs(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  result TEXT,
  done INTEGER NOT NULL,
  total INTEGER NOT NULL,
  created INTEGER NOT NULL,
  target_scope TEXT,
  parent_id TEXT,
  title TEXT,
  total_bytes INTEGER,
  part_size INTEGER,
  part_count INTEGER,
  received_parts TEXT,
  uploaded_bytes INTEGER,
  sha256 TEXT,
  archive_path TEXT,
  actor_json TEXT,
  updated_at INTEGER,
  dismissed INTEGER NOT NULL DEFAULT 0
)`;

const EXTRA_COLUMNS: ReadonlyArray<[string, string]> = [
  ["target_scope", "TEXT"],
  ["parent_id", "TEXT"],
  ["title", "TEXT"],
  ["total_bytes", "INTEGER"],
  ["part_size", "INTEGER"],
  ["part_count", "INTEGER"],
  ["received_parts", "TEXT"],
  ["uploaded_bytes", "INTEGER"],
  ["sha256", "TEXT"],
  ["archive_path", "TEXT"],
  ["actor_json", "TEXT"],
  ["updated_at", "INTEGER"],
  ["dismissed", "INTEGER NOT NULL DEFAULT 0"],
];

function importsRoot(dataDir: string): string {
  return resolve(dataDir, "imports");
}

function jobDir(dataDir: string, jobId: string): string {
  return join(importsRoot(dataDir), jobId);
}

function removeJobDir(dataDir: string, jobId: string): void {
  try {
    rmSync(jobDir(dataDir, jobId), { recursive: true, force: true });
  } catch { /* best-effort cleanup */ }
}

export function setImportUpdateListener(listener?: (targetScope: string, userId: string) => void): void {
  updateListener = listener;
}

function notifyImportChange(job: ImportJob, force = false): void {
  if (!updateListener) return;
  const state = states.get(job.id);
  const nowMs = Date.now();
  if (!force && state && nowMs - state.lastWsNotify < 250) return;
  if (state) state.lastWsNotify = nowMs;
  try {
    updateListener(job.targetScope, job.userId);
  } catch { /* ignore listener failure */ }
}

function serializeInitiator(actor: Actor): ImportInitiator {
  return {
    userId: actor.user.id,
    displayName: actor.displayName ?? actor.user.displayName,
    ...(actor.tokenId ? { tokenId: actor.tokenId } : {}),
    ...(actor.avatar ? { avatar: actor.avatar } : {}),
  };
}

export function toImportDto(job: ImportJob): ImportJobDto {
  const { archivePath: _archive, sha256: _sha, userId: _user, ...dto } = job;
  return {
    ...dto,
    targetScope: externalScope(job.targetScope),
    ...(job.status === "uploading" ? { receivedParts: job.receivedParts ?? [] } : {}),
  };
}

function computeUploadedBytes(receivedSet: ReadonlySet<number>, totalBytes: number, partSize: number, partCount: number): number {
  if (!totalBytes || !partCount) return 0;
  let bytes = 0;
  for (const index of receivedSet) {
    if (index < 0 || index >= partCount) continue;
    if (index === partCount - 1) {
      const rem = totalBytes - index * partSize;
      bytes += rem > 0 ? rem : 0;
    } else {
      bytes += partSize;
    }
  }
  return Math.min(totalBytes, bytes);
}

function persist(job: ImportJob, actor?: Actor): void {
  if (!persistence || !persistence.db.isOpen) return;
  const state = states.get(job.id);
  const actorValue = actor ?? state?.actor;
  const partsJson = job.receivedParts ? JSON.stringify(job.receivedParts) : null;
  try {
    persistence.db.prepare(`INSERT INTO import_jobs(
      id,user_id,source,status,error,result,done,total,created,
      target_scope,parent_id,title,total_bytes,part_size,part_count,received_parts,uploaded_bytes,
      sha256,archive_path,actor_json,updated_at,dismissed
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      status=excluded.status,
      error=excluded.error,
      result=excluded.result,
      done=excluded.done,
      total=excluded.total,
      target_scope=excluded.target_scope,
      parent_id=excluded.parent_id,
      title=excluded.title,
      received_parts=excluded.received_parts,
      uploaded_bytes=excluded.uploaded_bytes,
      archive_path=excluded.archive_path,
      actor_json=COALESCE(excluded.actor_json, import_jobs.actor_json),
      updated_at=excluded.updated_at,
      dismissed=excluded.dismissed`).run(
      job.id,
      job.userId,
      job.source,
      job.status,
      job.error ?? null,
      job.result ? JSON.stringify(job.result) : null,
      job.done,
      job.total,
      job.created,
      job.targetScope,
      job.parentId ?? null,
      job.title,
      job.totalBytes,
      job.partSize,
      job.partCount,
      partsJson,
      job.uploadedBytes,
      job.sha256 ?? null,
      job.archivePath ?? null,
      actorValue ? JSON.stringify(actorValue) : null,
      job.updatedAt,
      job.dismissed ? 1 : 0,
    );
  } catch {
    // A busy database during final commit will re-persist once commit finishes.
  }
}

function rowToJob(row: Row): { job: ImportJob; actor?: Actor; receivedSet: Set<number> } {
  const userId = String(row.user_id);
  const receivedParts = row.received_parts ? (JSON.parse(String(row.received_parts)) as number[]) : [];
  const receivedSet = new Set(receivedParts);
  const actor = row.actor_json ? (JSON.parse(String(row.actor_json)) as Actor) : undefined;
  const status = String(row.status) as ImportStatus;
  const created = Number(row.created);
  const partSize = row.part_size != null ? Number(row.part_size) : DEFAULT_PART_SIZE;
  const partCount = row.part_count != null ? Number(row.part_count) : 0;
  const totalBytes = row.total_bytes != null ? Number(row.total_bytes) : 0;
  const uploadedBytes = row.uploaded_bytes != null
    ? Number(row.uploaded_bytes)
    : computeUploadedBytes(receivedSet, totalBytes, partSize, partCount);
  const job: ImportJob = {
    id: String(row.id),
    userId,
    source: row.source as ImportSource,
    status,
    phase: status === "uploading" ? "等待上传分片…" : status === "done" ? "完成" : "",
    done: Number(row.done),
    total: Number(row.total),
    targetScope: row.target_scope ? String(row.target_scope) : `user:${userId}`,
    ...(row.parent_id ? { parentId: String(row.parent_id) } : {}),
    title: row.title ? String(row.title) : (row.source === "notion" ? "Notion 导入" : "Obsidian 导入"),
    totalBytes,
    partSize,
    partCount,
    uploadedBytes,
    ...(status === "uploading" ? { receivedParts: [...receivedSet].sort((a, b) => a - b), expiresAt: created + IMPORT_SESSION_TTL_MS } : {}),
    ...(row.sha256 ? { sha256: String(row.sha256) } : {}),
    ...(row.archive_path ? { archivePath: String(row.archive_path) } : {}),
    ...(row.error != null ? { error: String(row.error) } : {}),
    ...(row.result ? { result: JSON.parse(String(row.result)) as ImportReport } : {}),
    created,
    updatedAt: row.updated_at != null ? Number(row.updated_at) : created,
    dismissed: Number(row.dismissed ?? 0) !== 0,
    ...(actor ? { initiator: serializeInitiator(actor) } : {}),
  };
  return { job, actor, receivedSet };
}

/** Called once at boot: migrate import_jobs columns, mark interrupted pipeline
 *  jobs failed, keep unexpired resumable uploads, and sweep stale temp files. */
export function initializeImports(store: Store): void {
  persistence = store;
  states.clear();
  queue.length = 0;
  children.clear();
  currentJobId = undefined;
  committingJobId = undefined;

  store.db.exec(JOB_TABLE);
  const existingCols = new Set(
    (store.db.prepare("SELECT name FROM pragma_table_info('import_jobs')").all() as Array<{ name: string }>).map((r) => r.name),
  );
  for (const [col, def] of EXTRA_COLUMNS) {
    if (!existingCols.has(col)) store.db.exec(`ALTER TABLE import_jobs ADD COLUMN ${col} ${def}`);
  }

  store.db.exec(`UPDATE import_jobs SET status='failed', error='服务重启，导入中止。', updated_at=${Date.now()}
    WHERE status IN ('queued','scanning','importing','committing')`);
  store.db.prepare("DELETE FROM import_jobs WHERE created < ? AND status != 'uploading'").run(Date.now() - 7 * 86400_000);

  // Restore unexpired uploading sessions and sweep expired ones.
  const uploadingRows = store.all("SELECT * FROM import_jobs WHERE status='uploading'");
  const keepDirs = new Set<string>();
  const nowMs = Date.now();
  for (const row of uploadingRows) {
    const { job, actor, receivedSet } = rowToJob(row);
    const expired = job.created + IMPORT_SESSION_TTL_MS <= nowMs || !job.archivePath || !existsSync(job.archivePath);
    if (expired) {
      job.status = "failed";
      job.error = "上传会话已过期。";
      job.phase = "已过期";
      job.updatedAt = nowMs;
      delete job.receivedParts;
      delete job.expiresAt;
      persist(job, actor);
      removeJobDir(store.dataDir, job.id);
    } else {
      states.set(job.id, { job, actor, receivedSet, lastWsNotify: 0 });
      keepDirs.add(job.id);
    }
  }

  // Sweep any orphan directories under DATA_DIR/imports/.
  try {
    for (const entry of readdirSync(importsRoot(store.dataDir), { withFileTypes: true })) {
      if (entry.isDirectory() && !keepDirs.has(entry.name)) {
        removeJobDir(store.dataDir, entry.name);
      }
    }
  } catch { /* ignore */ }
}

/** Sweep expired upload sessions (> 24h) and stale temporary directories. */
export function sweepExpiredImports(store: Store, ttlMs = IMPORT_SESSION_TTL_MS): number {
  if (!store.db.isOpen || store.inTransaction) return 0;
  const nowMs = Date.now();
  const cutoff = nowMs - Math.max(1000, ttlMs);
  let swept = 0;
  const activeUploadIds = new Set<string>();

  for (const state of [...states.values()]) {
    if (state.job.status === "uploading") {
      if (state.job.created <= cutoff || !state.job.archivePath || !existsSync(state.job.archivePath)) {
        state.job.status = "failed";
        state.job.error = "上传会话已过期。";
        state.job.phase = "已过期";
        state.job.updatedAt = nowMs;
        delete state.job.receivedParts;
        delete state.job.expiresAt;
        persist(state.job, state.actor);
        removeJobDir(store.dataDir, state.job.id);
        notifyImportChange(state.job, true);
        swept += 1;
      } else {
        activeUploadIds.add(state.job.id);
      }
    } else if (ACTIVE_STATUSES.includes(state.job.status)) {
      activeUploadIds.add(state.job.id);
    }
  }

  const dbUploading = store.all("SELECT * FROM import_jobs WHERE status='uploading' AND created <= ?", cutoff);
  for (const row of dbUploading) {
    const id = String(row.id);
    if (!states.has(id)) {
      store.db.prepare("UPDATE import_jobs SET status='failed', error='上传会话已过期。', updated_at=? WHERE id=?").run(nowMs, id);
      removeJobDir(store.dataDir, id);
      swept += 1;
    }
  }

  // Reclaim stale temp folders not belonging to any active upload or running/queued job.
  try {
    for (const entry of readdirSync(importsRoot(store.dataDir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (activeUploadIds.has(entry.name) || queue.includes(entry.name) || currentJobId === entry.name) continue;
      removeJobDir(store.dataDir, entry.name);
    }
  } catch { /* ignore */ }

  // Prune old completed/failed states from memory after 1 hour.
  for (const [id, state] of states) {
    if ((state.job.status === "done" || state.job.status === "failed") && nowMs - state.job.updatedAt > 3600_000) {
      states.delete(id);
    }
  }
  return swept;
}

/** Server shutdown: terminate live worker processes (transactions roll back) and
 *  mark in-flight pipeline jobs failed. Preserves unexpired `uploading` sessions
 *  so clients can resume after restart! */
export async function shutdownImports(): Promise<void> {
  queue.length = 0;
  const terminations = [...children.entries()].map(([id, child]) => {
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
    });
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
    const state = states.get(id);
    if (state && !["done", "failed"].includes(state.job.status)) {
      state.job.status = "failed";
      state.job.error = "服务关闭，导入中止。";
      state.job.updatedAt = Date.now();
      persist(state.job, state.actor);
      if (persistence) removeJobDir(persistence.dataDir, id);
    }
    return exited;
  });
  await Promise.all(terminations);
  children.clear();
  currentJobId = undefined;
  committingJobId = undefined;
}

function canSeeJob(store: Store, actor: Actor, job: ImportJob): boolean {
  if (job.userId === actor.user.id) return true;
  if (job.targetScope.startsWith("user:")) return false;
  try {
    const role = store.role(actor, job.targetScope);
    return role !== "viewer";
  } catch {
    return false;
  }
}

export function importJob(userId: string, id: string): ImportJob | undefined {
  const state = states.get(id);
  if (state) return state.job.userId === userId ? state.job : undefined;
  const row = persistence?.db.prepare("SELECT * FROM import_jobs WHERE id=?").get(id) as Row | undefined;
  if (!row || row.user_id !== userId) return undefined;
  return rowToJob(row).job;
}

export function getVisibleImportJob(store: Store, actor: Actor, id: string): ImportJob | undefined {
  const state = states.get(id);
  if (state) return canSeeJob(store, actor, state.job) ? state.job : undefined;
  const row = store.one("SELECT * FROM import_jobs WHERE id=?", id);
  if (!row) return undefined;
  const { job } = rowToJob(row);
  return canSeeJob(store, actor, job) ? job : undefined;
}

export function listVisibleImports(store: Store, actor: Actor): ImportJob[] {
  const nowMs = Date.now();
  const visible = new Map<string, ImportJob>();

  for (const state of states.values()) {
    const { job } = state;
    if (!canSeeJob(store, actor, job)) continue;
    if (ACTIVE_STATUSES.includes(job.status) || (!job.dismissed && job.status === "failed") || (!job.dismissed && job.status === "done" && nowMs - job.updatedAt <= COMPLETED_JOB_WINDOW_MS)) {
      visible.set(job.id, job);
    }
  }

  const rows = store.all(
    `SELECT * FROM import_jobs
     WHERE status IN ('uploading','queued','scanning','importing','committing')
        OR (dismissed=0 AND (status='failed' OR (status='done' AND updated_at >= ?)))
     ORDER BY created DESC LIMIT 100`,
    nowMs - COMPLETED_JOB_WINDOW_MS,
  );
  for (const row of rows) {
    const id = String(row.id);
    if (visible.has(id)) continue;
    const parsed = rowToJob(row);
    if (!canSeeJob(store, actor, parsed.job)) continue;
    visible.set(id, parsed.job);
  }

  return [...visible.values()].sort((a, b) => b.created - a.created);
}

export function dismissImportJob(store: Store, actor: Actor, id: string): boolean {
  const state = states.get(id);
  let job = state?.job;
  let loadedActor = state?.actor;
  let receivedSet = state?.receivedSet;
  if (!job) {
    const row = store.one("SELECT * FROM import_jobs WHERE id=?", id);
    if (!row) return false;
    const parsed = rowToJob(row);
    job = parsed.job;
    loadedActor = parsed.actor;
    receivedSet = parsed.receivedSet;
  }
  if (!canSeeJob(store, actor, job)) return false;
  if (ACTIVE_STATUSES.includes(job.status)) fail(409, "进行中的导入请使用取消操作。", "conflict");
  job.dismissed = true;
  job.updatedAt = Date.now();
  if (!state && receivedSet) states.set(job.id, { job, actor: loadedActor, receivedSet, lastWsNotify: 0 });
  persist(job, loadedActor);
  notifyImportChange(job, true);
  return true;
}

function renumber(): void {
  let position = currentJobId ? 2 : 1;
  for (const id of queue) {
    const state = states.get(id);
    if (state) {
      state.job.queuePosition = position;
      position += 1;
    }
  }
}

function persistQueued(): void {
  for (const id of queue) {
    const state = states.get(id);
    if (state) persist(state.job, state.actor);
  }
}

/** Take the head of the queue into an isolated low-priority child process. */
function pump(): void {
  if (currentJobId || !persistence) return;
  const nextId = queue.shift();
  if (!nextId) return;
  const state = states.get(nextId);
  if (!state || !state.actor || !state.job.archivePath) {
    setImmediate(pump);
    return;
  }
  const store = persistence;
  const { job, actor } = state;
  persistQueued();
  renumber();
  currentJobId = job.id;
  delete job.queuePosition;
  job.updatedAt = Date.now();
  persist(job, actor);
  notifyImportChange(job, true);

  const workerPath = new URL("./import-worker.ts", import.meta.url);
  const tsxLoader = (() => {
    try { return import.meta.resolve("tsx"); }
    catch { return "tsx"; }
  })();
  const execArgv = ["--import", tsxLoader, `--max-old-space-size=${WORKER_MAX_HEAP_MB}`];

  const child = fork(workerPath, [], {
    execArgv,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  children.set(job.id, child);

  let settled = false;
  const finish = (error?: unknown) => {
    if (settled) return;
    settled = true;
    children.delete(job.id);
    if (currentJobId === job.id) currentJobId = undefined;
    if (committingJobId === job.id) committingJobId = undefined;
    if (!["done", "failed"].includes(job.status)) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : error ? String(error) : "导入异常终止。";
      job.phase = "失败";
    }
    job.updatedAt = Date.now();
    delete job.archivePath;
    removeJobDir(store.dataDir, job.id);
    persist(job, actor);
    if (job.status === "done") store.collaboration.notifyScopeDelta(job.targetScope);
    notifyImportChange(job, true);
    setImmediate(pump);
  };

  child.on("message", (message: { kind?: string; job?: Partial<ImportJob> }) => {
    if (message.kind === "committing") {
      committingJobId = job.id;
      job.status = "committing";
      job.phase = "提交记录…";
      job.updatedAt = Date.now();
      notifyImportChange(job, true);
      try { child.send({ kind: "commit_ack" }); } catch { /* child exited */ }
      return;
    }
    if (message.kind !== "job" || !message.job) return;
    const prevStatus = job.status;
    Object.assign(job, message.job, {
      id: job.id,
      userId: job.userId,
      created: job.created,
      targetScope: job.targetScope,
      parentId: job.parentId,
      initiator: job.initiator,
    });
    job.updatedAt = Date.now();
    delete job.queuePosition;
    notifyImportChange(job, prevStatus !== job.status);
  });

  child.on("error", (error) => finish(error));
  child.on("exit", (code, signal) => {
    if (!["done", "failed"].includes(job.status) && (code !== 0 || signal)) {
      finish(new Error(signal ? `导入进程被终止（${signal}）。` : `导入进程异常退出（${code}）。`));
    } else {
      finish();
    }
  });

  child.send({
    kind: "start",
    dataDir: store.dataDir,
    actor,
    source: job.source,
    jobId: job.id,
    archivePath: job.archivePath,
    targetScope: job.targetScope,
    parentId: job.parentId,
    title: job.title,
  });
}

function assertWritableParent(store: Store, _actor: Actor, targetScope: string, parentId: string): Row {
  let current: Row | undefined = store.record(targetScope, "pages", parentId);
  if (!current) fail(404, "父页面不存在。", "not_found");
  if (String(current.kind ?? "document") !== "document") fail(400, "父页面必须是文档页面。", "bad_request");
  while (current) {
    if (current.purging) fail(404, "父页面不存在。", "not_found");
    if (current.archived || current.shelved) fail(409, "目标父页面已归档或已放入回收站。", "conflict");
    current = current.parent_id ? store.record(targetScope, "pages", String(current.parent_id)) : undefined;
  }
  return store.record(targetScope, "pages", parentId)!;
}

export interface TargetLocation {
  targetScope: string;
  parentId?: string;
  parentTitle?: string;
  quotaSubject: string;
}

export function resolveImportTarget(
  store: Store,
  actor: Actor,
  options: { parentId?: string; spaceId?: string },
): TargetLocation {
  if (actor.tokenAccess === "read") fail(403, "此令牌仅有读取权限。", "read_only");
  const parent = options.parentId ? store.page(actor, options.parentId) : undefined;
  const explicitScope = options.spaceId ? store.scope(actor, options.spaceId, true) : undefined;
  if (parent && explicitScope && parent.scope !== explicitScope) {
    fail(400, "父页面不属于目标空间。", "bad_request");
  }
  const targetScope = parent?.scope ?? explicitScope ?? store.scope(actor, "personal", true);
  store.scope(actor, externalScope(targetScope), true);

  const library = store.knowledgeBases.get(targetScope);
  let resolvedParentId = parent?.page.id;
  if (resolvedParentId) {
    assertWritableParent(store, actor, targetScope, resolvedParentId);
  } else if (library) {
    resolvedParentId = library.homePageId;
    assertWritableParent(store, actor, targetScope, resolvedParentId);
  } else if (!targetScope.startsWith("user:") && !store.ownsScope(actor, targetScope)) {
    fail(403, "只有所有者可以在共享空间顶层导入页面。", "owner_required");
  }

  let quotaSubject = `user:${actor.user.id}`;
  if (library) {
    quotaSubject = `kb:${targetScope}`;
  } else if (!targetScope.startsWith("user:")) {
    const spaceRow = store.one("SELECT owner_id FROM spaces WHERE id=?", targetScope);
    if (spaceRow) quotaSubject = `user:${String(spaceRow.owner_id)}`;
  }

  const parentRow = resolvedParentId ? store.record(targetScope, "pages", resolvedParentId) : undefined;
  const parentTitle = parentRow
    ? (Array.isArray(parentRow.title_content)
      ? parentRow.title_content.map((run: { text?: string }) => run.text ?? "").join("")
      : undefined)
    : undefined;

  return {
    targetScope,
    ...(resolvedParentId ? { parentId: resolvedParentId } : {}),
    ...(parentTitle ? { parentTitle } : {}),
    quotaSubject,
  };
}

function assertQuotaAndDisk(store: Store, quotaSubject: string, totalBytes: number): void {
  if (store.quotas) {
    const quota = store.quotas.quota(quotaSubject);
    if (quota.used + totalBytes > quota.limit) {
      const label = store.quotas.describe(quotaSubject);
      const error = new Error(`超出存储限额：${label} 剩余空间不足以容纳 ${Math.ceil(totalBytes / 1_000_000)} MB 导入包。`) as Error & { status?: number; code?: string };
      fail(413, error.message, "quota_exceeded");
    }
    const { freeBytes } = store.quotas.diskUsage();
    if (freeBytes !== null && freeBytes < totalBytes + DISK_RESERVE_BYTES) {
      fail(507, "磁盘可用空间不足，无法接纳本次导入。", "insufficient_storage");
    }
  }
}

function assertNoActivePipelineForUser(userId: string): void {
  for (const state of states.values()) {
    if (state.job.userId === userId && PIPELINE_STATUSES.includes(state.job.status)) {
      fail(409, "你已有导入任务进行中。", "conflict");
    }
  }
}

export interface CreateImportSessionInput {
  source: ImportSource;
  totalBytes: number;
  partSize?: number;
  parentId?: string;
  spaceId?: string;
  title?: string;
  sha256?: string;
}

/** Create a disk-backed chunked upload session (zero heap buffering). */
export function createImportSession(store: Store, actor: Actor, input: CreateImportSessionInput): ImportJob {
  const target = resolveImportTarget(store, actor, { parentId: input.parentId, spaceId: input.spaceId });
  const partSize = input.partSize ?? DEFAULT_PART_SIZE;
  if (!Number.isInteger(partSize) || partSize < MIN_PART_SIZE || partSize > MAX_PART_SIZE) {
    fail(400, `分片大小须在 ${MIN_PART_SIZE} 到 ${MAX_PART_SIZE} 字节之间。`, "bad_request");
  }
  if (!Number.isInteger(input.totalBytes) || input.totalBytes < 22) {
    fail(400, "导入包大小无效。", "bad_request");
  }
  assertQuotaAndDisk(store, target.quotaSubject, input.totalBytes);

  const partCount = Math.ceil(input.totalBytes / partSize);
  const jobId = `import_${createId("x")}`;
  const dir = jobDir(store.dataDir, jobId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const archivePath = join(dir, "archive.zip");

  try {
    const fd = openSync(archivePath, "w", 0o600);
    try { ftruncateSync(fd, input.totalBytes); }
    finally { closeSync(fd); }
  } catch (error) {
    removeJobDir(store.dataDir, jobId);
    throw error;
  }

  const nowMs = Date.now();
  const title = input.title?.trim() || (input.source === "notion" ? "Notion 导入" : "Obsidian 导入");
  const job: ImportJob = {
    id: jobId,
    userId: actor.user.id,
    source: input.source,
    status: "uploading",
    phase: "等待上传分片…",
    done: 0,
    total: 0,
    targetScope: target.targetScope,
    ...(target.parentId ? { parentId: target.parentId } : {}),
    title,
    totalBytes: input.totalBytes,
    partSize,
    partCount,
    uploadedBytes: 0,
    receivedParts: [],
    ...(input.sha256 ? { sha256: input.sha256.toLowerCase() } : {}),
    archivePath,
    expiresAt: nowMs + IMPORT_SESSION_TTL_MS,
    created: nowMs,
    updatedAt: nowMs,
    dismissed: false,
    initiator: serializeInitiator(actor),
  };

  const state: InternalJobState = { job, actor, receivedSet: new Set(), lastWsNotify: 0 };
  states.set(jobId, state);
  persist(job, actor);
  notifyImportChange(job, true);
  return job;
}

/** Write one chunk at its exact file offset; supports concurrent out-of-order
 *  uploads and idempotent retries. */
export async function uploadImportPart(
  _store: Store,
  actor: Actor,
  jobId: string,
  partIndex: number,
  bytes: Buffer,
): Promise<{ id: string; index: number; receivedCount: number; partCount: number; uploadedBytes: number; totalBytes: number }> {
  const state = states.get(jobId);
  if (!state) fail(404, "导入会话不存在或已过期。", "not_found");
  const { job } = state;
  if (job.userId !== actor.user.id) fail(403, "无权操作该导入会话。", "forbidden");
  if (actor.tokenAccess === "read") fail(403, "此令牌仅有读取权限。", "read_only");
  if (job.status !== "uploading") fail(409, "导入会话已结束上传，无法继续写入分片。", "conflict");
  if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= job.partCount) {
    fail(400, `分片序号无效（期望 0..${job.partCount - 1}）。`, "bad_request");
  }
  const offset = partIndex * job.partSize;
  const expectedLength = partIndex === job.partCount - 1 ? job.totalBytes - offset : job.partSize;
  if (bytes.length !== expectedLength) {
    fail(400, `分片 ${partIndex} 大小应为 ${expectedLength} 字节，实际收到 ${bytes.length} 字节。`, "bad_request");
  }
  if (!job.archivePath) fail(404, "上传文件不存在。", "not_found");

  const handle = await openAsync(job.archivePath, "r+");
  try {
    let written = 0;
    while (written < bytes.length) {
      const res = await handle.write(bytes, written, bytes.length - written, offset + written);
      written += res.bytesWritten;
    }
  } finally {
    await handle.close();
  }

  // Re-check status after async disk write in case the session was canceled mid-write.
  if (job.status !== "uploading") fail(409, "导入会话已取消或结束。", "conflict");
  state.receivedSet.add(partIndex);
  job.receivedParts = [...state.receivedSet].sort((a, b) => a - b);
  job.uploadedBytes = computeUploadedBytes(state.receivedSet, job.totalBytes, job.partSize, job.partCount);
  job.phase = `上传中 ${Math.round((job.uploadedBytes / Math.max(1, job.totalBytes)) * 100)}%…`;
  job.updatedAt = Date.now();
  persist(job, state.actor);
  notifyImportChange(job, state.receivedSet.size === 1 || state.receivedSet.size === job.partCount);

  return {
    id: job.id,
    index: partIndex,
    receivedCount: state.receivedSet.size,
    partCount: job.partCount,
    uploadedBytes: job.uploadedBytes,
    totalBytes: job.totalBytes,
  };
}

async function fileSha256(filePath: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

/** Verify all parts arrived (plus optional SHA-256) and enqueue for background import. */
export async function completeImportSession(store: Store, actor: Actor, jobId: string): Promise<ImportJob> {
  const state = states.get(jobId);
  if (!state) {
    const row = store.one("SELECT * FROM import_jobs WHERE id=?", jobId);
    if (!row) fail(404, "导入会话不存在。", "not_found");
    const existing = rowToJob(row).job;
    if (existing.userId !== actor.user.id) fail(403, "无权操作该导入会话。", "forbidden");
    if (PIPELINE_STATUSES.includes(existing.status) || existing.status === "done") return existing;
    fail(409, existing.error ?? "导入会话已失效。", "conflict");
  }
  const { job } = state;
  if (job.userId !== actor.user.id) fail(403, "无权操作该导入会话。", "forbidden");
  if (actor.tokenAccess === "read") fail(403, "此令牌仅有读取权限。", "read_only");
  if (PIPELINE_STATUSES.includes(job.status) || job.status === "done") return job;
  if (job.status !== "uploading") fail(409, job.error ?? "导入会话已结束。", "conflict");

  const missing: number[] = [];
  for (let i = 0; i < job.partCount; i += 1) {
    if (!state.receivedSet.has(i)) missing.push(i);
  }
  if (missing.length) {
    const error = new HttpError(400, `尚有 ${missing.length} 个分片未上传。`, "incomplete_parts");
    (error as { missingParts?: number[] }).missingParts = missing;
    throw error;
  }

  assertNoActivePipelineForUser(actor.user.id);
  resolveImportTarget(store, actor, {
    parentId: job.parentId,
    spaceId: job.targetScope.startsWith("user:") ? undefined : job.targetScope,
  });

  if (job.sha256 && job.archivePath) {
    const actual = await fileSha256(job.archivePath);
    if (actual !== job.sha256) {
      fail(400, "导入包 SHA-256 校验失败，请重新上传。", "checksum_mismatch");
    }
  }

  // Update actor to current caller (e.g. token identity if completed via token).
  state.actor = actor;
  job.initiator = serializeInitiator(actor);
  job.status = "queued";
  job.phase = "等待队列…";
  job.updatedAt = Date.now();
  delete job.receivedParts;
  delete job.expiresAt;
  queue.push(job.id);
  if (!currentJobId) persist(job, actor);
  renumber();
  notifyImportChange(job, true);
  setImmediate(pump);
  return job;
}

/** Legacy single-shot POST entry: writes zip directly to disk so queued jobs
 *  never pin archive Buffers in heap memory. */
export function startImport(store: Store, actor: Actor, source: ImportSource, zip: Buffer): ImportJob {
  if (zip.length > 1024 * 1024 * 1024) throw new Error("导入文件超过 1 GiB 上限。");
  assertNoActivePipelineForUser(actor.user.id);

  const jobId = `import_${createId("x")}`;
  const dir = jobDir(store.dataDir, jobId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const archivePath = join(dir, "archive.zip");
  writeFileSync(archivePath, zip, { mode: 0o600 });

  const nowMs = Date.now();
  const job: ImportJob = {
    id: jobId,
    userId: actor.user.id,
    source,
    status: "queued",
    phase: "等待队列…",
    done: 0,
    total: 0,
    targetScope: `user:${actor.user.id}`,
    title: source === "notion" ? "Notion 导入" : "Obsidian 导入",
    totalBytes: zip.length,
    partSize: zip.length || DEFAULT_PART_SIZE,
    partCount: 1,
    uploadedBytes: zip.length,
    archivePath,
    created: nowMs,
    updatedAt: nowMs,
    dismissed: false,
    initiator: serializeInitiator(actor),
  };

  states.set(jobId, { job, actor, receivedSet: new Set([0]), lastWsNotify: 0 });
  queue.push(jobId);
  if (!currentJobId) persist(job, actor);
  renumber();
  notifyImportChange(job, true);
  setImmediate(pump);
  return job;
}

/** True while a worker process is running (pauses background purge/maintenance
 *  so `sweepFiles` never reaps blobs written before the final commit). */
export function importActive(): boolean {
  return currentJobId !== undefined;
}

/** True ONLY during the brief final `bulkTransaction` write window. */
export function importCommitting(): boolean {
  return committingJobId !== undefined;
}

/** Cancel an uploading, queued, or running import job. */
export function cancelImport(userId: string, id: string, actor?: Actor): boolean {
  const state = states.get(id);
  const job = state?.job ?? importJob(userId, id);
  if (!job || ["done", "failed"].includes(job.status)) return false;
  if (actor && !canSeeJob(persistence!, actor, job)) return false;
  if (!actor && job.userId !== userId) return false;

  if (job.status === "uploading") {
    job.status = "failed";
    job.error = "已取消。";
    job.phase = "已取消";
    job.updatedAt = Date.now();
    delete job.receivedParts;
    delete job.expiresAt;
    delete job.archivePath;
    if (persistence) removeJobDir(persistence.dataDir, id);
    persist(job, state?.actor);
    notifyImportChange(job, true);
    return true;
  }

  const queuedAt = queue.indexOf(id);
  if (queuedAt >= 0) {
    queue.splice(queuedAt, 1);
    renumber();
    job.status = "failed";
    job.error = "已取消。";
    job.phase = "已取消";
    job.updatedAt = Date.now();
    delete job.queuePosition;
    delete job.archivePath;
    if (persistence) removeJobDir(persistence.dataDir, id);
    persist(job, state?.actor);
    notifyImportChange(job, true);
    return true;
  }

  const child = children.get(id);
  if (!child) return false;
  job.status = "failed";
  job.error = "已取消。";
  job.phase = "已取消";
  job.updatedAt = Date.now();
  delete job.archivePath;
  if (committingJobId === id) committingJobId = undefined;
  try { child.kill("SIGKILL"); } catch { /* already exited */ }
  if (persistence) removeJobDir(persistence.dataDir, id);
  persist(job, state?.actor);
  notifyImportChange(job, true);
  return true;
}

/* ── Shared pipeline parts ──────────────────────────────────────────────── */

interface ScannedEntry {
  path: string;
  size: number;
  mtime: number;
  read(): Buffer;
}

const now = () => new Date().toISOString();

const guessType = (name: string): string => {
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp",
    pdf: "application/pdf", mp3: "audio/mpeg", mp4: "video/mp4", zip: "application/zip",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return map[name.split(".").at(-1)?.toLowerCase() ?? ""] ?? "application/octet-stream";
};

export interface RunImportHooks {
  onBeforeCommit?: () => Promise<void> | void;
}

export async function runImportBody(
  store: Store,
  actor: Actor,
  job: ImportJob,
  source: string | Buffer,
  hooks: RunImportHooks = {},
): Promise<void> {
  job.status = "scanning";
  job.phase = "扫描文件…";
  const opened = typeof source === "string" ? openZipFile(source) : undefined;
  try {
    const rawEntries = opened ? opened.entries : readZip(source as Buffer);
    const entries: ScannedEntry[] = rawEntries.map((entry) => ({
      path: entry.name,
      size: entry.size,
      mtime: entry.mtime,
      read: entry.bytes,
    }));
    job.total = entries.length;
    // Attachment index rows commit inside the records transaction, so a
    // failed import leaves neither index rows nor unreferenced bytes.
    store.files.beginBatch();
    try {
      if (job.source === "obsidian") await importObsidian(store, actor, job, entries, hooks);
      else await importNotion(store, actor, job, entries, hooks);
    } catch (error) {
      store.files.abortBatch();
      throw error;
    }
  } finally {
    opened?.close();
  }
}

interface PageBuild {
  id: string;
  title: string;
  blocks: Block[];
  parentId?: string;
  kind?: "document" | "database";
  database?: { properties: Row[]; views: Row[]; title_name?: string };
  properties?: Record<string, string>;
  row_order?: number;
  shareSpaceId?: string;
}

/** Write pages + their blocks in one transaction. Nothing lands on failure. */
async function commit(
  store: Store,
  actor: Actor,
  targetScope: string,
  job: ImportJob,
  built: PageBuild[],
  reportTitle: string,
  rootPageId: string,
  hooks: RunImportHooks,
): Promise<void> {
  job.status = "committing";
  job.phase = "提交记录…";
  await hooks.onBeforeCommit?.();

  const writes: Write[] = [];
  const stamp = now();
  const who = actor.user.displayName;
  const writeScope = externalScope(targetScope);
  for (const page of built) {
    writes.push({
      scope: writeScope,
      collection: "pages",
      id: page.id,
      action: "put",
      value: {
        id: page.id,
        title_content: storedRuns([{ text: page.title }]),
        icon: "",
        kind: page.kind ?? "document",
        ...(page.parentId ? { parent_id: page.parentId } : {}),
        ...(page.shareSpaceId ? { share_space_id: page.shareSpaceId } : {}),
        ...(page.properties ? { properties: page.properties } : {}),
        ...(page.row_order !== undefined ? { row_order: page.row_order } : {}),
        ...(page.database ? { database: page.database } : {}),
        created_at: stamp,
        updated_at: stamp,
        created_by: who,
        updated_by: who,
      } as Row,
    });
    for (const block of page.blocks) {
      writes.push({
        scope: writeScope,
        collection: "blocks",
        id: blockRecordId(page.id, block.id),
        action: "put",
        value: {
          id: block.id,
          page: page.id,
          kind: block.kind,
          ...(block.parent_id ? { parent_id: block.parent_id } : {}),
          order: block.order,
          content: storedRuns(block.content),
          ...(block.checked === undefined ? {} : { checked: block.checked }),
          ...(block.language ? { language: block.language } : {}),
          ...(block.table ? { table: block.table } : {}),
          ...(block.file ? { file: block.file } : {}),
          ...(block.name ? { name: block.name } : {}),
          ...(block.color ? { color: block.color } : {}),
          ...(block.icon ? { icon: block.icon } : {}),
          ...(block.width ? { width: block.width } : {}),
        } as Row,
      });
    }
  }

  store.bulkTransaction(() => {
    // Re-verify target parent inside the atomic commit transaction so concurrent
    // delete/archive rolls back cleanly with zero orphans.
    store.scope(actor, externalScope(targetScope), true);
    if (job.parentId) {
      assertWritableParent(store, actor, targetScope, job.parentId);
    }
    store.files.commitBatch();
    store.apply(actor, writes, undefined, [], 50_000_000);
    recordTokenEvent(store.db, actor.tokenId, { action: "import", pageId: rootPageId, pageTitle: reportTitle });
  });
}

/** Per-import helpers: page ids, attachment writing, unresolved links. */
function makeHooks(
  store: Store,
  actor: Actor,
  scope: string,
  job: ImportJob,
  entryOf: (path: string) => ScannedEntry | undefined,
  idOf: Map<string, string>,
) {
  const warnings: string[] = [];
  const unresolved: string[] = [];
  const inPersonal = scope.startsWith("user:");
  const stored = new Map<string, { path: string; name: string; size: number; type: string; owner: string; space?: string }>();
  const hooks = {
    pageIdOf: (note: { path: string }) => idOf.get(note.path) ?? "",
    storedOf: (file: { path: string }) => {
      const cached = stored.get(file.path);
      if (cached) return cached;
      const entry = entryOf(file.path);
      if (!entry) return undefined;
      const name = entry.path.split("/").at(-1) ?? "file";
      if (entry.size > MAX_ATTACHMENT) {
        warnings.push(`附件 ${entry.path} 超过 7.5 MB 上限，已跳过。`);
        return undefined;
      }
      job.phase = `写入附件 ${file.path}…`;
      const path = `files/${job.id}/${entry.path.split("/").map((s) => s.replace(/[^\w.-]+/g, "-")).join("/")}`;
      const bytes = entry.read();
      const ok = store.files.write(scope, path, guessType(name), bytes);
      if (!ok) {
        warnings.push(`附件 ${entry.path} 写入失败，已跳过。`);
        return undefined;
      }
      const written = {
        path,
        name,
        size: bytes.length,
        type: guessType(name),
        owner: actor.user.id,
        ...(inPersonal ? {} : { space: scope }),
      };
      stored.set(file.path, written);
      return written;
    },
    unresolved: (target: string) => { if (unresolved.length < 50) unresolved.push(target); },
  };
  return { hooks, warnings, unresolved, stored };
}

/** Entry lookup by vault-relative path (exact, then by suffix). */
function entryOfFactory(entries: ScannedEntry[]): (path: string) => ScannedEntry | undefined {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  return (path) => byPath.get(path)
    ?? entries.find((e) => e.path.endsWith(`/${path}`))
    ?? byPath.get(path.split("/").map((s) => encodeURIComponent(s)).join("/"));
}

/* ── Obsidian ───────────────────────────────────────────────────────────── */

async function importObsidian(
  store: Store,
  actor: Actor,
  job: ImportJob,
  entries: ScannedEntry[],
  runHooks: RunImportHooks,
): Promise<void> {
  const thin = entries.map((e) => ({ path: e.path, bytes: new Uint8Array(), size: e.size, mtime: e.mtime }));
  const plan = planVault(thin);
  if (!plan) throw new Error("没有找到 Markdown 笔记。");
  const scope = job.targetScope || `user:${actor.user.id}`;
  const index = indexVault(plan);
  const entryOf = entryOfFactory(entries);
  const idOf = new Map(plan.notes.map((note) => [note.path, createId("page")]));
  const { hooks, warnings, unresolved, stored } = makeHooks(store, actor, scope, job, entryOf, idOf);
  if (!plan.configured) warnings.push("未发现 .obsidian 目录，按普通 Markdown 文件夹导入。");

  const directMountId = job.parentId;
  const pages: PageBuild[] = [];
  let rootId: string;
  let reportTitle: string;
  const isSharedTop = !directMountId && !scope.startsWith("user:") && !store.knowledgeBases.get(scope);

  if (directMountId) {
    rootId = directMountId;
    reportTitle = !job.title || job.title === "Obsidian 导入" ? plan.name : job.title;
    job.title = reportTitle;
  } else {
    rootId = createId("page");
    reportTitle = `Obsidian 导入 — ${plan.name}`;
    pages.push({
      id: rootId,
      title: reportTitle,
      blocks: [],
      ...(isSharedTop ? { shareSpaceId: scope } : {}),
    });
  }

  // Directory → its page, parents first.
  const folderIds = new Map<string, string>();
  const folderOf = (dir: string): string | undefined => {
    if (!dir) return undefined;
    const known = folderIds.get(dir);
    if (known) return known;
    const parent = dir.includes("/") ? folderOf(dir.split("/").slice(0, -1).join("/")) : undefined;
    const id = createId("page");
    folderIds.set(dir, id);
    const parentId = parent ?? directMountId ?? rootId;
    pages.push({
      id,
      title: dir.split("/").at(-1)!,
      blocks: [],
      parentId,
      ...(isSharedTop && !parent ? { shareSpaceId: scope } : {}),
    });
    return id;
  };

  job.status = "importing";
  let links = 0;

  /* Pass 1 — analyze every .base and decide which notes it claims. */
  const baseNotes: BaseRow[] = plan.notes.map((note) => {
    const entry = entryOf(note.path);
    const body = entry ? entry.read().toString("utf8").replace(/\r\n?/g, "\n") : "";
    const matter = /^---\n([\s\S]*?)\n---\n?/.exec(body);
    const frontmatter = matter ? matter[1] : "";
    const rest = matter ? body.slice(matter[0].length) : body;
    return {
      path: note.path,
      props: parseFrontmatter(frontmatter),
      tags: [...new Set([...scanInlineTags(rest), ...tagsOf(frontmatter)])],
      mtime: entry ? entry.mtime : 0,
      ctime: entry ? entry.mtime : 0,
      size: entry ? entry.size : 0,
    };
  });
  const facts: RowFacts[] = baseNotes.map(rowFacts);
  const claims = new Map<string, { dbId: string; spec: ReturnType<typeof analyzeBase>; title: string }>();
  const baseWarnings: string[] = [];
  interface PlannedBase {
    entry: ScannedEntry;
    spec: NonNullable<ReturnType<typeof analyzeBase>>;
    dbId: string;
    title: string;
    dir: string;
    rows: BaseRow[];
  }
  const plannedBases: PlannedBase[] = [];
  for (const att of plan.attachments) {
    if (!att.path.toLowerCase().endsWith(".base")) continue;
    const entry = entryOf(att.path);
    if (!entry) continue;
    const spec = analyzeBase(entry.read().toString("utf8"));
    if (!spec) {
      baseWarnings.push(`${att.path}：YAML 解析失败，按普通页面导入`);
      continue;
    }
    const title = att.path.split("/").at(-1)!.replace(/\.base$/i, "");
    const dir = att.path.includes("/") ? att.path.split("/").slice(0, -1).join("/") : "";
    const matched = baseNotes.filter((_row, index) => spec.predicate(facts[index]));
    const dbId = createId("page");
    for (const row of matched) {
      if (claims.has(row.path)) {
        baseWarnings.push(`${att.path}：笔记 ${row.path} 已被其他 database 占用，该行未移动`);
        continue;
      }
      claims.set(row.path, { dbId, spec, title });
    }
    plannedBases.push({ entry, spec, dbId, title, dir, rows: matched.filter((row) => claims.get(row.path)?.dbId === dbId) });
  }

  /* Pass 2 — write every note. */
  const noteProperties = new Map<string, Record<string, string>>();
  const noteOrder = new Map<string, number>();
  for (const base of plannedBases) {
    const spec = base.spec;
    const propertyIds = new Map<string, string>();
    const properties: Row[] = [];
    const inferType = (key: string, values: YamlValue[]): { type: string; options?: string[] } => {
      if (key.startsWith("formula.")) return { type: "text" };
      if (key === "tags" || key === "file.tags") return { type: "select", options: [] };
      const iso = values.every((value) => value === null || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?/.test(value)));
      if (iso && values.some((value) => value !== null)) return { type: "date" };
      const discrete = new Set<string>();
      let multi = false;
      for (const value of values) {
        if (Array.isArray(value)) { multi = true; for (const item of value) discrete.add(String(item)); }
        else if (value !== null) discrete.add(String(value));
      }
      if (!multi && discrete.size && discrete.size <= 12) return { type: "select", options: [...discrete].sort() };
      return { type: "text" };
    };
    const display = (key: string): string => spec.displayNames[key] ?? (key.startsWith("file.") ? fileFieldLabel(key) : key);
    for (const key of spec.columnKeys) {
      if (key === "file.name" || key === "file.basename") continue;
      const values = base.rows.map((row) => valueForKey(key, row, spec));
      const { type, options } = inferType(key, values);
      const id = `property_${createId("p")}`;
      propertyIds.set(key, id);
      properties.push({ id, name: display(key), type, ...(options ? { options } : {}) } as Row);
    }
    base.rows.forEach((row, index) => {
      const rowFactsLocal = facts[baseNotes.indexOf(row)];
      const formulaValues = evalFormulas(spec.formulas, rowFactsLocal, []);
      const map: Record<string, string> = {};
      for (const key of spec.columnKeys) {
        if (key === "file.name" || key === "file.basename") continue;
        const id = propertyIds.get(key);
        if (!id) continue;
        const raw = valueForKey(key, row, spec, formulaValues);
        if (raw === null || raw === undefined || raw === "") continue;
        map[id] = Array.isArray(raw) ? raw.map(String).join("、") : String(raw);
      }
      noteProperties.set(row.path, map);
      noteOrder.set(row.path, index * 1024);
    });
    const propertyFor = (key: string) => properties.find((row) => row.id === propertyIds.get(key));
    const views: Row[] = spec.views.map((view) => {
      const kind = view.type === "cards" ? (view.groupBy ? "board" : "gallery")
        : view.type === "table" ? "table"
        : view.type === "list" ? "list"
        : "table";
      const sorts = view.sort
        .map((s) => ({ property_id: s.property === "file.name" ? "name" : propertyFor(s.property)?.id, direction: s.direction }))
        .filter((s) => s.property_id) as Array<{ property_id: string; direction: string }>;
      const filter = view.filter && view.filter.property !== "file.name"
        ? { property_id: propertyFor(view.filter.property)?.id ?? "", value: view.filter.value }
        : undefined;
      const group_by = view.groupBy ? propertyFor(view.groupBy)?.id : undefined;
      const widths: Record<string, number> = {};
      for (const [key, width] of Object.entries(view.widths)) {
        const id = key === "file.name" ? "name" : String(propertyFor(key)?.id ?? "");
        if (id) widths[id] = width;
      }
      return {
        id: `view_${createId("v")}`, name: view.name, kind,
        ...(filter ? { filter } : {}),
        ...(sorts.length ? { sorts } : {}),
        ...(group_by ? { group_by } : {}),
        ...(Object.keys(widths).length ? { widths } : {}),
      } as Row;
    });
    for (const view of spec.views) {
      if (!view.groupBy || !view.groupOrder.length) continue;
      const property = propertyFor(view.groupBy) as Row | undefined;
      const options = property?.options as string[] | undefined;
      if (!options?.length) continue;
      const ordered = [
        ...view.groupOrder.filter((name) => options.includes(name)),
        ...options.filter((name) => !view.groupOrder.includes(name)),
      ];
      if (property) property.options = ordered;
    }
    const dbParent = base.dir ? folderOf(base.dir) : (directMountId ?? rootId);
    pages.push({
      id: base.dbId,
      title: base.title,
      blocks: [],
      kind: "database",
      database: { properties, views, title_name: spec.displayNames["file.name"] ?? "笔记" },
      parentId: dbParent,
      ...(isSharedTop && !base.dir ? { shareSpaceId: scope } : {}),
    });
    for (const warning of spec.warnings) baseWarnings.push(`${base.entry.path}：${warning}`);
  }

  for (const note of plan.notes) {
    const entry = entryOf(note.path);
    if (!entry) continue;
    job.phase = `导入 ${note.path}…`;
    job.done += 1;
    const dir = note.path.includes("/") ? note.path.split("/").slice(0, -1).join("/") : "";
    const { blocks } = noteToBlocks(entry.read().toString("utf8"), index, hooks, () => createId("block"));
    links += blocks.filter((b) => b.content.some((r) => r.mention?.kind === "page")).length;
    const claim = claims.get(note.path);
    const parentId = claim ? claim.dbId : (dir ? folderOf(dir) : (directMountId ?? rootId));
    pages.push({
      id: idOf.get(note.path)!,
      title: note.path.split("/").at(-1)!.replace(/\.md$/i, ""),
      blocks,
      parentId,
      ...(isSharedTop && !claim && !dir ? { shareSpaceId: scope } : {}),
      ...(claim && noteProperties.get(note.path) ? { properties: noteProperties.get(note.path) } : {}),
      ...(claim ? { row_order: noteOrder.get(note.path) } : {}),
    });
  }

  const topLevelPageIds = directMountId
    ? pages.filter((p) => p.parentId === directMountId).map((p) => p.id)
    : [rootId];

  await commit(store, actor, scope, job, pages, reportTitle, rootId, runHooks);
  job.result = {
    rootPageId: rootId,
    ...(directMountId ? { parentPageId: directMountId } : {}),
    topLevelPageIds,
    title: reportTitle,
    pages: pages.length,
    attachments: stored.size,
    links,
    unresolved,
    warnings: [...warnings, ...baseWarnings],
  };
  job.status = "done";
  job.phase = "完成";
}

const FILE_FIELD_LABELS: Record<string, string> = {
  "file.ext": "扩展名",
  "file.path": "路径",
  "file.folder": "文件夹",
  "file.size": "大小",
  "file.mtime": "更新时间",
  "file.ctime": "创建时间",
  "file.tags": "标签",
};

function fileFieldLabel(key: string): string {
  return FILE_FIELD_LABELS[key] ?? key;
}

function tagsOf(frontmatter: string): string[] {
  const match = frontmatter.match(/^tags:\s*(.*)$/m);
  if (!match) return [];
  const raw = match[1].trim();
  if (!raw) return [];
  const values = raw.startsWith("[") ? raw.slice(1, -1).split(",") : [raw];
  return values.map((value) => value.trim().replace(/^["']|["']$/g, "").toLowerCase()).filter(Boolean);
}

function valueForKey(
  key: string,
  row: BaseRow,
  spec: { formulas: Array<{ name: string; expr: unknown }> },
  formulaValues?: Record<string, YamlValue>,
): YamlValue {
  if (key.startsWith("formula.")) {
    const computed = formulaValues ?? evalFormulas(spec.formulas as never, rowFacts(row), []);
    return computed[key] ?? null;
  }
  if (key === "tags" || key === "file.tags") return row.tags;
  if (key.startsWith("file.")) {
    const raw = rowFacts(row)[key];
    if ((key === "file.mtime" || key === "file.ctime") && typeof raw === "number" && raw > 0) {
      return new Date(raw).toISOString().slice(0, 10);
    }
    return raw ?? null;
  }
  return row.props[key] ?? null;
}

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

/* ── Notion ─────────────────────────────────────────────────────────────── */

async function importNotion(
  store: Store,
  actor: Actor,
  job: ImportJob,
  entries: ScannedEntry[],
  runHooks: RunImportHooks,
): Promise<void> {
  const thin = entries.map((e) => ({ path: e.path, bytes: new Uint8Array(), size: e.size, mtime: e.mtime }));
  const index = indexNotion(thin);
  const notes = entries.filter((e) => e.path.toLowerCase().endsWith(".md"));
  if (!notes.length) throw new Error("没有找到 Markdown 笔记。");
  const scope = job.targetScope || `user:${actor.user.id}`;
  const entryOf = entryOfFactory(entries);
  const idOf = new Map(notes.map((note) => [note.path, createId("page")]));
  const { hooks, warnings, unresolved, stored } = makeHooks(store, actor, scope, job, entryOf, idOf);

  const directMountId = job.parentId;
  const pages: PageBuild[] = [];
  let rootId: string;
  let reportTitle: string;
  const isSharedTop = !directMountId && !scope.startsWith("user:") && !store.knowledgeBases.get(scope);

  if (directMountId) {
    rootId = directMountId;
    reportTitle = job.title || "Notion 导入";
  } else {
    rootId = createId("page");
    reportTitle = "Notion 导入";
    pages.push({
      id: rootId,
      title: reportTitle,
      blocks: [],
      ...(isSharedTop ? { shareSpaceId: scope } : {}),
    });
  }
  const seen = new Set<string>();

  const pageForDir = (dir: string, dirName: string): ScannedEntry | undefined =>
    notes.find((note) => {
      const base = note.path.split("/").at(-1)!;
      const parent = note.path.split("/").slice(0, -1).join("/");
      return parent === dir && notionTitle(base.replace(/\.md$/i, "")) === dirName;
    });

  const emit = (dir: string, parentId: string) => {
    const prefix = dir ? `${dir}/` : "";
    const subdirs = new Set<string>();
    for (const entry of entries) {
      if (!entry.path.startsWith(prefix)) continue;
      const rest = entry.path.slice(prefix.length);
      if (rest.includes("/")) subdirs.add(rest.split("/")[0]);
    }
    for (const name of [...subdirs].sort((a, b) => a.localeCompare(b))) {
      const childPath = `${prefix}${name}`;
      const own = pageForDir(childPath.split("/").slice(0, -1).join("/"), name)
        ?? notes.find((note) => note.path === `${childPath}.md`);
      const ownFile = pageForDir(dir, name);
      let holder: string;
      const page = ownFile ?? own;
      if (page) {
        holder = idOf.get(page.path)!;
        job.status = "importing";
        job.phase = `导入 ${page.path}…`;
        job.done += 1;
        const blocks = notionPageToBlocks(entryOf(page.path)!.read().toString("utf8"), index, hooks, () => createId("block"));
        pages.push({
          id: holder,
          title: notionTitle(page.path.split("/").at(-1)!.replace(/\.md$/i, "")),
          blocks,
          parentId,
          ...(isSharedTop && parentId === rootId ? { shareSpaceId: scope } : {}),
        });
        seen.add(page.path);
      } else {
        holder = createId("page");
        pages.push({
          id: holder,
          title: name,
          blocks: [],
          parentId,
          ...(isSharedTop && parentId === rootId ? { shareSpaceId: scope } : {}),
        });
      }
      emit(childPath, holder);
    }
    for (const note of notes.filter((n) => n.path.split("/").slice(0, -1).join("/") === dir)) {
      if (seen.has(note.path)) continue;
      if (subdirs.has(notionTitle(note.path.split("/").at(-1)!.replace(/\.md$/i, "")))) {
        seen.add(note.path);
        continue;
      }
      const id = idOf.get(note.path)!;
      job.status = "importing";
      job.phase = `导入 ${note.path}…`;
      job.done += 1;
      const blocks = notionPageToBlocks(entryOf(note.path)!.read().toString("utf8"), index, hooks, () => createId("block"));
      pages.push({
        id,
        title: notionTitle(note.path.split("/").at(-1)!.replace(/\.md$/i, "")),
        blocks,
        parentId,
        ...(isSharedTop && parentId === rootId ? { shareSpaceId: scope } : {}),
      });
      seen.add(note.path);
    }
  };
  const tops = new Set(entries.map((e) => e.path.split("/")[0]));
  const root = tops.size === 1 && entries.every((e) => e.path.includes("/")) ? [...tops][0] : "";
  emit(root, rootId);

  const topLevelPageIds = directMountId
    ? pages.filter((p) => p.parentId === directMountId).map((p) => p.id)
    : [rootId];

  await commit(store, actor, scope, job, pages, reportTitle, rootId, runHooks);
  job.result = {
    rootPageId: rootId,
    ...(directMountId ? { parentPageId: directMountId } : {}),
    topLevelPageIds,
    title: reportTitle,
    pages: pages.length,
    attachments: stored.size,
    links: 0,
    unresolved,
    warnings,
  };
  job.status = "done";
  job.phase = "完成";
}
