import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import schema, { HISTORY_BUDGET_BYTES } from "../schema.ts";
import { isCurrent } from "../src/core/versions.ts";
import { emptyPlane, Projector, type PlaneRecords, type RecordValue } from "../src/platform/records.ts";
import { historyParts } from "../src/platform/history-record.ts";
import { blockRecordId, parseBlockRecordId, parseHistoryId } from "../src/platform/record-ids.ts";
import type { LoadedNotePage, LoadedWorkspaceState, NotePage, PageVersion, Person, SpaceRole } from "../src/core/types.ts";
import { CollaborationStore } from "./collaboration.ts";
import { FileStore } from "./files.ts";
import { AvatarStore } from "./avatars.ts";
import { KnowledgeBases } from "./knowledge-bases.ts";
import { Quotas } from "./quotas.ts";
import { LATEST_VERSION } from "./migrations/index.ts";
import { DELTA_DDL, DELTA_TRIGGERS } from "./record-delta.ts";
import { documentKey, pageRevision, type ExpectedPage, type TextUpdate } from "../src/collaboration/protocol.ts";

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code = "request_failed") { super(message); }
}
export function fail(status: number, message: string, code?: string): never { throw new HttpError(status, message, code); }
export const id = () => randomUUID();
export const secret = () => randomBytes(32).toString("base64url");
export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export type User = Person & { siteRole: "admin" | "user"; createdAt: string | null };
export type Actor = { user: User; tokenId?: string; tokenAccess?: "read" | "write"; displayName?: string; avatar?: string };
export const asAuthor = (actor: Actor) => actor.displayName ?? actor.user.displayName;
export type Row = Record<string, unknown>;
export type Write = { scope: string; collection: string; id: string; action: "put" | "patch" | "delete"; value?: Row; patch?: Row; base?: Row | null };
export const writeSchema = z.object({ scope: z.string().min(1).max(256), collection: z.enum(["pages", "blocks", "versions", "workspace_settings"]), id: z.string().min(1).max(512), action: z.enum(["put", "patch", "delete"]), value: z.record(z.string(), z.unknown()).optional(), patch: z.record(z.string(), z.unknown()).optional(), base: z.record(z.string(), z.unknown()).nullable().optional() });

const object = (value: unknown): value is Row => Boolean(value && typeof value === "object" && !Array.isArray(value));
const now = () => new Date().toISOString();

// Compare only fields touched by a JSON Merge Patch. Missing fields are distinct.
export function patched(current: Row, patch: Row, base: Row): Row {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) fail(400, "无效字段。");
    if (object(value)) {
      next[key] = patched(object(current[key]) ? current[key] : {}, value, object(base[key]) ? base[key] : {});
    } else {
      const desired = value === null ? undefined : value;
      if (!isDeepStrictEqual(current[key], base[key]) && !isDeepStrictEqual(current[key], desired)) fail(409, "内容已被其他人修改。请保留草稿后重新读取。", "conflict");
      if (value === null) delete next[key]; else next[key] = value;
    }
  }
  return next;
}

