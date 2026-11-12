import { createHash, randomBytes } from "node:crypto";
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { basename, join } from "node:path";
import type { Request, Response } from "express";
import { z } from "zod";
import { ZipStream } from "../src/core/zip.ts";
import { fail, HttpError, type Store } from "./store.ts";
import { snapshotDatabaseFile, stagedDirectory } from "./snapshot.mjs";
import { createWebdavTarget, WebdavError, type DavEntry, type WebdavTarget } from "./webdav.ts";

/* UC-31 自动备份站点数据到云盘。编排：在线快照 → 流式 zip 归档 → 分片
   WebDAV 上传（续传按分片粒度）→ manifest 提交 → 保留清理 → state.json。
   常驻内存固定小缓冲：数据库快照走 node:sqlite backup()，附件按 files
   索引流式进 zip，上传分片用 fd.read 分段喂流，不整片载入。 */

const DEFAULTS = {
  enabled: false,
  schedule: { hour: 3, minute: 0 },
  retention: 7,
  chunkBytes: 128 * 1024 * 1024,
} as const;

const MIN_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK_BYTES = 512 * 1024 * 1024;
const UPLOAD_SLICE = 8 * 1024 * 1024;
const RETRY_DELAYS = [5_000, 20_000, 60_000];

export interface BackupOptions {
  /** Part-upload retry waits; tests inject short delays. */
  retryDelays?: number[];
}
const ARCHIVE_RE = /^heinote-backup-(.+?)\.manifest\.json$|^heinote-backup-(.+?)\.part-(\d+)$/;

export type FailureKind = "auth" | "network" | "other";

export interface BackupConfig {
  enabled: boolean;
  webdav: { url: string; user: string; password: string };
  schedule: { hour: number; minute: number };
  retention: number;
  chunkBytes: number;
}

export interface BackupPending {
  archiveId: string;
  file: string;
  url: string;
  user: string;
}

export interface BackupState {
  running: boolean;
  runningSince: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastResult: "ok" | "auth" | "network" | "other" | "interrupted" | null;
  lastError: string | null;
  lastArchiveId: string | null;
  remoteCount: number | null;
  pending: BackupPending | null;
}

export interface BackupRunResult {
  kind: "ok" | "skipped" | FailureKind;
  archiveId?: string;
  error?: string;
  resumed?: boolean;
  remoteCount?: number | null;
}

interface BackupTargetFactory {
  (options: { url: string; user: string; password: string }): WebdavTarget;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const todayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Server-local-timezone schedule (UC-31 design): the daily slot is the
 *  configured wall-clock time in the server's own timezone. An
 *  `interrupted` result does not consume the day's slot; any other
 *  finished result does. A failed day is not retried automatically. */
export function nextDue(now: Date, config: Pick<BackupConfig, "enabled" | "schedule">, state: Pick<BackupState, "running" | "lastStartedAt" | "lastResult">): boolean {
  if (!config.enabled || state.running) return false;
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), config.schedule.hour, config.schedule.minute);
  if (now.getTime() < due.getTime()) return false;
  if (state.lastStartedAt && state.lastResult && state.lastResult !== "interrupted") {
    if (todayKey(new Date(state.lastStartedAt)) === todayKey(now)) return false;
  }
  return true;
}

