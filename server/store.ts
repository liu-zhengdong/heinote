import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import schema, { HISTORY_BUDGET_BYTES } from "../schema.ts";
import { isCurrent } from "../src/core/versions.ts";
import { emptyPlane, Projector, type PlaneRecords, type RecordValue } from "../src/platform/records.ts";
import { historyParts } from "../src/platform/history-record.ts";
import { blockRecordId, parseBlockRecordId, parseHistoryId } from "../src/platform/record-ids.ts";
import type { NotePage, PageVersion, Person, SpaceRole } from "../src/core/types.ts";
import { CollaborationStore } from "./collaboration.ts";
import { FileStore } from "./files.ts";
import { AvatarStore } from "./avatars.ts";
import { KnowledgeBases } from "./knowledge-bases.ts";
import { Quotas } from "./quotas.ts";
import { pageRevision, type ExpectedPage, type TextUpdate } from "../src/collaboration/protocol.ts";

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code = "request_failed") { super(message); }
}
export function fail(status: number, message: string, code?: string): never { throw new HttpError(status, message, code); }
export const id = () => randomUUID();
export const secret = () => randomBytes(32).toString("base64url");
export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export type User = Person & { siteRole: "admin" | "user"; createdAt: string | null };
export type Actor = { user: User; tokenAccess?: "read" | "write"; displayName?: string };
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
  private transactionDepth = 0;
  /** The one-time collaboration rebuild at startup is not a user commit. */
  quotaSuspended = false;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, "notes.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, password TEXT NOT NULL, site_role TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id));
      CREATE TABLE IF NOT EXISTS members(space_id TEXT NOT NULL REFERENCES spaces(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL, PRIMARY KEY(space_id,user_id));
      CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), user_id TEXT NOT NULL REFERENCES users(id), inviter_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL, status TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS invitations_user ON invitations(user_id,status);
      CREATE TABLE IF NOT EXISTS records(scope TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,collection,id));
      CREATE TABLE IF NOT EXISTS tokens(id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, access TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT);
      CREATE TABLE IF NOT EXISTS shares(id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), scope TEXT NOT NULL, page_id TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(user_id TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(user_id,request_id));
      PRAGMA user_version=1;`);
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
  one(sql: string, ...params: Array<string | number>): Row | undefined { return this.all(sql, ...params)[0]; }
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
    if (write && actor.tokenAccess === "read") fail(403, "此令牌仅有读取权限。");
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
    if (role !== "owner" && role !== "admin") fail(403, "需要空间管理权限。");
    return role;
  }
  records(scope: string, collection: string): Array<{ id: string; value: Row }> {
    return this.all("SELECT id,value FROM records WHERE scope=? AND collection=? ORDER BY id", scope, collection).map((row) => ({ id: String(row.id), value: JSON.parse(String(row.value)) }));
  }
  record(scope: string, collection: string, recordId: string): Row | undefined {
    const row = this.one("SELECT value FROM records WHERE scope=? AND collection=? AND id=?", scope, collection, recordId);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  put(scope: string, collection: string, recordId: string, value: Row): void {
    this.db.prepare("INSERT INTO records(scope,collection,id,value) VALUES(?,?,?,?) ON CONFLICT(scope,collection,id) DO UPDATE SET value=excluded.value").run(scope, collection, recordId, JSON.stringify(value));
  }
  plane(scope: string): PlaneRecords {
    return Object.fromEntries(Object.keys(emptyPlane()).map((collection) => [collection, new Map(this.records(scope, collection).map((row) => [row.id, row.value as RecordValue]))])) as unknown as PlaneRecords;
  }
  state(actor: Actor) {
    const planes = new Map<string, PlaneRecords>([["personal", this.plane(`user:${actor.user.id}`)]]);
    for (const member of this.all("SELECT space_id FROM members WHERE user_id=?", actor.user.id)) planes.set(String(member.space_id), this.plane(String(member.space_id)));
    return new Projector().project(planes);
  }
  page(actor: Actor, pageId: string): { page: NotePage; scope: string } {
    const page = this.state(actor).pages[pageId];
    if (!page) fail(404, "页面不存在。", "not_found");
    let current = page;
    const seen = new Set<string>();
    const pages = this.state(actor).pages;
    while (!current.share_space_id && current.parent_id && !seen.has(current.id)) { seen.add(current.id); const parent = pages[current.parent_id]; if (!parent) break; current = parent; }
    const scope = current.share_space_id ?? `user:${actor.user.id}`;
    return { page, scope };
  }
  applyOnce(actor: Actor, requestId: string, writes: Write[], textUpdates: TextUpdate[] = [], expectedPages: ExpectedPage[] = []): Array<Row | null> { return this.apply(actor, writes, requestId, textUpdates, expectedPages); }
  apply(actor: Actor, requested: Write[], requestId?: string, textUpdates: TextUpdate[] = [], expectedPages: ExpectedPage[] = [], maxWrites = 10000): Array<Row | null> {
    if ((!requested.length && !textUpdates.length) || requested.length > maxWrites || textUpdates.length > 1000) fail(400, "写入数量无效。");
    return this.transaction(() => {
      const digest = hash(JSON.stringify({ requested, textUpdates, expectedPages }));
      if (requestId) {
        const cached = this.one("SELECT * FROM requests WHERE user_id=? AND request_id=?", actor.user.id, requestId);
        if (cached) {
          // Recheck current permissions even for retries of committed operations.
          for (const write of requested) this.scope(actor, write.scope, true);
          for (const update of textUpdates) this.scope(actor, update.scope, true);
          if (cached.digest !== digest) fail(409, "请求 ID 已用于其他内容。");
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
      for (const original of requested) {
        const scope = this.scope(actor, original.scope, true);
        const write = this.collaboration.stripProjected(original, scope, approved);
        if (scope !== `user:${actor.user.id}` && write.collection === "workspace_settings") fail(403, "设置仅属于个人。");
        const current = this.record(scope, write.collection, write.id);
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
              if ((!current || current.share_space_id !== next.share_space_id) && this.role(actor, next.share_space_id) !== "owner") fail(403, "只有所有者可设置分享位置。");
              if (scope !== `user:${actor.user.id}` && next.share_space_id !== scope) fail(400, "分享空间不一致。");
            }
            if (current && current.share_space_id !== next.share_space_id && scope !== `user:${actor.user.id}` && this.role(actor, scope) !== "owner") fail(403, "只有所有者可修改分享位置。");
          }
          this.put(scope, write.collection, write.id, next);
        } else {
          this.db.prepare("DELETE FROM records WHERE scope=? AND collection=? AND id=?").run(scope, write.collection, write.id);
          if (write.collection === "pages" && current) {
            // Gone for good means all of it: the record sweep below still
            // holds this write, so paragraphs and history leave with the
            // page or the whole batch is refused.
            this.db.prepare("DELETE FROM records WHERE scope=? AND collection='blocks' AND json_extract(value,'$.page')=?").run(scope, write.id);
            this.db.prepare("DELETE FROM records WHERE scope=? AND collection='versions' AND id LIKE ?").run(scope, `${write.id.length}_${write.id}_%`);
          }
          if (write.collection === "pages" && current?.share_space_id === scope) {
            if (this.role(actor, scope) !== "owner") fail(403, "只有所有者可以结束页面分享。");
            this.db.prepare("DELETE FROM members WHERE space_id=? AND role!='owner'").run(scope);
            this.db.prepare("UPDATE invitations SET status='revoked' WHERE space_id=? AND status='pending'").run(scope);
            this.db.prepare("DELETE FROM shares WHERE scope=?").run(scope);
          }
        }
        result.push(next ?? null); scopes.add(scope);
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
    const { page, scope } = this.page(actor, pageId);
    this.scope(actor, scope.startsWith("user:") ? "personal" : scope, true);
    const latest = Object.values(this.state(actor).versions[pageId] ?? {}).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!restored && latest && isCurrent(latest, page)) return latest;
    const version: PageVersion = { id: id(), page_id: pageId, author_id: actor.user.id, author_name: actor.user.displayName, summary, created_at: now(), snapshot: structuredClone(page), ...(restored ? { restored: true } : {}) };
    if (Buffer.byteLength(JSON.stringify(version)) > HISTORY_BUDGET_BYTES) fail(413, "此页面超过版本保存大小限制。", "too_large");
    for (const part of historyParts(version)) this.put(scope, "versions", part.id, part.value as unknown as Row);
    this.pruneHistory(scope); return version;
  }
  revision(scope: string, pageId: string): string {
    return pageRevision(this.record(scope, "pages", pageId), this.records(scope, "blocks").filter((row) => row.value.page === pageId));
  }
  pageDto(actor: Actor, pageId: string) {
    const { page, scope } = this.page(actor, pageId);
    const blocks = Object.values(page.block_tree.by_id).sort((a, b) => a.order - b.order);
    const text = blocks.map((block) => block.content.map((run) => run.text).join("")).join("\n");
    const revision = this.revision(scope, pageId);
    const collaboration = this.collaboration.snapshot(actor, scope.startsWith("user:") ? "personal" : scope, pageId);
    return { id: page.id, title: page.title, text, revision, scope, page, collaboration: { scope: collaboration.scope, pageId, generation: collaboration.generation, revision } };
  }
  savePage(scope: string, page: NotePage): void {
    this.transaction(() => {
      this.assertPageLocation(scope, page.id);
      const library = this.knowledgeBases.get(scope);
      if (library?.archived) fail(403, "知识库已归档，仅可查看。", "archived");
      const { block_tree, title, title_content, parent_id, ...fields } = page;
      this.put(scope, "pages", page.id, { ...fields, title_content: title_content ?? [{ text: title }], ...(parent_id ? { parent_id } : {}) });
      for (const row of this.records(scope, "blocks")) if (row.value.page === page.id) this.db.prepare("DELETE FROM records WHERE scope=? AND collection='blocks' AND id=?").run(scope, row.id);
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