export class Store {
  readonly db: DatabaseSync;
  readonly files: FileStore;
  readonly avatars: AvatarStore;
  readonly knowledgeBases: KnowledgeBases;
  readonly collaboration: CollaborationStore;
  readonly quotas!: Quotas;
  readonly dataDir: string;
  private transactionDepth = 0;
  /** The one-time collaboration rebuild at startup is not a user commit. */
  quotaSuspended = false;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.dataDir = resolve(dataDir);
    this.db = new DatabaseSync(join(dataDir, "notes.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`);
    // -2MB default leaves bulk commits walking btree pages from cold disk;
    // 512MB is an upper bound, actual use scales with touched pages.
    this.db.exec(`PRAGMA cache_size=-524288;`);
    const hadUsersTable = Boolean(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get());
    this.db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, password TEXT NOT NULL, site_role TEXT NOT NULL, created_at TEXT, storage_limit INTEGER, team_creation_limit INTEGER);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id));
      CREATE TABLE IF NOT EXISTS members(space_id TEXT NOT NULL REFERENCES spaces(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL, PRIMARY KEY(space_id,user_id));
      CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), user_id TEXT NOT NULL REFERENCES users(id), inviter_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL, status TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS invitations_user ON invitations(user_id,status);
      CREATE TABLE IF NOT EXISTS records(scope TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,collection,id));
      CREATE INDEX IF NOT EXISTS records_page ON records(scope,collection,json_extract(value,'$.page'));
      CREATE TABLE IF NOT EXISTS tokens(id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, display_name TEXT, avatar TEXT, access TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT);
      CREATE TABLE IF NOT EXISTS token_events(id TEXT PRIMARY KEY, token_id TEXT NOT NULL REFERENCES tokens(id), action TEXT NOT NULL, page_id TEXT NOT NULL, page_title TEXT NOT NULL, version_id TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS token_events_token ON token_events(token_id,created_at);
      CREATE TABLE IF NOT EXISTS shares(id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), scope TEXT NOT NULL, page_id TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(user_id TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(user_id,request_id));
      CREATE TABLE IF NOT EXISTS agent_auth_requests(id TEXT PRIMARY KEY, name TEXT NOT NULL, access TEXT NOT NULL, ip TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', user_id TEXT REFERENCES users(id), token_id TEXT REFERENCES tokens(id), granted_token TEXT, created_at TEXT NOT NULL, expires INTEGER NOT NULL, resolved_at TEXT);
      CREATE INDEX IF NOT EXISTS idx_agent_auth_requests_status ON agent_auth_requests(status);
      ${DELTA_DDL}
      ${DELTA_TRIGGERS}`);
    // UC-33: user_version is the migration cursor. A database whose version
    // disagrees with this code means migrateDatabase was skipped (or never
    // ran on a legacy, unstamped file); the constructor refuses rather than
    // guessing. user_version 0 without a users table is a fresh database and
    // gets stamped; 0 with tables is legacy and must migrate first.
    const version = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version === 0 && !hadUsersTable) this.db.exec(`PRAGMA user_version=${LATEST_VERSION}`);
    else if (version !== LATEST_VERSION)
      throw new Error(`数据库版本 ${version} 与本应用版本 ${LATEST_VERSION} 不一致：请先通过 migrateDatabase 完成迁移。`);
    this.db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());
    this.files = new FileStore(this.db, dataDir);
    this.avatars = new AvatarStore(this.db, this.files);
    this.knowledgeBases = new KnowledgeBases(this);
    this.quotas = new Quotas(this, dataDir);
    this.collaboration = new CollaborationStore(this);
    this.quotaSuspended = true;
    try { this.collaboration.initialize(); } finally { this.quotaSuspended = false; }
  }
  all(sql: string, ...params: Array<string | number>): Row[] { return this.db.prepare(sql).all(...params) as Row[]; }
  private readonly prepared = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  private stmt(sql: string): ReturnType<DatabaseSync["prepare"]> {
    let stmt = this.prepared.get(sql);
    if (!stmt) { stmt = this.db.prepare(sql); this.prepared.set(sql, stmt); }
    return stmt;
  }
  private select(sql: string, ...params: Array<string | number>): Row[] { return this.stmt(sql).all(...params) as Row[]; }
  private selectOne(sql: string, ...params: Array<string | number>): Row | undefined { return this.select(sql, ...params)[0]; }
  one(sql: string, ...params: Array<string | number>): Row | undefined { return this.all(sql, ...params)[0]; }
  /** Mark a whole-vault-scale commit: per-write lookups and dirty triggers
      switch to bulk forms. The single transaction and its quotas are kept. */
  private bulk = false;
  bulkTransaction<T>(work: () => T): T {
    const previous = this.bulk;
    this.bulk = true;
    try { return this.transaction(work); }
    finally { this.bulk = previous; }
  }
  transaction<T>(work: () => T): T {
    if (this.transactionDepth) return work();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    // Usage before the transaction's writes; UC-16 judges N against U and L.
    const quotaBase = this.quotas ? this.quotas.usageAll() : new Map<string, number>();
    this.collaboration?.begin();
    let result: T;
    try {
      result = work();
      this.collaboration?.flush();
      // Persisted collaboration state is part of usage, so check after flush.
      if (this.quotas && !this.quotaSuspended) this.quotas.enforceAfter(quotaBase);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.collaboration?.rollback();
      throw error;
    } finally { this.transactionDepth = 0; }
    this.collaboration?.committed();
    return result;
  }
  private avatarUrl(userId: string): string | null {
    const uploaded = this.avatars.url(userId);
    if (uploaded) return uploaded;
    if (!this.one("SELECT name FROM sqlite_master WHERE type='table' AND name='oauth_identities'")) return null;
    const github = this.one("SELECT provider_user_id FROM oauth_identities WHERE provider='github' AND user_id=?", userId);
    return github ? `https://avatars.githubusercontent.com/u/${encodeURIComponent(String(github.provider_user_id))}?s=96` : null;
  }
  user(row: Row): User { return { id: String(row.id), handle: String(row.handle), displayName: String(row.display_name), avatarUrl: this.avatarUrl(String(row.id)), siteRole: row.site_role as User["siteRole"], createdAt: row.created_at == null ? null : String(row.created_at) }; }
  userById(userId: string): User | undefined { const row = this.one("SELECT * FROM users WHERE id=?", userId); return row && this.user(row); }
  scope(actor: Actor, requested: string, write = false): string {
    if (write && actor.tokenAccess === "read") fail(403, "此令牌仅有读取权限。", "read_only");
    if (requested === "personal") return `user:${actor.user.id}`;
    const role = this.role(actor, requested);
    if (write && role === "viewer") fail(403, "此空间仅可查看。", "read_only");
    if (write && this.knowledgeBases.get(requested)?.archived) fail(403, "知识库已归档，仅可查看。", "archived");
    return requested;
  }
  private assertPageLocation(scope: string, pageId: string): void {
    const targetIsLibrary = Boolean(this.knowledgeBases.get(scope));
    const existing = this.all("SELECT r.scope,k.space_id FROM records r LEFT JOIN knowledge_bases k ON k.space_id=r.scope WHERE r.collection='pages' AND r.id=?", pageId);
    if (existing.some((row) => row.scope !== scope && (targetIsLibrary || row.space_id !== null))) {
      fail(403, "页面不能迁入或迁出团队知识库。", "knowledge_base_boundary");
    }
  }
  role(actor: Actor, spaceId: string): SpaceRole {
    const member = this.one("SELECT role FROM members WHERE space_id=? AND user_id=?", spaceId, actor.user.id);
    if (!member) fail(403, "没有此空间的访问权限。", "forbidden");
    return member.role as SpaceRole;
  }
  manage(actor: Actor, spaceId: string): SpaceRole {
    const role = this.role(actor, spaceId);
    if (role !== "owner" && role !== "admin") fail(403, "需要空间管理权限。", "forbidden");
    return role;
  }
  records(scope: string, collection: string): Array<{ id: string; value: Row }> {
    return this.all("SELECT id,value FROM records WHERE scope=? AND collection=? ORDER BY id", scope, collection).map((row) => ({ id: String(row.id), value: JSON.parse(String(row.value)) }));
  }
  /** The collection's watermark, lazily seeded: collections whose rows all
   *  predate the changelog (or that nobody wrote since) carry no record_seq
   *  row, and reporting 0 there tells clients to cold-pull the whole
   *  collection on every poll (ISS-12). The first read plants seq=1 — later
   *  writes bump it through the trigger like anywhere else. */
  private watermark(scope: string, collection: string): number {
    const found = this.one("SELECT seq FROM record_seq WHERE scope=? AND collection=?", scope, collection);
    if (found) return Number(found.seq);
    this.db.prepare("INSERT INTO record_seq SELECT ?,?,1 WHERE NOT EXISTS(SELECT 1 FROM record_seq WHERE scope=? AND collection=?)").run(scope, collection, scope, collection);
    return 1;
  }
  /** The collection's watermark plus the rows touched after `after`: each
   *  changed row under its record id, and each removed row's id under
   *  `deleted`. `after` 0 yields the whole collection (rows written before
   *  the changelog never entered it, so they're read from `records`). */
  recordsSince(scope: string, collection: string, after: number): { latest: number; rows: Array<{ id: string; value: Row }>; deleted: string[] } {
    const latest = this.watermark(scope, collection);
    if (after <= 0) return { latest, rows: this.records(scope, collection), deleted: [] };
    const changed = this.all(`SELECT c.id,c.deleted,r.value FROM record_changes c LEFT JOIN records r ON r.scope=c.scope AND r.collection=c.collection AND r.id=c.id
      WHERE c.scope=? AND c.collection=? AND c.seq>? ORDER BY c.seq`, scope, collection, after);
    const rows: Array<{ id: string; value: Row }> = []; const deleted: string[] = [];
    for (const row of changed) {
      if (Number(row.deleted) || row.value == null) deleted.push(String(row.id));
      else rows.push({ id: String(row.id), value: JSON.parse(String(row.value)) });
    }
    return { latest, rows, deleted };
  }
  /** The same delta, limited to records that belong to one of `pageIds`:
   *  rows match through their `page` field (via the records_page index on a
   *  cold read) and tombstones through the page-scoped record id
   *  (`<len>_<pageId>_<rest>`). UC-48 lazy loading polls per loaded page. */
  recordsSincePages(scope: string, collection: string, pageIds: string[], after: number): { latest: number; rows: Array<{ id: string; value: Row }>; deleted: string[] } {
    const latest = this.watermark(scope, collection);
    const wanted = new Set(pageIds);
    const inPage = (id: string, value: Row | null): boolean => {
      if (value && typeof value.page === "string") return wanted.has(value.page);
      const parsed = /^(\d+)_/.exec(id);
      if (parsed) {
        const length = Number(parsed[1]);
        if (wanted.has(id.slice(parsed[0].length, parsed[0].length + length))) return true;
      }
      return false;
    };
    if (after <= 0) {
      const marks = pageIds.map(() => "?").join(",");
      // The records_page index answers blocks-by-page directly; other
      // collections fall back to the page-scoped id prefix.
      const found = this.all(`SELECT id,value FROM records WHERE scope=? AND collection=? AND json_extract(value,'$.page') IN (${marks})`, scope, collection, ...pageIds)
        .map((row) => ({ id: String(row.id), value: JSON.parse(String(row.value)) }));
      // Rows whose record id names one of the pages but whose value lacks a
      // `page` field miss the index; the page-scoped id prefix finds them
      // without a full scan.
      const prefixes = pageIds.map((pageId) => `${pageId.length}_${pageId}_`);
      // GLOB, not LIKE: LIKE can't decompose 'p%' into a range scan unless
      // case_sensitive_like is on, so SQLite scanned the whole partition
      // (and visited every row for id) on every cold pull — 132k reads per
      // request melted production (ISS-13). GLOB 'p*' uses the PK prefix
      // index directly. `_` is not a GLOB metachar, prefixes need no escape.
      const extra = this.all(`SELECT id,value FROM records WHERE scope=? AND collection=? AND (${prefixes.map(() => "id GLOB ?").join(" OR ")})`,
        scope, collection, ...prefixes.map((prefix) => `${prefix}*`))
        .filter((row) => !new Set(found.map((found) => found.id)).has(String(row.id)))
        .map((row) => ({ id: String(row.id), value: JSON.parse(String(row.value)) }));
      return { latest, rows: [...found, ...extra], deleted: [] };
    }
    const changed = this.all(`SELECT c.id,c.deleted,r.value FROM record_changes c LEFT JOIN records r ON r.scope=c.scope AND r.collection=c.collection AND r.id=c.id
      WHERE c.scope=? AND c.collection=? AND c.seq>? ORDER BY c.seq`, scope, collection, after);
    const rows: Array<{ id: string; value: Row }> = []; const deleted: string[] = [];
    for (const row of changed) {
      const id = String(row.id);
      if (Number(row.deleted) || row.value == null) { if (inPage(id, null)) deleted.push(id); continue; }
      const value = JSON.parse(String(row.value)) as Row;
      if (inPage(id, value)) rows.push({ id, value });
    }
    return { latest, rows, deleted };
  }
  /** Exact reads by record id — rebase needs just the rows a failed batch
   *  touched, not the whole collection (UC-48). */
  recordsByIds(scope: string, collection: string, ids: string[]): Array<{ id: string; value: Row }> {
    if (!ids.length) return [];
    const marks = ids.map(() => "?").join(",");
    return this.all(`SELECT id,value FROM records WHERE scope=? AND collection=? AND id IN (${marks})`, scope, collection, ...ids)
      .map((row) => ({ id: String(row.id), value: JSON.parse(String(row.value)) }));
  }
  /** One page's paragraphs. Uses the page-key expression index; records(scope,"blocks") would scan the whole plane per page. */
  blocksOf(scope: string, pageId: string): Array<{ id: string; value: Row }> {
    return this.all("SELECT id,value FROM records WHERE scope=? AND collection='blocks' AND json_extract(value,'$.page')=? ORDER BY id", scope, pageId).map((row) => ({ id: String(row.id), value: JSON.parse(String(row.value)) }));
  }
  record(scope: string, collection: string, recordId: string): Row | undefined {
    const row = this.selectOne("SELECT value FROM records WHERE scope=? AND collection=? AND id=?", scope, collection, recordId);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  put(scope: string, collection: string, recordId: string, value: Row): void {
    this.stmt("INSERT INTO records(scope,collection,id,value) VALUES(?,?,?,?) ON CONFLICT(scope,collection,id) DO UPDATE SET value=excluded.value").run(scope, collection, recordId, JSON.stringify(value));
  }
  plane(scope: string): PlaneRecords {
    return Object.fromEntries(Object.keys(emptyPlane()).map((collection) => [collection, new Map(this.records(scope, collection).map((row) => [row.id, row.value as RecordValue]))])) as unknown as PlaneRecords;
  }
  /* The server's window is everything: no lazy bodies server-side, so the
     projected pages are all LoadedNotePage (UC-48). */
  state(actor: Actor): LoadedWorkspaceState {
    const planes = new Map<string, PlaneRecords>([["personal", this.plane(`user:${actor.user.id}`)]]);
    for (const member of this.all("SELECT space_id FROM members WHERE user_id=?", actor.user.id)) planes.set(String(member.space_id), this.plane(String(member.space_id)));
    return new Projector().project(planes) as LoadedWorkspaceState;
  }
  /** The raw pages record wherever the member holds it: their own plane
   *  first, then each space they belong to — the same visibility window
   *  `state()` merged. A handful of primary-key reads, not a vault scan. */
  pageRecord(actor: Actor, pageId: string): Row | undefined {
    const own = this.record(`user:${actor.user.id}`, "pages", pageId);
    if (own) return own;
    for (const member of this.all("SELECT space_id FROM members WHERE user_id=?", actor.user.id)) {
      const found = this.record(String(member.space_id), "pages", pageId);
      if (found) return found;
    }
    return undefined;
  }
  /** One page and its ancestor chain as planes for the Projector — the
   *  chain is what `withoutUnhomed` needs to keep the page, and its
   *  `share_space_id` root is what names the page's scope. `state()` would
   *  read and parse every record in the vault (~140k rows here) for one
   *  page; per-page callers (checkpoint, pageDto, agent mutations) each
   *  did that per request and melted the CPU (ISS-13). */
  private pagePlanes(actor: Actor, pageId: string): Map<string, PlaneRecords> {
    const personal = `user:${actor.user.id}`;
    const spaces = this.all("SELECT space_id FROM members WHERE user_id=?", actor.user.id).map((row) => String(row.space_id));
    // Find the page, then walk parent records up to the tree root. A
    // shared page's paragraphs and history live in the space plane while
    // the sharer's own plane keeps only its pages row — the same split the
    // records mirror maintains — so ancestors land in whichever scope
    // holds them.
    const byId = new Map<string, { scope: string; value: Row }>();
    let cursor: string | undefined = pageId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const current: string = cursor;
      const scope = [personal, ...spaces].find((scope) => this.record(scope, "pages", current));
      if (!scope) break;
      const value: Row = this.record(scope, "pages", current)!;
      byId.set(current, { scope, value });
      cursor = typeof value.parent_id === "string" ? value.parent_id : undefined;
    }
    if (!byId.has(pageId)) return new Map();
    const planes = new Map<string, PlaneRecords>();
    const planeOf = (scope: string): PlaneRecords => {
      let plane = planes.get(scope);
      if (!plane) planes.set(scope, plane = { pages: new Map(), blocks: new Map(), versions: new Map(), workspace_settings: new Map() });
      return plane;
    };
    for (const [id, { scope, value }] of byId) {
      const plane = planeOf(scope);
      (plane.pages as Map<string, RecordValue>).set(id, value);
      if (id !== pageId) continue;
      for (const row of this.blocksOf(scope, id)) (plane.blocks as Map<string, RecordValue>).set(row.id, row.value);
      const prefix = `${id.length}_${id}_`;
      for (const row of this.all("SELECT id,value FROM records WHERE scope=? AND collection='versions' AND id GLOB ?", scope, `${prefix}*`)) {
        (plane.versions as Map<string, RecordValue>).set(String(row.id), JSON.parse(String(row.value)) as RecordValue);
      }
    }
    // Projector treats the member's own rows under the "personal" key.
    const out = new Map<string, PlaneRecords>();
    for (const [scope, plane] of planes) out.set(scope === personal ? "personal" : scope, plane);
    return out;
  }
  private pageProjection(actor: Actor, pageId: string): { projected: LoadedWorkspaceState; page: LoadedNotePage; scope: string } {
    const projected = new Projector().project(this.pagePlanes(actor, pageId)) as LoadedWorkspaceState;
    const page = projected.pages[pageId];
    if (!page) fail(404, "页面不存在。", "not_found");
    // The chain that decides scope: raw records are enough — the page and
    // its ancestors' location markers, not their projected trees.
    let current: Row = page;
    const seen = new Set<string>();
    while (!current.share_space_id && current.parent_id && !seen.has(String(current.id))) {
      seen.add(String(current.id));
      const parent = this.pageRecord(actor, String(current.parent_id));
      if (!parent) break;
      current = parent;
    }
    const scope = (current.share_space_id as string | undefined) ?? `user:${actor.user.id}`;
    return { projected, page, scope };
  }
  page(actor: Actor, pageId: string): { page: LoadedNotePage; scope: string } {
    const { page, scope } = this.pageProjection(actor, pageId);
    return { page, scope };
  }
  applyOnce(actor: Actor, requestId: string, writes: Write[], textUpdates: TextUpdate[] = [], expectedPages: ExpectedPage[] = []): Array<Row | null> { return this.apply(actor, writes, requestId, textUpdates, expectedPages); }
  apply(actor: Actor, requested: Write[], requestId?: string, textUpdates: TextUpdate[] = [], expectedPages: ExpectedPage[] = [], maxWrites = 10000): Array<Row | null> {
    if ((!requested.length && !textUpdates.length) || requested.length > maxWrites || textUpdates.length > 1000) fail(400, "写入数量无效。");
    return this.transaction(() => {
      // The digest exists for replay detection; bulk calls without a
      // requestId (imports) never cache, so skip the JSON pass entirely.
      const digest = requestId ? hash(JSON.stringify({ requested, textUpdates, expectedPages })) : "";
      if (requestId) {
        const cached = this.one("SELECT * FROM requests WHERE user_id=? AND request_id=?", actor.user.id, requestId);
        if (cached) {
          // Recheck current permissions even for retries of committed operations.
          for (const write of requested) this.scope(actor, write.scope, true);
          for (const update of textUpdates) this.scope(actor, update.scope, true);
          if (cached.digest !== digest) fail(409, "请求 ID 已用于其他内容。", "request_id_conflict");
          return JSON.parse(String(cached.result)) as Array<Row | null>;
        }
      }
      // Capture ownership before any source record can be deleted in this batch.
      for (const write of requested) {
        const scope = this.scope(actor, write.scope, true);
        const pageId = write.collection === "pages" ? write.id : write.collection === "blocks" ? parseBlockRecordId(write.id)?.pageId : write.collection === "versions" ? parseHistoryId(write.id)?.pageId : undefined;
        if (pageId) this.assertPageLocation(scope, pageId);
      }
      this.collaboration.markRequest(requestId);
      this.collaboration.checkExpected(actor, expectedPages);
      this.collaboration.checkBarriers(actor, requested, expectedPages);
      const approved = this.collaboration.applyUpdates(actor, textUpdates);
      const result: Array<Row | null> = [];
      const scopes = new Set<string>(textUpdates.map((update) => this.scope(actor, update.scope)));
      // Bulk path: permission checks, conflict lookups and dirty tracking
      // repeat per write otherwise — a whole-vault import is ~10^5 writes,
      // which turns every cold index page into a random disk read.
      const scoped = new Map<string, string>();
      const scopeFor = (name: string): string => {
        if (!this.bulk) return this.scope(actor, name, true);
        const cached = scoped.get(name);
        if (cached) return cached;
        const resolved = this.scope(actor, name, true);
        scoped.set(name, resolved);
        return resolved;
      };
      // Pages that the transaction itself dirtied: bulk commits suspend the
      // per-write trigger and mark them in one indexed insert at the end.
      const dirtyPages = new Set<string>();
      if (this.bulk) this.collaboration.suspendDirtyTracking();
      try {
      for (const original of requested) {
        const scope = scopeFor(original.scope);
        const write = this.collaboration.stripProjected(original, scope, approved);
        if (scope !== `user:${actor.user.id}` && write.collection === "workspace_settings") fail(403, "设置仅属于个人。");
        // Bulk fast path: a brand-new put needs no existence read. Try the
        // insert; a primary-key hit falls back to the full conflict check.
        let current: Row | undefined;
        let fastInserted = false;
        if (this.bulk && write.action === "put" && write.value && write.base == null) {
          try {
            this.stmt("INSERT INTO records(scope,collection,id,value) VALUES(?,?,?,?)").run(scope, write.collection, write.id, JSON.stringify(write.value));
            fastInserted = true;
          } catch (error) {
            if ((error as { errcode?: number }).errcode !== 1555) throw error;
          }
        }
        if (!fastInserted) current = this.record(scope, write.collection, write.id);
        if (write.collection === "pages") dirtyPages.add(documentKey({ scope, pageId: write.id }));
        else if (write.collection === "blocks") dirtyPages.add(documentKey({ scope, pageId: String(current?.page ?? write.value?.page ?? "") }));
        const library = this.knowledgeBases.get(scope);
        if (library && write.collection === "pages" && write.action === "delete") {
          if (write.id === library.homePageId) fail(403, "知识库首页不能删除。", "knowledge_base_home");
          if (!["owner", "admin"].includes(this.role(actor, scope))) fail(403, "永久删除需要知识库管理权限。", "forbidden");
        }
        let next: Row | undefined;
        if (write.action === "put") {
          if (!write.value) fail(400, "缺少记录内容。");
          if (current && !isDeepStrictEqual(current, write.base) && !isDeepStrictEqual(current, write.value)) fail(409, "记录已修改。", "conflict");
          next = write.value;
        } else if (write.action === "patch") {
          if (!current) fail(409, "记录已删除。", "conflict");
          if (!write.patch || !write.base) fail(400, "修改必须携带原记录。");
          next = patched(current, write.patch, write.base);
        } else {
          if (current && !isDeepStrictEqual(current, write.base)) fail(409, "记录已修改，无法删除。", "conflict");
        }
        if (next) {
          const spec = schema.definition.collections[write.collection as keyof typeof schema.definition.collections];
          next = z.object(spec.fields).strict().parse(next) as Row;
          if (write.collection === "pages") {
            if (next.id !== write.id) fail(400, "页面 ID 不一致。");
            if (next.share_space_id) {
              if (typeof next.share_space_id !== "string") fail(400, "空间无效。");
              if (scope.startsWith("user:") && this.knowledgeBases.get(next.share_space_id)) fail(403, "团队知识库不使用个人分享指针。", "knowledge_base_boundary");
              // Changing a tree's sharing home is the owner's operation.
              if ((!current || current.share_space_id !== next.share_space_id) && this.role(actor, next.share_space_id) !== "owner") fail(403, "只有所有者可设置分享位置。", "owner_required");
              if (scope !== `user:${actor.user.id}` && next.share_space_id !== scope) fail(400, "分享空间不一致。");
            }
            if (current && current.share_space_id !== next.share_space_id && scope !== `user:${actor.user.id}` && this.role(actor, scope) !== "owner") fail(403, "只有所有者可修改分享位置。", "owner_required");
          }
          if (!fastInserted) this.put(scope, write.collection, write.id, next);
        } else {
          this.stmt("DELETE FROM records WHERE scope=? AND collection=? AND id=?").run(scope, write.collection, write.id);
          if (write.collection === "pages" && current) {
            // Gone for good means all of it: the record sweep below still
            // holds this write, so paragraphs and history leave with the
            // page or the whole batch is refused.
            this.stmt("DELETE FROM records WHERE scope=? AND collection='blocks' AND json_extract(value,'$.page')=?").run(scope, write.id);
            this.stmt("DELETE FROM records WHERE scope=? AND collection='versions' AND id LIKE ?").run(scope, `${write.id.length}_${write.id}_%`);
          }
          if (write.collection === "pages" && current?.share_space_id === scope) {
            if (this.role(actor, scope) !== "owner") fail(403, "只有所有者可以结束页面分享。", "owner_required");
            this.stmt("DELETE FROM members WHERE space_id=? AND role!='owner'").run(scope);
            this.stmt("UPDATE invitations SET status='revoked' WHERE space_id=? AND status='pending'").run(scope);
            this.stmt("DELETE FROM shares WHERE scope=?").run(scope);
          }
        }
        result.push(next ?? null); scopes.add(scope);
      }
      } finally {
        if (this.bulk) this.collaboration.resumeDirtyTracking();
      }
      if (this.bulk && dirtyPages.size) {
        // flush() reads collaboration_dirty, so the marks must exist before
        // the transaction's commit-time projection sweep.
        const mark = this.stmt("INSERT OR IGNORE INTO collaboration_dirty VALUES(?,?)");
        for (const entry of dirtyPages) {
          const [scope, pageId] = JSON.parse(entry) as [string, string];
          mark.run(scope, pageId);
        }
      }
      // Validate the complete transaction, after sharing has moved all records.
      for (const scope of scopes) this.validatePlane(actor, scope);
      for (const scope of scopes) this.pruneHistory(scope);
      if (requestId) this.db.prepare("INSERT INTO requests VALUES(?,?,?,?)").run(actor.user.id, requestId, digest, JSON.stringify(result));
      return result;
    });
  }
  private validatePlane(actor: Actor | undefined, scope: string): void {
    const pages = new Map(this.records(scope, "pages").map((row) => [row.id, row.value]));
    const library = this.knowledgeBases.get(scope);
    if (library) {
      const home = pages.get(library.homePageId);
      if (!home || home.parent_id != null || home.share_space_id !== scope || home.archived) fail(403, "知识库首页不能删除、归档或移动。", "knowledge_base_home");
    }
    for (const [pageId, page] of pages) {
      if (library && pageId !== library.homePageId && page.share_space_id !== undefined) fail(400, "知识库页面必须继承首页的空间。", "knowledge_base_boundary");
      const seen = new Set([pageId]);
      let parentId = page.parent_id;
      while (typeof parentId === "string") {
        if (seen.has(parentId)) fail(400, "页面不能形成循环。");
        seen.add(parentId);
        const parent = pages.get(parentId);
        if (!parent) {
          if (page.share_space_id === scope) break;
          fail(400, "父页面必须位于同一空间。");
        }
        parentId = parent.parent_id;
      }
      if (library && !seen.has(library.homePageId)) fail(400, "知识库页面必须位于首页下。", "knowledge_base_boundary");
      if (!scope.startsWith("user:")) {
        let root = page;
        const visited = new Set<string>();
        while (root.share_space_id !== scope && typeof root.parent_id === "string" && !visited.has(String(root.id))) {
          visited.add(String(root.id));
          const parent = pages.get(root.parent_id);
          if (!parent) break;
          root = parent;
        }
        if (root.share_space_id !== scope) fail(400, "空间页面必须属于已分享的页面树。");
      }
      // A private sharing pointer must refer to a space the writer can read.
      if (actor && scope === `user:${actor.user.id}` && typeof page.share_space_id === "string") this.role(actor, page.share_space_id);
    }
    for (const collection of ["blocks", "versions"]) for (const row of this.records(scope, collection)) {
      if (!pages.has(String(row.value.page))) fail(400, "记录必须属于当前空间的页面。");
      if (collection === "blocks") {
        const parsed = parseBlockRecordId(row.id);
        if (!parsed || parsed.pageId !== row.value.page || parsed.blockId !== row.value.id) fail(400, "段落 ID 与页面不一致。");
      } else {
        const parsed = parseHistoryId(row.id);
        if (!parsed || parsed.pageId !== row.value.page || parsed.versionId !== row.value.version || parsed.part !== row.value.part) fail(400, "历史 ID 与页面不一致。");
      }
    }
  }
  pruneHistory(scope: string): void {
    const rows = this.records(scope, "versions");
    const groups = new Map<string, typeof rows>();
    for (const row of rows) { const key = `${row.value.page}/${row.value.version}`; groups.set(key, [...groups.get(key) ?? [], row]); }
    const byPage = new Map<string, Array<{ rows: typeof rows; time: string; bytes: number }>>();
    for (const parts of groups.values()) {
      const pageId = String(parts[0].value.page);
      byPage.set(pageId, [...byPage.get(pageId) ?? [], { rows: parts, time: String(parts[0].value.created_at), bytes: Buffer.byteLength(JSON.stringify(parts)) }]);
    }
    for (const entries of byPage.values()) {
      let bytes = 0;
      entries.sort((a, b) => b.time.localeCompare(a.time)).forEach((entry, index) => {
        bytes += entry.bytes;
        if (index >= 20 || bytes > 10 * 1024 * 1024 || Date.parse(entry.time) < Date.now() - 30 * 86400000) for (const row of entry.rows) this.db.prepare("DELETE FROM records WHERE scope=? AND collection='versions' AND id=?").run(scope, row.id);
      });
    }
  }
  checkpoint(actor: Actor, pageId: string, summary: string, restored = false): PageVersion {
    const { projected, page, scope } = this.pageProjection(actor, pageId);
    this.scope(actor, scope.startsWith("user:") ? "personal" : scope, true);
    const latest = Object.values(projected.versions[pageId] ?? {}).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!restored && latest && isCurrent(latest, page)) return latest;
    const version: PageVersion = { id: id(), page_id: pageId, author_id: actor.user.id, author_name: asAuthor(actor), author_avatar_url: actor.avatar ?? null, summary, created_at: now(), snapshot: structuredClone(page), ...(restored ? { restored: true } : {}) };
    if (Buffer.byteLength(JSON.stringify(version)) > HISTORY_BUDGET_BYTES) fail(413, "此页面超过版本保存大小限制。", "too_large");
    for (const part of historyParts(version)) this.put(scope, "versions", part.id, part.value as unknown as Row);
    this.pruneHistory(scope); return version;
  }
  revision(scope: string, pageId: string): string {
    return pageRevision(this.record(scope, "pages", pageId), this.blocksOf(scope, pageId));
  }
  pageDto(actor: Actor, pageId: string) {
    const { page, scope } = this.page(actor, pageId);
    const blocks = Object.values(page.block_tree.by_id).sort((a, b) => a.order - b.order);
    const text = blocks.map((block) => block.content.map((run) => run.text).join("")).join("\n");
    const revision = this.revision(scope, pageId);
    const collaboration = this.collaboration.snapshot(actor, scope.startsWith("user:") ? "personal" : scope, pageId);
    return { id: page.id, title: page.title, text, revision, scope, page, collaboration: { scope: collaboration.scope, pageId, generation: collaboration.generation, revision } };
  }
  savePage(scope: string, page: LoadedNotePage): void {
    this.transaction(() => {
      this.assertPageLocation(scope, page.id);
      const library = this.knowledgeBases.get(scope);
      if (library?.archived) fail(403, "知识库已归档，仅可查看。", "archived");
      const { block_tree, title, title_content, parent_id, ...fields } = page;
      this.put(scope, "pages", page.id, { ...fields, title_content: title_content ?? [{ text: title }], ...(parent_id ? { parent_id } : {}) });
      for (const row of this.blocksOf(scope, page.id)) this.db.prepare("DELETE FROM records WHERE scope=? AND collection='blocks' AND id=?").run(scope, row.id);
      for (const block of Object.values(block_tree.by_id)) {
        const { parent_id: parent, ...rest } = block;
        this.put(scope, "blocks", blockRecordId(page.id, block.id), { ...rest, page: page.id, ...(parent ? { parent_id: parent } : {}), content: block.content.map((run) => run.mention ? { embed: { mention: run.mention }, ...(run.marks ? { marks: run.marks } : {}) } : run) });
      }
      if (library) this.validatePlane(undefined, scope);
    });
  }
  /** The share's page subtree with full page records, and the owner actor
   *  reads and writes under it — the public app bridge re-runs this walk. */
  shareTree(token: string): { owner: User; root: NotePage; pages: NotePage[]; scope: string } {
    const share = this.one("SELECT * FROM shares WHERE token=?", token);
    if (!share || this.knowledgeBases.get(String(share.scope))) fail(404, "分享链接已失效。", "not_found");
    const owner = this.userById(String(share.user_id));
    if (!owner) fail(404, "分享链接已失效。");
    let actual;
    try { actual = this.page({ user: owner }, String(share.page_id)); } catch { fail(404, "分享链接已失效。"); }
    if (actual.scope !== share.scope || actual.page.archived) fail(404, "分享链接已失效。");
    const all = this.state({ user: owner }).pages;
    const pages: NotePage[] = [];
    const queue = [actual.page]; const seen = new Set<string>();
    while (queue.length) {
      const page = queue.shift()!;
      if (seen.has(page.id) || page.archived) continue;
      seen.add(page.id);
      pages.push(page);
      for (const child of Object.values(all)) if (child.parent_id === page.id && this.page({ user: owner }, child.id).scope === actual.scope) queue.push(child);
    }
    return { owner, root: actual.page, pages, scope: actual.scope };
  }

  published(token: string): { title: string; pages: Array<Omit<NotePage, "app"> & { app?: { enabled?: string } }>; scope: string } {
    const { root, pages, scope } = this.shareTree(token);
    return {
      title: root.title,
      /* A shared app publishes its enabled source — running it is what a
       *  share is for — but the draft and the binding list stay private;
       *  data flows through the public bridge, per-binding. */
      pages: pages.map((page) => {
        const { app: pageApp, ...rest } = page as NotePage;
        return { ...rest, ...(pageApp?.enabled ? { app: { enabled: pageApp.enabled } } : {}) };
      }),
      scope,
    };
  }
}
