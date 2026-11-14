import * as Y from "yjs";
import { z } from "zod";
import { fieldAddress, fieldsInPage, setAt, structureOf, documentKey, isStructureChange, isObject, type DocumentSnapshot, type ExpectedPage, type TextUpdate } from "../src/collaboration/protocol.ts";
import { readFields, seedFields, updateFields } from "../src/collaboration/text.ts";
import type { RichText } from "../src/platform/schema.ts";
import { fail, hash, id, type Actor, type Row, type Store, type Write } from "./store.ts";
import schema from "../schema.ts";

export const textUpdateSchema = z.object({ scope: z.string().min(1).max(256), pageId: z.string().min(1).max(256), generation: z.string().min(1).max(100), update: z.string().max(8 * 1024 * 1024) });
export const expectedPageSchema = z.object({ scope: z.string().min(1).max(256), pageId: z.string().min(1).max(256), generation: z.string().min(1).max(100), revision: z.string().min(1).max(100) });
export interface DocumentEvent { scope: string; pageId: string; type: "document" | "reset" | "removed"; requestId?: string }
const stamp = () => new Date().toISOString();

export class CollaborationStore {
  private readonly listeners = new Set<(events: DocumentEvent[]) => void>();
  private events = new Map<string, DocumentEvent>();
  private forced = new Set<string>();
  private initial = new Map<string, Row | undefined>();
  private requestId: string | undefined;
  markRequest(requestId?: string): void { this.requestId = requestId; }
  constructor(private readonly store: Store) {}

  /** Dirty-page triggers: one lookup per write is fine for edits, deadly for
      bulk commits. suspend/resume swap them out inside a transaction. */
  private static readonly DIRTY_TRIGGERS = `
      CREATE TRIGGER collaboration_insert AFTER INSERT ON records WHEN NEW.collection IN ('pages','blocks') BEGIN
        INSERT INTO collaboration_dirty SELECT NEW.scope,CASE WHEN NEW.collection='pages' THEN NEW.id ELSE json_extract(NEW.value,'$.page') END WHERE NOT EXISTS(SELECT 1 FROM collaboration_dirty WHERE scope=NEW.scope AND page_id=CASE WHEN NEW.collection='pages' THEN NEW.id ELSE json_extract(NEW.value,'$.page') END);
      END;
      CREATE TRIGGER collaboration_update AFTER UPDATE ON records WHEN NEW.collection IN ('pages','blocks') BEGIN
        INSERT INTO collaboration_dirty SELECT NEW.scope,CASE WHEN NEW.collection='pages' THEN NEW.id ELSE json_extract(NEW.value,'$.page') END WHERE NOT EXISTS(SELECT 1 FROM collaboration_dirty WHERE scope=NEW.scope AND page_id=CASE WHEN NEW.collection='pages' THEN NEW.id ELSE json_extract(NEW.value,'$.page') END);
      END;
      CREATE TRIGGER collaboration_delete AFTER DELETE ON records WHEN OLD.collection IN ('pages','blocks') BEGIN
        INSERT INTO collaboration_dirty SELECT OLD.scope,CASE WHEN OLD.collection='pages' THEN OLD.id ELSE json_extract(OLD.value,'$.page') END WHERE NOT EXISTS(SELECT 1 FROM collaboration_dirty WHERE scope=OLD.scope AND page_id=CASE WHEN OLD.collection='pages' THEN OLD.id ELSE json_extract(OLD.value,'$.page') END);
      END;`;