export class Backups {
  private readonly backupsDir: string;
  private readonly configFile: string;
  private readonly stateFile: string;
  private readonly retryDelays: number[];
  private runningFlag = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly store: Pick<Store, "quotas"> | null,
    private readonly makeTarget: BackupTargetFactory = createWebdavTarget,
    options: BackupOptions = {},
  ) {
    this.retryDelays = options.retryDelays ?? RETRY_DELAYS;
    this.backupsDir = join(dataDir, "backups");
    this.configFile = join(dataDir, "backup-config.json");
    this.stateFile = join(this.backupsDir, "state.json");
    mkdirSync(this.backupsDir, { recursive: true, mode: 0o700 });
    this.startupCleanup();
  }

  /* ————— configuration ————— */

  config(): BackupConfig {
    let raw: Partial<BackupConfig> = {};
    try { raw = JSON.parse(readFileSync(this.configFile, "utf8")); } catch { /* absent or corrupt */ }
    const webdav = raw.webdav ?? { url: "", user: "", password: "" };
    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULTS.enabled,
      webdav: {
        url: String(webdav.url ?? "").trim(),
        user: String(webdav.user ?? "").trim(),
        password: String(webdav.password ?? ""),
      },
      schedule: {
        hour: Number.isInteger(raw.schedule?.hour) ? Number(raw.schedule!.hour) : DEFAULTS.schedule.hour,
        minute: Number.isInteger(raw.schedule?.minute) ? Number(raw.schedule!.minute) : DEFAULTS.schedule.minute,
      },
      retention: Number.isInteger(raw.retention) ? Number(raw.retention) : DEFAULTS.retention,
      chunkBytes: Number.isInteger(raw.chunkBytes) ? Number(raw.chunkBytes) : DEFAULTS.chunkBytes,
    };
  }

  private saveConfig(config: BackupConfig): void {
    writeFileSync(this.configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }

  private validate(input: BackupConfig): void {
    try { new URL(input.webdav.url); } catch { fail(400, "WebDAV 地址格式无效。"); }
    if (!/^https?:\/\//i.test(input.webdav.url)) fail(400, "WebDAV 地址必须是 http(s) 地址。");
    if (!input.webdav.user) fail(400, "请填写 WebDAV 账号。");
    if (!input.webdav.password) fail(400, "请填写 WebDAV 密码或应用专用密码。");
    const { hour, minute } = input.schedule;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59)
      fail(400, "执行时间必须是 00:00–23:59 之间的时刻。");
    if (!Number.isInteger(input.retention) || input.retention < 1 || input.retention > 100) fail(400, "保留份数必须是 1–100 的整数。");
    if (!Number.isInteger(input.chunkBytes) || input.chunkBytes < MIN_CHUNK_BYTES || input.chunkBytes > MAX_CHUNK_BYTES)
      fail(400, "分片大小必须在 4–512 MiB 之间。");
  }

  updateSettings(input: { enabled?: boolean; webdav?: { url?: string; user?: string; password?: string }; schedule?: { hour?: number; minute?: number }; retention?: number; chunkBytes?: number }): BackupConfig {
    const current = this.config();
    const next: BackupConfig = {
      enabled: input.enabled !== undefined ? input.enabled : current.enabled,
      webdav: {
        url: input.webdav?.url !== undefined ? String(input.webdav.url).trim() : current.webdav.url,
        user: input.webdav?.user !== undefined ? String(input.webdav.user).trim() : current.webdav.user,
        // Empty password keeps the stored one.
        password: input.webdav?.password ? String(input.webdav.password) : current.webdav.password,
      },
      schedule: {
        hour: input.schedule?.hour !== undefined ? Number(input.schedule.hour) : current.schedule.hour,
        minute: input.schedule?.minute !== undefined ? Number(input.schedule.minute) : current.schedule.minute,
      },
      retention: input.retention !== undefined ? Number(input.retention) : current.retention,
      chunkBytes: input.chunkBytes !== undefined ? Number(input.chunkBytes) : current.chunkBytes,
    };
    this.validate(next);
    this.saveConfig(next);
    return next;
  }

  maskedConfig() {
    const config = this.config();
    return {
      enabled: config.enabled,
      webdav: { url: config.webdav.url, user: config.webdav.user, passwordSet: Boolean(config.webdav.password) },
      schedule: config.schedule,
      retention: config.retention,
      chunkBytes: config.chunkBytes,
    };
  }

  /* ————— state ————— */

  private emptyState(): BackupState {
    return { running: false, runningSince: null, lastStartedAt: null, lastFinishedAt: null, lastResult: null, lastError: null, lastArchiveId: null, remoteCount: null, pending: null };
  }

  private readStateFile(): BackupState {
    let parsed: Partial<BackupState> = {};
    try { parsed = JSON.parse(readFileSync(this.stateFile, "utf8")); } catch { /* absent */ }
    return { ...this.emptyState(), ...parsed };
  }

  state(): BackupState {
    const state = this.readStateFile();
    state.running = this.runningFlag;
    return state;
  }

  private writeState(state: BackupState): void {
    writeFileSync(this.stateFile, `${JSON.stringify({ ...state, running: state.running }, null, 2)}\n`);
  }

  /** Discard run leftovers from a previous process and reset a stale
   *  `running` marker to an interrupted record. */
  private startupCleanup(): void {
    try {
      for (const name of readdirSync(this.backupsDir)) {
        if (name.startsWith(".upload-") && name.endsWith(".zip.tmp")) rmSync(join(this.backupsDir, name), { force: true });
        else if (name.startsWith("snapshot-") || name.startsWith(".notes-backup-")) rmSync(join(this.backupsDir, name), { recursive: true, force: true });
      }
    } catch { /* best effort */ }
    const state = this.readStateFile();
    if (state.running) {
      this.writeState({
        ...state,
        running: false,
        runningSince: null,
        lastFinishedAt: new Date().toISOString(),
        lastResult: "interrupted",
        lastError: "服务在上次备份完成前重启，该次记录为中断。",
      });
    }
  }

  /* ————— probe ————— */

  async testConnection(overrides?: { url?: string; user?: string; password?: string }): Promise<{ ok: boolean; warning?: string; kind?: FailureKind; error?: string }> {
    const stored = this.config();
    const url = overrides?.url !== undefined ? String(overrides.url).trim() : stored.webdav.url;
    const user = overrides?.user !== undefined ? String(overrides.user).trim() : stored.webdav.user;
    const password = overrides?.password ? String(overrides.password) : stored.webdav.password;
    if (!url) return { ok: false, kind: "other", error: "请先填写 WebDAV 地址。" };
    const warning = /^http:\/\//i.test(url) ? "目标使用 http 明文传输凭据，建议改用 https。" : undefined;
    try {
      const target = this.makeTarget({ url, user, password });
      await target.ensureCollection();
      await target.list();
      return { ok: true, warning };
    } catch (error) {
      if (error instanceof WebdavError) return { ok: false, kind: error.kind, error: error.message, warning };
      return { ok: false, kind: "other", error: (error as Error).message, warning };
    }
  }

  /* ————— one run ————— */

  /** Trigger a run now (scheduler path and 立即备份 share it). */
  async run(trigger: "schedule" | "manual"): Promise<BackupRunResult> {
    if (this.runningFlag) return { kind: "skipped", error: "备份已在进行中。" };
    const config = this.config();
    if (!config.webdav.url || !config.webdav.user || !config.webdav.password) {
      return trigger === "manual" ? { kind: "other", error: "尚未配置 WebDAV 目标。" } : { kind: "skipped" };
    }
    this.runningFlag = true;
    const startedAt = new Date().toISOString();
    this.writeState({ ...this.state(), running: true, runningSince: startedAt, lastStartedAt: startedAt });
    let result: BackupRunResult = { kind: "other", error: "备份未执行。" };
    try {
      result = await this.execute(config);
    } catch (error) {
      result = {
        kind: error instanceof WebdavError ? error.kind : "other",
        error: (error as Error).message,
      };
    } finally {
      this.runningFlag = false;
      const finished = this.state();
      this.writeState({
        ...finished,
        running: false,
        runningSince: null,
        lastFinishedAt: new Date().toISOString(),
        lastResult: result.kind === "skipped" ? finished.lastResult : result.kind,
        lastError: result.error ?? null,
        lastArchiveId: result.archiveId ?? finished.lastArchiveId,
        remoteCount: result.remoteCount ?? finished.remoteCount,
        pending: result.kind === "ok" ? null : finished.pending,
      });
    }
    return result;
  }

  private async execute(config: BackupConfig): Promise<BackupRunResult> {
    const state = this.state();
    const target = this.makeTarget({ url: config.webdav.url, user: config.webdav.user, password: config.webdav.password });
    await target.ensureCollection();

    const pending = state.pending;
    if (pending && existsSync(join(this.backupsDir, pending.file))
      && pending.url === config.webdav.url && pending.user === config.webdav.user) {
      // Resume the interrupted upload of an existing local archive.
      return await this.upload(config, target, pending.archiveId, pending.file, true);
    }

    const fresh = await this.buildArchive();
    try {
      this.writeState({ ...this.state(), pending: { archiveId: fresh.archiveId, file: basename(fresh.file), url: config.webdav.url, user: config.webdav.user } });
      return await this.upload(config, target, fresh.archiveId, basename(fresh.file), false);
    } finally {
      rmSync(fresh.snapshotDir, { recursive: true, force: true });
    }
  }

  /** Snapshot the database, stream the zip to `.upload-*.zip.tmp`, publish
   *  as `archive-<stamp>.zip`. Attachments stream from DATA_DIR/attachments
   *  by the snapshot's `files` index — no second copy of the tree. */
  private async buildArchive(): Promise<{ stamp: string; archiveId: string; file: string; snapshotDir: string }> {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-");
    const archiveId = `${stamp}-${randomBytes(2).toString("hex")}`;

    // Disk precheck: snapshot (≈ db bytes) + archive (≈ db + attachments).
    const usage = this.store?.quotas.diskUsage();
    if (usage?.freeBytes != null) {
      const needed = usage.databaseBytes * 2 + usage.attachmentsBytes + 64 * 1024 * 1024;
      if (usage.freeBytes < needed) fail(507, `磁盘空间不足：预计需要 ${Math.ceil(needed / 1e9)} GB，可用 ${Math.floor(usage.freeBytes / 1e9)} GB。`);
    }

    const staging = stagedDirectory(this.backupsDir);
    let snapshotDir = "";
    try {
      await snapshotDatabaseFile(join(this.dataDir, "notes.sqlite"), staging.dir);
      snapshotDir = staging.finalize(`snapshot-${stamp}`);

      const tmpZip = join(this.backupsDir, `.upload-${stamp}.zip.tmp`);
      const fd = openSync(tmpZip, "w", 0o600);
      try {
        const zip = new ZipStream({ write: (chunk) => { writeSync(fd, chunk); } });
        const dbSize = statSync(join(snapshotDir, "notes.sqlite")).size;
        if (dbSize > 0xffff_ff00) throw new Error("归档超过 zip 格式上限（单条目约 4 GiB）。");
        await zip.add("notes.sqlite", fileChunks(join(snapshotDir, "notes.sqlite")));

        const missing: Array<{ hash: string; size: number }> = [];
        const snapshotDb = new DatabaseSync(join(snapshotDir, "notes.sqlite"), { readOnly: true });
        try {
          const rows = snapshotDb.prepare("SELECT DISTINCT hash, size FROM files ORDER BY hash").all() as Array<{ hash: string; size: number }>;
          const attachmentsDir = join(this.dataDir, "attachments");
          for (const row of rows) {
            const hash = String(row.hash);
            if (!/^[0-9a-f]{64}$/i.test(hash)) { missing.push({ hash, size: Number(row.size) }); continue; }
            const location = join(attachmentsDir, hash.slice(0, 2), hash);
            try {
              await zip.add(`attachments/${hash.slice(0, 2)}/${hash}`, fileChunks(location));
            } catch {
              missing.push({ hash, size: Number(row.size) });
            }
          }
        } finally {
          snapshotDb.close();
        }
        if (missing.length) await zip.add("missing.json", JSON.stringify({ missing }, null, 2));
        zip.finish();
      } finally {
        closeSync(fd);
      }
      const file = join(this.backupsDir, `archive-${stamp}.zip`);
      renameSync(tmpZip, file);
      return { stamp, archiveId, file, snapshotDir };
    } catch (error) {
      // zip32 overflow, snapshot failure, ENOSPC — clean up the run's artifacts.
      try { rmSync(join(this.backupsDir, `.upload-${stamp}.zip.tmp`), { force: true }); } catch { /* best effort */ }
      if (snapshotDir) rmSync(snapshotDir, { recursive: true, force: true });
      throw error;
    } finally {
      staging.cleanup();
    }
  }

  private async upload(config: BackupConfig, target: WebdavTarget, archiveId: string, fileName: string, resumed: boolean): Promise<BackupRunResult> {
    const file = join(this.backupsDir, fileName);
    const bytes = statSync(file).size;
    const parts = Math.max(1, Math.ceil(bytes / config.chunkBytes));
    const prefix = `heinote-backup-${archiveId}`;

    const remote = new Map<string, DavEntry>();
    for (const entry of await target.list()) remote.set(entry.name, entry);

    const fd = openSync(file, "r");
    try {
      for (let index = 0; index < parts; index += 1) {
        const name = `${prefix}.part-${index + 1}`;
        const offset = index * config.chunkBytes;
        const length = Math.min(config.chunkBytes, bytes - offset);
        const known = remote.get(name);
        if (known && Number.isFinite(known.size) && known.size === length) continue; // 已传分片跳过
        await this.putPart(target, name, fd, offset, length);
      }
    } finally {
      closeSync(fd);
    }

    const sha256 = await sha256File(file);
    const manifest = {
      version: 1,
      app: "heinote",
      archiveId,
      createdAt: new Date().toISOString(),
      bytes,
      sha256,
      chunkBytes: config.chunkBytes,
      parts: Array.from({ length: parts }, (_v, index) => ({
        name: `${prefix}.part-${index + 1}`,
        size: Math.min(config.chunkBytes, bytes - index * config.chunkBytes),
      })),
    };
    // The manifest is the commit marker: a group is complete iff it exists.
    await target.putBuffer(`${prefix}.manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));

    const remoteCount = await this.retention(target, config.retention, archiveId);
    rmSync(file, { force: true });
    return { kind: "ok", archiveId, resumed, remoteCount };
  }

  private async putPart(target: WebdavTarget, name: string, fd: number, offset: number, length: number): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retryDelays.length; attempt += 1) {
      try {
        const stream = Readable.from(sliceChunks(fd, offset, length));
        await target.put(name, stream, length);
        return;
      } catch (error) {
        lastError = error;
        if (error instanceof WebdavError && error.kind === "auth") throw error;
        if (attempt < this.retryDelays.length) await sleep(this.retryDelays[attempt]);
      }
    }
    throw lastError;
  }

  /** Group remote objects by archive id (`<ts>-<rand4>`): full groups
   *  (manifest present) obey the retention cap; groups without a manifest
   *  are orphans unless they are the pending group — orphans older than
   *  24h are removed. Returns the remote group count for state display. */
  private async retention(target: WebdavTarget, retention: number, pendingId: string | null): Promise<number | null> {
    try {
      const entries = await target.list();
      const groups = new Map<string, { names: string[]; manifest: boolean; modified: number }>();
      for (const entry of entries) {
        const match = ARCHIVE_RE.exec(entry.name);
        if (!match) continue;
        const id = match[1] ?? match[2];
        const group = groups.get(id) ?? { names: [], manifest: false, modified: 0 };
        group.names.push(entry.name);
        if (match[1] != null) group.manifest = true;
        const when = entry.modifiedAt ? Date.parse(entry.modifiedAt) : 0;
        group.modified = Math.max(group.modified, when);
        groups.set(id, group);
      }
      const complete = [...groups.entries()].filter(([, g]) => g.manifest).sort(([a], [b]) => a.localeCompare(b));
      const removedGroups = new Set<string>();
      const remove: string[] = [];
      for (let index = 0; index < complete.length - retention; index += 1) {
        remove.push(...complete[index][1].names);
        removedGroups.add(complete[index][0]);
      }
      const orphanAfter = Date.now() - 24 * 3600_000;
      for (const [id, group] of groups) {
        if (group.manifest || id === pendingId) continue;
        if (group.modified && group.modified < orphanAfter) {
          remove.push(...group.names);
          removedGroups.add(id);
        }
      }
      for (const name of remove) await target.remove(name).catch(() => undefined);
      return groups.size - removedGroups.size;
    } catch {
      return null; // Retention failure is a warning, never fails the run.
    }
  }

  /* ————— scheduler ————— */

  startScheduler(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        if (nextDue(new Date(), this.config(), this.state())) void this.run("schedule");
      } catch { /* a tick must never crash the process */ }
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

async function* fileChunks(path: string): AsyncIterable<Uint8Array> {
  const stream = createReadStream(path, { highWaterMark: 4 * 1024 * 1024 });
  for await (const chunk of stream) yield chunk as Uint8Array;
}

async function* sliceChunks(fd: number, offset: number, length: number): AsyncIterable<Uint8Array> {
  let position = offset;
  let remaining = length;
  const buffer = Buffer.allocUnsafe(Math.min(UPLOAD_SLICE, length));
  while (remaining > 0) {
    const want = Math.min(buffer.length, remaining);
    const got = readSync(fd, buffer, 0, want, position);
    if (got <= 0) throw new Error(`读取归档分片失败（offset ${position}）。`);
    position += got;
    remaining -= got;
    yield buffer.subarray(0, got);
  }
}

async function sha256File(path: string): Promise<string> {
  const sha = createHash("sha256");
  for await (const chunk of fileChunks(path)) sha.update(chunk);
  return sha.digest("hex");
}

/* ————— admin routes ————— */

export function attachAdminBackupRoutes(app: import("express").Express, backups: Backups, admin: (req: Request) => unknown): void {
  const settingsSchema = z.object({
    enabled: z.boolean().optional(),
    webdav: z.object({ url: z.string().max(2048).optional(), user: z.string().max(512).optional(), password: z.string().max(512).optional() }).optional(),
    schedule: z.object({ hour: z.number().int().min(0).max(23).optional(), minute: z.number().int().min(0).max(59).optional() }).optional(),
    retention: z.number().int().min(1).max(100).optional(),
    chunkBytes: z.number().int().min(MIN_CHUNK_BYTES).max(MAX_CHUNK_BYTES).optional(),
  });

  app.get("/api/admin/backups", (req: Request, res: Response) => {
    admin(req);
    res.json({ config: backups.maskedConfig(), state: backups.state() });
  });

  app.put("/api/admin/backups/settings", (req: Request, res: Response) => {
    admin(req);
    const input = settingsSchema.parse(req.body ?? {});
    backups.updateSettings(input);
    res.json({ config: backups.maskedConfig() });
  });

  app.post("/api/admin/backups/test", async (req: Request, res: Response) => {
    admin(req);
    const body = (req.body ?? {}) as { webdav?: { url?: string; user?: string; password?: string } };
    const result = await backups.testConnection(body.webdav);
    res.json(result);
  });

  app.post("/api/admin/backups/run", async (req: Request, res: Response) => {
    admin(req);
    const result = await backups.run("manual");
    if (result.kind === "ok" || result.kind === "skipped") res.json({ result, state: backups.state() });
    else throw new HttpError(502, result.error ?? "备份失败。", result.kind);
  });
}
