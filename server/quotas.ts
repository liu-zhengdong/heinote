import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { fail, HttpError, type Store } from "./store.ts";

/** Quota subjects: `user:<id>` covers personal records, owned share spaces,
 *  and avatar payloads. `kb:<spaceId>` covers one team knowledge base. */
export type SubjectKind = "user" | "kb";
export interface SubjectRef { kind: SubjectKind; id: string; label: string }
export interface QuotaRow { kind: SubjectKind; id: string; used: number; limit: number; source: "default" | "custom"; over: number }

export const GB = 1_000_000_000;
export const LIMIT_BYTES = z.number().int().min(1).max(1_000_000_000_000_000);
export const TEAM_LIMIT = z.number().int().min(0).max(1_000_000);

const KEYS = {
  personalStorageGB: "personalStorageGB",
  teamStorageGB: "teamStorageGB",
  teamCreation: "teamCreation",
} as const;
export type QuotaDefaults = { personalStorageBytes: number; teamStorageBytes: number; teamCreation: number };
const INITIAL: QuotaDefaults = { personalStorageBytes: 5 * GB, teamStorageBytes: 10 * GB, teamCreation: 5 };

export class Quotas {
  readonly dataDir: string;
  readonly timezone: string;
  constructor(private readonly store: Store, dataDir: string) {
    this.dataDir = resolve(dataDir);
    const zone = process.env.SITE_TIMEZONE?.trim();
    this.timezone = zone ? zone : "UTC";
    try { if (zone) new Intl.DateTimeFormat("en", { timeZone: this.timezone }); }
    catch { throw new Error(`SITE_TIMEZONE 不是有效的 IANA 时区：${zone}`); }

    // UC-33: quota columns and this seeding belong to the migration chain and
    // the baseline CREATE statements. The table itself is still ensured here
    // because a fresh database stamps the latest version without migrating.
    store.db.exec(`CREATE TABLE IF NOT EXISTS site_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    for (const [key, value] of [
      [KEYS.personalStorageGB, "5"],
      [KEYS.teamStorageGB, "10"],
      [KEYS.teamCreation, "5"],
    ] as const) store.db.prepare("INSERT OR IGNORE INTO site_settings VALUES(?,?)").run(key, value);
  }

  private setting(key: string): string { return String(this.store.one("SELECT value FROM site_settings WHERE key=?", key)?.value ?? ""); }

  defaults(): QuotaDefaults {
    const gb = (key: string, fallback: number) => {
      const value = Number(this.setting(key));
      return Number.isFinite(value) && value > 0 ? Math.round(value * GB) : fallback;
    };
    const count = Number(this.setting(KEYS.teamCreation));
    return {
      personalStorageBytes: gb(KEYS.personalStorageGB, INITIAL.personalStorageBytes),
      teamStorageBytes: gb(KEYS.teamStorageGB, INITIAL.teamStorageBytes),
      teamCreation: Number.isInteger(count) && count >= 0 ? count : INITIAL.teamCreation,
    };
  }

  setDefault(key: "personal" | "team" | "creation", value: number): void {
    if (key === "creation") this.store.db.prepare("UPDATE site_settings SET value=? WHERE key=?").run(String(value), KEYS.teamCreation);
    else this.store.db.prepare("UPDATE site_settings SET value=? WHERE key=?").run(String(value / GB), key === "personal" ? KEYS.personalStorageGB : KEYS.teamStorageGB);
  }

  subjectRef(ref: SubjectRef): string { return ref.kind === "kb" ? `kb:${ref.id}` : `user:${ref.id}`; }

  private subjects(): Set<string> {
    const set = new Set<string>();
    for (const row of this.store.all("SELECT id FROM users")) set.add(`user:${String(row.id)}`);
    for (const row of this.store.all("SELECT space_id FROM knowledge_bases")) set.add(`kb:${String(row.space_id)}`);
    return set;
  }

  /** All storage scopes that belong to a quota subject. */
  private scopesOf(subject: string): string[] {
    if (subject.startsWith("user:")) {
      const userId = subject.slice(5);
      const scopes = [subject, `avatar:${userId}`];
      for (const row of this.store.all("SELECT s.id FROM spaces s LEFT JOIN knowledge_bases k ON k.space_id=s.id WHERE s.owner_id=? AND k.space_id IS NULL", userId)) scopes.push(String(row.id));
      return scopes;
    }
    // KB records/files live under the bare space id, not the prefixed subject.
    if (subject.startsWith("kb:")) return [subject.slice(3)];
    return [];
  }

  /** Persisted content bytes for one scope: records, collaboration documents
   *  and retained archives, and deduplicated attachment/avatar payloads. */
  private scopeBytes(scope: string): number {
    const records = Number(this.store.one("SELECT COALESCE(SUM(LENGTH(value)),0) AS n FROM records WHERE scope=?", scope)?.n ?? 0);
    const documents = Number(this.store.one("SELECT COALESCE(SUM(LENGTH(state)),0) AS n FROM collaboration_documents WHERE scope=?", scope)?.n ?? 0);
    const archives = Number(this.store.one("SELECT COALESCE(SUM(LENGTH(state)),0) AS n FROM collaboration_archives WHERE scope=?", scope)?.n ?? 0);
    // Same content hash under one subject counts once (attachments + avatars).
    const files = Number(this.store.one("SELECT COALESCE(SUM(n),0) AS n FROM (SELECT MIN(size) AS n FROM files WHERE scope=? GROUP BY hash)", scope)?.n ?? 0);
    return records + documents + archives + files;
  }

  usage(subject: string): number {
    return this.scopesOf(subject).reduce((sum, scope) => sum + this.scopeBytes(scope), 0);
  }

  /** Subject → usage for every subject that stores data or has an account. */
  usageAll(): Map<string, number> {
    const map = new Map<string, number>();
    for (const subject of this.subjects()) map.set(subject, this.usage(subject));
    return map;
  }

  customLimit(subject: string): number | null {
    if (subject.startsWith("user:")) {
      const row = this.store.one("SELECT storage_limit FROM users WHERE id=?", subject.slice(5));
      return row && row.storage_limit != null ? Number(row.storage_limit) : null;
    }
    if (subject.startsWith("kb:")) {
      const row = this.store.one("SELECT storage_limit FROM knowledge_bases WHERE space_id=?", subject.slice(3));
      return row && row.storage_limit != null ? Number(row.storage_limit) : null;
    }
    return null;
  }

  effectiveLimit(subject: string): { limit: number; source: "default" | "custom" } {
    const defaults = this.defaults();
    const custom = this.customLimit(subject);
    if (custom != null) return { limit: custom, source: "custom" };
    return { limit: subject.startsWith("kb:") ? defaults.teamStorageBytes : defaults.personalStorageBytes, source: "default" };
  }

  quota(subject: string): QuotaRow {
    const used = this.usage(subject);
    const { limit, source } = this.effectiveLimit(subject);
    const kind = subject.startsWith("kb:") ? "kb" as const : "user" as const;
    return { kind, id: subject.slice(subject.indexOf(":") + 1), used, limit, source, over: Math.max(0, used - limit) };
  }

  /** Every subject currently over its effective limit. */
  overList(): QuotaRow[] {
    return [...this.subjects()].map((subject) => this.quota(subject)).filter((row) => row.over > 0);
  }

  userCustomTeamLimit(userId: string): number | null {
    const row = this.store.one("SELECT team_creation_limit FROM users WHERE id=?", userId);
    return row && row.team_creation_limit != null ? Number(row.team_creation_limit) : null;
  }

  teamLimitOf(userId: string): { limit: number; source: "default" | "custom" } {
    const custom = this.userCustomTeamLimit(userId);
    return custom != null ? { limit: custom, source: "custom" } : { limit: this.defaults().teamCreation, source: "default" };
  }

  teamCount(userId: string): number {
    return Number(this.store.one("SELECT count(*) AS n FROM knowledge_bases k JOIN spaces s ON s.id=k.space_id WHERE s.owner_id=?", userId)?.n ?? 0);
  }

  /** V4/E11: create and transfer share the same remaining-slot check. */
  assertTeamSlot(userId: string, extra: string): void {
    const { limit } = this.teamLimitOf(userId);
    const count = this.teamCount(userId);
    if (count >= limit) fail(403, `已拥有 ${count} 个团队知识库，达到创建上限 ${limit}。${extra}`, "team_limit");
  }

  setUserLimits(userId: string, storage: number | null, teamCreation: number | null): void {
    this.store.db.prepare("UPDATE users SET storage_limit=?,team_creation_limit=? WHERE id=?").run(storage, teamCreation, userId);
  }

  setKbLimit(spaceId: string, storage: number | null): void {
    this.store.db.prepare("UPDATE knowledge_bases SET storage_limit=?,revision=revision+1 WHERE space_id=?").run(storage, spaceId);
  }

  /**
   * Quota rule from UC-16: a commit may push usage from U to N only when
   * N ≤ L, or when it does not grow (N ≤ U). Both collapse to: reject when
   * usage grows beyond the effective limit. `base` maps subject → usage U
   * captured before the transaction's writes.
   */
  enforceAfter(base: Map<string, number>): void {
    for (const [subject, before] of base) {
      const after = this.usage(subject);
      if (after <= before) continue;
      const { limit } = this.effectiveLimit(subject);
      if (after <= limit) continue;
      const label = this.describe(subject);
      const error = new HttpError(413, `超出存储限额：${label} 限额 ${formatBytes(limit)}，提交后将占用 ${formatBytes(after)}。请联系站点管理员调整限额，或减少占用后重试。`, "quota_exceeded");
      (error as { quota?: unknown }).quota = { subject, used: before, needed: after, limit };
      throw error;
    }
  }

  /** Check all subjects; expensive but only used for reads that need totals. */
  usageRows(): QuotaRow[] { return [...this.subjects()].map((subject) => this.quota(subject)); }

  describe(subject: string): string {
    if (subject.startsWith("user:")) {
      const user = this.store.userById(subject.slice(5));
      return user ? `「${user.displayName}」的个人空间` : "个人空间";
    }
    if (subject.startsWith("kb:")) {
      const row = this.store.one("SELECT name FROM spaces WHERE id=?", subject.slice(3));
      return row ? `团队知识库「${String(row.name)}」` : "团队知识库";
    }
    return "存储主体";
  }

  /** Physical bytes: sqlite files plus the attachment directory tree. */
  diskUsage(): { databaseBytes: number; attachmentsBytes: number; freeBytes: number | null } {
    let databaseBytes = 0;
    for (const name of ["notes.sqlite", "notes.sqlite-wal", "notes.sqlite-shm"]) {
      try { databaseBytes += statSync(join(this.dataDir, name)).size; } catch { /* absent file */ }
    }
    let attachmentsBytes = 0;
    const walk = (directory: string) => {
      let entries;
      try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) { try { attachmentsBytes += statSync(path).size; } catch { /* race */ } }
      }
    };
    walk(join(this.dataDir, "attachments"));
    let freeBytes: number | null = null;
    try {
      const out = execSync(`df -k "${this.dataDir.replace(/"/g, '\\"')}"`, { encoding: "utf8" }).trim().split("\n").at(-1) ?? "";
      const available = Number(out.trim().split(/\s+/)[3]);
      if (Number.isFinite(available)) freeBytes = available * 1024;
    } catch { freeBytes = null; }
    return { databaseBytes, attachmentsBytes, freeBytes };
  }

  today(): string {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: this.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    return parts;
  }

  /** How many inheriting objects would a proposed default leave over quota. */
  impact(key: "personal" | "team" | "creation", value: number): { affected: number; newlyOver: number; overIds: string[] } {
    const bytes = key === "creation" ? 0 : value;
    let affected = 0, newlyOver = 0; const overIds: string[] = [];
    if (key === "creation") {
      for (const row of this.store.all("SELECT id FROM users WHERE team_creation_limit IS NULL")) {
        const id = String(row.id);
        if (this.userCustomTeamLimit(id) != null) continue;
        affected++;
        if (this.teamCount(id) > value) { newlyOver++; overIds.push(`user:${id}`); }
      }
      return { affected, newlyOver, overIds };
    }
    const subjects = key === "personal"
      ? this.store.all("SELECT id FROM users WHERE storage_limit IS NULL").map((row) => `user:${String(row.id)}`)
      : this.store.all("SELECT space_id FROM knowledge_bases WHERE storage_limit IS NULL").map((row) => `kb:${String(row.space_id)}`);
    for (const subject of subjects) {
      affected++;
      if (this.usage(subject) > bytes) { newlyOver++; overIds.push(subject); }
    }
    return { affected, newlyOver, overIds };
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(Math.round(bytes / GB * 10) / 10)} GB`;
  if (bytes >= 1_000_000) return `${(Math.round(bytes / 1_000_000 * 10) / 10)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}