  initialize(): void {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_documents(scope TEXT NOT NULL, page_id TEXT NOT NULL, generation TEXT NOT NULL, structure TEXT NOT NULL, state BLOB NOT NULL, PRIMARY KEY(scope,page_id));
      CREATE TABLE IF NOT EXISTS collaboration_archives(scope TEXT NOT NULL, page_id TEXT NOT NULL, generation TEXT NOT NULL, state BLOB NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope,page_id,generation));
      CREATE TABLE IF NOT EXISTS collaboration_dirty(scope TEXT NOT NULL, page_id TEXT NOT NULL, PRIMARY KEY(scope,page_id));
      DROP TRIGGER IF EXISTS collaboration_insert;
      DROP TRIGGER IF EXISTS collaboration_update;
      DROP TRIGGER IF EXISTS collaboration_delete;
      ${CollaborationStore.DIRTY_TRIGGERS}
      INSERT OR IGNORE INTO collaboration_dirty SELECT scope,id FROM records WHERE collection='pages';
    `);
    this.store.transaction(() => {});
  }
  suspendDirtyTracking(): void {
    this.store.db.exec(`
      DROP TRIGGER IF EXISTS collaboration_insert;
      DROP TRIGGER IF EXISTS collaboration_update;
      DROP TRIGGER IF EXISTS collaboration_delete;
    `);
  }
  resumeDirtyTracking(): void { this.store.db.exec(CollaborationStore.DIRTY_TRIGGERS); }
  begin(): void { this.events.clear(); this.forced.clear(); this.initial.clear(); this.requestId = undefined; }
  rollback(): void { this.events.clear(); this.forced.clear(); this.initial.clear(); this.requestId = undefined; }
  onCommit(listener: (events: DocumentEvent[]) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  committed(): void {
    const events = [...this.events.values()]; this.events.clear(); this.forced.clear();
    for (const listener of this.listeners) { try { listener(events); } catch (error) { console.error("Collaboration notification failed", error); } }
  }
  reset(scope: string, pageId: string): void {
    this.forced.add(documentKey({ scope, pageId }));
    this.store.db.prepare("INSERT OR IGNORE INTO collaboration_dirty VALUES(?,?)").run(scope, pageId);
  }
  private stored(scope: string, pageId: string): Row | undefined { return this.store.one("SELECT * FROM collaboration_documents WHERE scope=? AND page_id=?", scope, pageId); }
  private load(row: Row): Y.Doc { const doc = new Y.Doc(); Y.applyUpdate(doc, row.state as Uint8Array); return doc; }
  private pageData(scope: string, pageId: string) {
    const page = this.store.record(scope, "pages", pageId);
    if (!page || (scope.startsWith("user:") && typeof page.share_space_id === "string")) return null;
    const blocks = this.store.blocksOf(scope, pageId);
    return { page, blocks, fields: fieldsInPage(pageId, page, blocks), structure: hash(JSON.stringify(structureOf(page, blocks))) };
  }
  private writeDoc(scope: string, pageId: string, generation: string, structure: string, doc: Y.Doc, reset: boolean): void {
    const documentId = documentKey({ scope, pageId });
    if (!this.initial.has(documentId)) this.initial.set(documentId, this.stored(scope, pageId));
    this.store.db.prepare("INSERT INTO collaboration_documents VALUES(?,?,?,?,?) ON CONFLICT(scope,page_id) DO UPDATE SET generation=excluded.generation,structure=excluded.structure,state=excluded.state").run(scope, pageId, generation, structure, Y.encodeStateAsUpdate(doc));
    const key = documentKey({ scope, pageId });
    const prior = this.events.get(key);
    this.events.set(key, { scope, pageId, type: reset || prior?.type === "reset" ? "reset" : "document", requestId: this.requestId });
  }
  flush(): void {
    const dirty = this.store.all("SELECT scope,page_id FROM collaboration_dirty ORDER BY scope,page_id");
    const dirtyKeys = new Set(dirty.map((row) => documentKey({ scope: String(row.scope), pageId: String(row.page_id) })));
    for (const row of dirty) {
      const scope = String(row.scope); const pageId = String(row.page_id); const key = documentKey({ scope, pageId });
      const previous = this.stored(scope, pageId); const data = this.pageData(scope, pageId);
      if (!data) {
        if (previous) {
          this.archive(previous);
          this.store.db.prepare("DELETE FROM collaboration_documents WHERE scope=? AND page_id=?").run(scope, pageId);
          this.events.set(key, { scope, pageId, type: "removed" });
        }
        continue;
      }
      if (!previous) {
        // Rehoming may carry the same binary identity to an authorized new scope.
        const moved = this.store.all("SELECT * FROM collaboration_documents WHERE page_id=?", pageId).find((candidate) => {
          const otherScope = String(candidate.scope);
          return dirtyKeys.has(documentKey({ scope: otherScope, pageId })) && !this.pageData(otherScope, pageId);
        });
        const doc = moved ? this.load(moved) : new Y.Doc();
        if (moved && JSON.stringify(Object.keys(readFields(doc)).sort()) === JSON.stringify(Object.keys(data.fields).sort())) updateFields(doc, data.fields, "server");
        else { doc.destroy(); const fresh = new Y.Doc(); seedFields(fresh, data.fields); this.writeDoc(scope, pageId, id(), data.structure, fresh, true); fresh.destroy(); continue; }
        this.writeDoc(scope, pageId, id(), data.structure, doc, true); doc.destroy(); continue;
      }
      const original = this.initial.get(key) ?? previous;
      const originalDoc = this.load(original);
      const originalFields = readFields(originalDoc); originalDoc.destroy();
      const removed = Object.keys(originalFields).some((field) => !(field in data.fields));
      const added = Object.keys(data.fields).some((field) => !(field in originalFields));
      const changedExisting = Object.keys(originalFields).some((field) => field in data.fields && JSON.stringify(originalFields[field]) !== JSON.stringify(data.fields[field]));
      const barrier = removed || added && changedExisting || this.forced.has(key);
      if (barrier) {
        this.archive(original);
        const doc = new Y.Doc(); seedFields(doc, data.fields);
        this.writeDoc(scope, pageId, id(), data.structure, doc, true); doc.destroy();
      } else {
        const doc = this.load(previous);
        if (JSON.stringify(readFields(doc)) !== JSON.stringify(data.fields)) updateFields(doc, data.fields, "server");
        this.writeDoc(scope, pageId, String(previous.generation), data.structure, doc, false);
        doc.destroy();
      }
    }
    this.store.db.prepare("DELETE FROM collaboration_dirty").run();
  }
  private archive(row: Row): void {
    this.store.db.prepare("INSERT OR IGNORE INTO collaboration_archives VALUES(?,?,?,?,?)").run(String(row.scope), String(row.page_id), String(row.generation), row.state as Uint8Array, stamp());
    this.store.db.prepare("DELETE FROM collaboration_archives WHERE rowid IN (SELECT rowid FROM collaboration_archives WHERE scope=? AND page_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 20)").run(String(row.scope), String(row.page_id));
  }
  snapshot(actor: Actor, scopeName: string, pageId: string): DocumentSnapshot {
    const scope = this.store.scope(actor, scopeName);
    const data = this.pageData(scope, pageId);
    if (!data) fail(404, "页面已移走或不存在。", "not_found");
    const row = this.stored(scope, pageId);
    if (!row) fail(409, "协作文档正在初始化。", "not_ready");
    const canEdit = actor.tokenAccess !== "read" && (scope.startsWith("user:") || this.store.role(actor, scope) !== "viewer") && !this.store.knowledgeBases.get(scope)?.archived;
    return { scope: scopeName, pageId, generation: String(row.generation), state: Buffer.from(row.state as Uint8Array).toString("base64"), revision: this.store.revision(scope, pageId), canEdit, records: { page: data.page, blocks: data.blocks } };
  }
  checkExpected(actor: Actor, expected: ExpectedPage[]): void {
    for (const item of expected) {
      const scope = this.store.scope(actor, item.scope, true); const row = this.stored(scope, item.pageId);
      if (!row || row.generation !== item.generation || this.store.revision(scope, item.pageId) !== item.revision) fail(409, "页面已有新修改。结构操作未保存，草稿已保留。", "structure_conflict");
    }
  }
  checkBarriers(actor: Actor, writes: Write[], expected: ExpectedPage[]): void {
    // Whole-vault imports land in scopes with no documents yet; those writes
    // can't collide with existing generations, so skip the per-write lookup.
    const scopesWithDocs = new Set(this.store.all("SELECT DISTINCT scope FROM collaboration_documents").map((row) => String(row.scope)));
    const merge = (value: Row, patch: Row): Row => {
      const result = { ...value };
      for (const [key, entry] of Object.entries(patch)) {
        if (entry === null) delete result[key];
        else result[key] = isObject(entry) ? merge(isObject(result[key]) ? result[key] : {}, entry) : entry;
      }
      return result;
    };
    const scoped = new Map<string, string>();
    const scopeFor = (name: string): string => {
      const cached = scoped.get(name);
      if (cached) return cached;
      const resolved = this.store.scope(actor, name, true);
      scoped.set(name, resolved);
      return resolved;
    };
    const addressed = new Map(expected.map((item) => [documentKey({ scope: scopeFor(item.scope), pageId: item.pageId }), item]));
    for (const write of writes) {
      const scope = scopeFor(write.scope);
      if (!scopesWithDocs.has(scope)) continue;
      const current = this.store.record(scope, write.collection, write.id);
      const pageId = write.collection === "pages" ? write.id : write.collection === "blocks" ? String(current?.page ?? write.value?.page ?? "") : "";
      if (!pageId || !this.stored(scope, pageId)) continue;
      const data = this.pageData(scope, pageId); if (!data) continue;
      const after = write.action === "delete" ? undefined : write.action === "put" ? write.value : merge(current ?? {}, write.patch ?? {});
      const structural = isStructureChange(write.collection, current, after);
      if (structural && !addressed.has(documentKey({ scope, pageId }))) fail(409, "结构操作需要完整页面基础修订。", "structure_conflict");
    }
  }
  applyUpdates(actor: Actor, updates: TextUpdate[]): Set<string> {
    const approved = new Set<string>();
    for (const input of updates) {
      const scope = this.store.scope(actor, input.scope, true); const data = this.pageData(scope, input.pageId); const row = this.stored(scope, input.pageId);
      if (!data || !row) fail(404, "协作页面不存在。", "not_found");
      if (row.generation !== input.generation) fail(409, "页面结构或版本已变化。旧修改保留为草稿。", "generation_conflict");
      const doc = this.load(row);
      const typeId = (text: Y.Text) => { const position = Y.createRelativePositionFromTypeIndex(text, 0); return position.type ? `${position.type.client}:${position.type.clock}` : position.tname; };
      const identities = new Map([...doc.getMap<Y.Text>("fields")].map(([key, text]) => [key, typeId(text)]));
      try {
        try { Y.applyUpdate(doc, Buffer.from(input.update, "base64"), "client"); } catch { fail(400, "协作更新格式无效。", "bad_request"); }
        let projected: Record<string, RichText>;
        try { projected = readFields(doc); } catch { fail(400, "协作更新包含无效字段。", "bad_request"); }
        for (const [key, text] of doc.getMap<Y.Text>("fields")) if (identities.get(key) !== typeId(text)) fail(400, "文字更新不能替换共享字段身份。", "bad_request");
        if (JSON.stringify(Object.keys(projected).sort()) !== JSON.stringify(Object.keys(data.fields).sort()) || Object.keys(doc.toJSON()).some((key) => key !== "fields")) fail(400, "文字更新不能修改页面结构。", "bad_request");
        const nextRecords = new Map<string, { collection: "pages" | "blocks"; id: string; value: Row }>();
        for (const [key, runs] of Object.entries(projected)) {
          const address = fieldAddress(key); if (!address) fail(400, "无效的文字字段。");
          const recordKey = `${address.collection}/${address.id}`;
          const current = nextRecords.get(recordKey)?.value ?? this.store.record(scope, address.collection, address.id);
          if (!current) fail(400, "文字字段缺少所属记录。");
          nextRecords.set(recordKey, { collection: address.collection, id: address.id, value: setAt(current, address.path, runs) });
          approved.add(JSON.stringify([scope, address.collection, address.id, address.path]));
        }
        for (const record of nextRecords.values()) {
          const spec = schema.definition.collections[record.collection];
          const valid = z.object(spec.fields).strict().parse(record.value) as Row;
          this.store.put(scope, record.collection, record.id, valid);
        }
        this.store.put(scope, "pages", input.pageId, { ...this.store.record(scope, "pages", input.pageId), updated_at: stamp(), updated_by: actor.user.displayName });
        this.writeDoc(scope, input.pageId, String(row.generation), String(row.structure), doc, false);
      } finally { doc.destroy(); }
    }
    return approved;
  }
  stripProjected(write: Write, scope: string, approved: Set<string>): Write {
    if (write.action !== "patch" || !write.patch || (write.collection !== "pages" && write.collection !== "blocks")) return write;
    let patch = structuredClone(write.patch);
    const remove = (target: Row, path: string[]): void => {
      const [key, ...rest] = path;
      if (!rest.length) { delete target[key]; return; }
      if (target[key] && typeof target[key] === "object" && !Array.isArray(target[key])) {
        remove(target[key] as Row, rest);
        if (!Object.keys(target[key] as Row).length) delete target[key];
      }
    };
    for (const raw of approved) {
      const [fieldScope, collection, recordId, path] = JSON.parse(raw) as [string, string, string, string[]];
      if (fieldScope === scope && collection === write.collection && recordId === write.id) remove(patch, path);
    }
    if (write.collection === "pages" && approved.size) { delete patch.updated_at; delete patch.updated_by; }
    return { ...write, patch };
  }
  fields(actor: Actor, scopeName: string, pageId: string): { doc: Y.Doc; generation: string; scope: string; fields: Record<string, RichText> } {
    const scope = this.store.scope(actor, scopeName, true); const row = this.stored(scope, pageId);
    if (!row || !this.pageData(scope, pageId)) fail(404, "协作页面不存在。");
    const doc = this.load(row);
    return { doc, scope, generation: String(row.generation), fields: readFields(doc) };
  }
}
