import type { Express, Request } from "express";
import * as Y from "yjs";
import { z } from "zod";
import schema, { BLOCK_KINDS, CONTENT_COLORS } from "../schema.ts";
import { blockField, fieldAddress, setAt, type ExpectedPage, type TextUpdate } from "../src/collaboration/protocol.ts";
import { fieldOf, readFields, readText } from "../src/collaboration/text.ts";
import { isKeptLink } from "../src/core/inline-content.ts";
import { blockRecordId } from "../src/platform/record-ids.ts";
import { fail, hash, id, type Actor, type Row, type Store, type Write } from "./store.ts";

const identifier = z.string().min(1).max(256);
const position = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const toggle = z.boolean().nullable().optional();
const marks = z.object({
  bold: toggle, italic: toggle, underline: toggle, strike: toggle, code: toggle,
  link: z.string().max(4096).refine(isKeptLink, "链接必须使用 http、https 或页面引用。").nullable().optional(),
  color: z.enum(CONTENT_COLORS).nullable().optional(),
}).strict();
const operationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("insert_text"), blockId: identifier, index: z.union([z.literal("start"), z.literal("end"), position]), text: z.string().max(100000) }).strict(),
  z.object({ type: z.literal("delete_text"), blockId: identifier, index: position, length: position }).strict(),
  z.object({ type: z.literal("format_text"), blockId: identifier, index: position, length: position, marks }).strict(),
  z.object({ type: z.literal("insert_block"), afterId: identifier.optional(), text: z.string().max(100000), kind: z.enum(BLOCK_KINDS).optional() }).strict(),
  z.object({ type: z.literal("delete_block"), blockId: identifier }).strict(),
  z.object({ type: z.literal("move_block"), blockId: identifier, parentId: identifier.nullable().optional(), order: z.number().finite() }).strict(),
]);
const commandSchema = z.object({
  requestId: z.string().min(1).max(256), generation: z.string().min(1).max(100),
  baseRevision: z.string().min(1).max(100).optional(), mode: z.enum(["apply", "suggest"]).default("apply"),
  operations: z.array(operationSchema).min(1).max(100),
}).strict();
const reviewSchema = z.object({ baseRevision: z.string().min(1).max(100).optional() }).strict();
type Operation = z.infer<typeof operationSchema>;
type Command = z.infer<typeof commandSchema>;
type Reply = { status: number; body: object };
type BlockRow = { id: string; value: Row };
type Plan = { writes: Write[]; textUpdates: TextUpdate[]; expectedPages: ExpectedPage[] };

const externalScope = (actual: string) => actual.startsWith("user:") ? "personal" : actual;
const structural = (operation: Operation) => operation.type === "insert_block" || operation.type === "delete_block" || operation.type === "move_block";
const needsRevision = (operations: Operation[]) => operations.some((operation) => structural(operation) || operation.type !== "insert_text" || typeof operation.index === "number");
const parentOf = (block: Row) => typeof block.parent_id === "string" ? block.parent_id : null;

function authorizedPage(store: Store, who: Actor, pageId: string, write: boolean, requestedScope?: string) {
  const found = store.page(who, pageId);
  const scopeName = externalScope(found.scope);
  const actual = store.scope(who, scopeName, write);
  if (requestedScope !== undefined && store.scope(who, requestedScope, write) !== actual) fail(404, "页面不属于指定空间。", "not_found");
  return { ...found, scopeName };
}

function boundary(text: Y.Text, index: number): void {
  if (index > text.length) fail(400, "文字范围超出段落。", "bad_request");
  const plain = readText(text).map((run) => run.text ?? "\ufffc").join("");
  if (index > 0 && index < plain.length) {
    const left = plain.charCodeAt(index - 1); const right = plain.charCodeAt(index);
    if (left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff) fail(400, "文字范围不能切开 emoji 字符。", "bad_request");
  }
}

function validParents(blocks: Map<string, BlockRow>): void {
  for (const [blockId, block] of blocks) {
    const seen = new Set([blockId]);
    let parent = parentOf(block.value);
    while (parent !== null) {
      if (seen.has(parent)) fail(400, "段落不能形成循环。", "bad_request");
      seen.add(parent);
      const ancestor = blocks.get(parent);
      if (!ancestor) fail(400, "父段落必须位于当前页面。", "bad_request");
      parent = parentOf(ancestor.value);
    }
  }
}

function planOperations(store: Store, who: Actor, scopeName: string, pageId: string, generation: string, revision: string, operations: Operation[], requireBasis: boolean): Plan {
  const loaded = store.collaboration.fields(who, scopeName, pageId);
  const doc = loaded.doc;
  const before = Y.encodeStateVector(doc);
  const original = new Map(store.records(loaded.scope, "blocks").filter(({ value }) => value.page === pageId).map((row) => [String(row.value.id), row]));
  const working = new Map([...original].map(([key, row]) => [key, structuredClone(row)]));
  const newTexts = new Map<string, Y.Text>();
  const newDocs: Y.Doc[] = [];
  const find = (blockId: string): BlockRow => {
    const block = working.get(blockId);
    if (!block) fail(404, "段落不存在或不属于当前页面。", "not_found");
    return block;
  };
  const textOf = (blockId: string): Y.Text => {
    const row = find(blockId);
    const fresh = newTexts.get(blockId);
    if (fresh) return fresh;
    const key = blockField(row.id);
    if (!(doc.getMap("fields").get(key) instanceof Y.Text)) fail(409, "段落的协作字段已变化。", "generation_conflict");
    return fieldOf(doc, key);
  };
  try {
    doc.transact(() => {
      for (const operation of operations) {
        if (operation.type === "insert_block") {
          const after = operation.afterId ? find(operation.afterId) : undefined;
          const parent = after ? parentOf(after.value) : null;
          const siblings = [...working.values()].filter((row) => parentOf(row.value) === parent).sort((a, b) => Number(a.value.order) - Number(b.value.order) || a.id.localeCompare(b.id));
          const previous = after ? Number(after.value.order) : Number(siblings.at(-1)?.value.order ?? 0);
          const next = after ? siblings.find((row) => Number(row.value.order) > previous) : undefined;
          const order = next ? previous + (Number(next.value.order) - previous) / 2 : previous + 1024;
          if (!Number.isFinite(order) || order <= previous || (next && order >= Number(next.value.order))) fail(409, "段落顺序需要重新整理。", "structure_conflict");
          const blockId = id(); const recordId = blockRecordId(pageId, blockId);
          const fresh = new Y.Doc(); newDocs.push(fresh);
          const text = fieldOf(fresh, blockField(recordId)); text.insert(0, operation.text);
          newTexts.set(blockId, text);
          working.set(blockId, { id: recordId, value: { id: blockId, page: pageId, kind: operation.kind ?? "text", order, ...(parent ? { parent_id: parent } : {}), content: readText(text) } });
          continue;
        }
        if (operation.type === "delete_block") {
          find(operation.blockId);
          const remove = new Set([operation.blockId]);
          for (let changed = true; changed;) {
            changed = false;
            for (const [blockId, row] of working) if (!remove.has(blockId) && remove.has(parentOf(row.value) ?? "")) { remove.add(blockId); changed = true; }
          }
          for (const blockId of remove) working.delete(blockId);
          continue;
        }
        if (operation.type === "move_block") {
          const row = find(operation.blockId);
          const parent = operation.parentId === undefined ? parentOf(row.value) : operation.parentId;
          if (parent !== null) find(parent);
          if (parent === operation.blockId) fail(400, "段落不能成为自身的父段落。", "bad_request");
          row.value.order = operation.order;
          if (parent === null) delete row.value.parent_id; else row.value.parent_id = parent;
          continue;
        }
        const text = textOf(operation.blockId);
        const index = operation.index === "start" ? 0 : operation.index === "end" ? text.length : operation.index;
        boundary(text, index);
        if (operation.type === "insert_text") text.insert(index, operation.text);
        else {
          const end = index + operation.length;
          if (!Number.isSafeInteger(end)) fail(400, "文字范围无效。", "bad_request");
          boundary(text, end);
          if (operation.type === "delete_text") text.delete(index, operation.length);
          else text.format(index, operation.length, Object.fromEntries(Object.entries(operation.marks).filter(([, value]) => value !== undefined)));
        }
      }
    }, "agent");
    validParents(working);
    const projectedBases = new Map([...original.values()].map((row) => [row.id, row.value]));
    for (const [key, runs] of Object.entries(readFields(doc))) {
      const address = fieldAddress(key);
      if (address?.collection !== "blocks") continue;
      const base = projectedBases.get(address.id);
      if (base) projectedBases.set(address.id, setAt(base, address.path, runs));
    }
    const writes: Write[] = [];
    for (const [blockId, row] of original) {
      const next = working.get(blockId);
      if (!next) {
        // The coordinator applies the CRDT update before structural writes.
        writes.push({ scope: scopeName, collection: "blocks", id: row.id, action: "delete", base: projectedBases.get(row.id)! });
      } else {
        const patch: Row = {};
        if (parentOf(next.value) !== parentOf(row.value)) patch.parent_id = parentOf(next.value);
        if (next.value.order !== row.value.order) patch.order = next.value.order;
        if (Object.keys(patch).length) writes.push({ scope: scopeName, collection: "blocks", id: row.id, action: "patch", patch, base: row.value });
      }
    }
    for (const [blockId, row] of working) if (!original.has(blockId)) {
      row.value.content = readText(newTexts.get(blockId)!);
      const value = z.object(schema.definition.collections.blocks.fields).strict().parse(row.value) as Row;
      writes.push({ scope: scopeName, collection: "blocks", id: row.id, action: "put", value, base: null });
    }
    return {
      writes,
      textUpdates: [{ scope: scopeName, pageId, generation, update: Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64") }],
      expectedPages: requireBasis ? [{ scope: scopeName, pageId, generation, revision }] : [],
    };
  } finally { doc.destroy(); newDocs.forEach((fresh) => fresh.destroy()); }
}

function execute(store: Store, who: Actor, pageId: string, scopeName: string, input: Pick<Command, "generation" | "baseRevision" | "operations">, suggest: boolean): object {
  const current = store.collaboration.snapshot(who, scopeName, pageId);
  if (!current.canEdit) fail(403, "此页面仅可查看。", "read_only");
  if (current.generation !== input.generation) fail(409, "页面结构或版本已变化。请重新读取。", "generation_conflict");
  if (needsRevision(input.operations) && !input.baseRevision) fail(400, "数值范围与结构操作必须携带页面基础修订。", "bad_request");
  if (input.baseRevision !== undefined && input.baseRevision !== current.revision) fail(409, "页面已有新修改。请重新读取。", "conflict");
  const plan = planOperations(store, who, scopeName, pageId, current.generation, current.revision, input.operations, input.baseRevision !== undefined || needsRevision(input.operations));
  if (suggest) return { baseRevision: current.revision, generation: current.generation };
  store.apply(who, plan.writes, undefined, plan.textUpdates, plan.expectedPages);
  store.collaboration.flush();
  const snapshot = store.collaboration.snapshot(who, scopeName, pageId);
  return { ...store.pageDto(who, pageId), collaboration: { scope: snapshot.scope, pageId, generation: snapshot.generation, revision: snapshot.revision } };
}

function proposalDto(row: Row) {
  return {
    id: String(row.id), pageId: String(row.page_id), scope: externalScope(String(row.scope)),
    baseRevision: String(row.base_revision), generation: String(row.generation),
    operations: JSON.parse(String(row.operations)) as Operation[], status: String(row.status),
    author: JSON.parse(String(row.author)) as object, createdAt: String(row.created_at),
  };
}

/** Register the Agent command and human review routes before the API catchall. */
export function attachAgentOperations(app: Express, store: Store, actor: (req: Request) => Actor): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS collaboration_proposals(
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, page_id TEXT NOT NULL,
    generation TEXT NOT NULL, base_revision TEXT NOT NULL, operations TEXT NOT NULL,
    author_id TEXT NOT NULL REFERENCES users(id), author TEXT NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS collaboration_proposals_page ON collaboration_proposals(scope,page_id,created_at);`);

  app.post("/api/v1/pages/:id/operations", (req, res) => {
    const who = actor(req); const pageId = identifier.parse(req.params.id);
    const result = store.transaction<Reply>(() => {
      const { scope, scopeName } = authorizedPage(store, who, pageId, true);
      const input = commandSchema.parse(req.body);
      const requestId = `agent-ops:${input.requestId}`;
      const digest = hash(JSON.stringify({ pageId, ...input }));
      const cached = store.one("SELECT digest,result FROM requests WHERE user_id=? AND request_id=?", who.user.id, requestId);
      if (cached) {
        if (cached.digest !== digest) fail(409, "请求 ID 已用于其他操作。", "conflict");
        return JSON.parse(String(cached.result)) as Reply;
      }
      let reply: Reply;
      if (input.mode === "suggest") {
        const basis = execute(store, who, pageId, scopeName, input, true) as { baseRevision: string; generation: string };
        const proposalId = id(); const createdAt = new Date().toISOString();
        const { siteRole: _siteRole, ...author } = who.user;
        store.db.prepare("INSERT INTO collaboration_proposals VALUES(?,?,?,?,?,?,?,?,?,?)").run(proposalId, scope, pageId, basis.generation, basis.baseRevision, JSON.stringify(input.operations), who.user.id, JSON.stringify(author), "pending", createdAt);
        reply = { status: 201, body: proposalDto(store.one("SELECT * FROM collaboration_proposals WHERE id=?", proposalId)!) };
      } else reply = { status: 200, body: execute(store, who, pageId, scopeName, input, false) };
      store.db.prepare("INSERT INTO requests(user_id,request_id,digest,result) VALUES(?,?,?,?)").run(who.user.id, requestId, digest, JSON.stringify(reply));
      return reply;
    });
    res.status(result.status).json(result.body);
  });

  const list = (who: Actor, pageId: string, requestedScope?: string) => {
    const { scope } = authorizedPage(store, who, pageId, false, requestedScope);
    return store.all("SELECT * FROM collaboration_proposals WHERE scope=? AND page_id=? ORDER BY created_at DESC,id DESC", scope, pageId).map(proposalDto);
  };
  app.get("/api/v1/pages/:id/proposals", (req, res) => res.json(list(actor(req), identifier.parse(req.params.id))));
  const cookieActor = (req: Request): Actor => {
    if (req.headers.authorization) fail(403, "提案审核使用浏览器登录会话。", "forbidden");
    return actor(req);
  };
  app.get("/api/proposals", (req, res) => {
    const who = cookieActor(req);
    const input = z.object({ scope: identifier, pageId: identifier }).parse(req.query);
    res.json(list(who, input.pageId, input.scope));
  });
  app.post("/api/proposals/:id/apply", (req, res) => {
    const who = cookieActor(req); const proposalId = identifier.parse(req.params.id);
    const result = store.transaction(() => {
      const row = store.one("SELECT * FROM collaboration_proposals WHERE id=?", proposalId);
      if (!row) fail(404, "提案不存在。", "not_found");
      const { scope, scopeName } = authorizedPage(store, who, String(row.page_id), true);
      if (scope !== row.scope) fail(409, "页面分享位置已变化。请重新生成提案。", "generation_conflict");
      const input = reviewSchema.parse(req.body ?? {});
      if (row.status !== "pending") fail(409, "此提案已处理。", "conflict");
      if (input.baseRevision !== undefined && input.baseRevision !== row.base_revision) fail(409, "审核不能替换提案的基础修订。", "conflict");
      const operations = z.array(operationSchema).min(1).max(100).parse(JSON.parse(String(row.operations)));
      const body = execute(store, who, String(row.page_id), scopeName, { generation: String(row.generation), baseRevision: String(row.base_revision), operations }, false);
      store.db.prepare("UPDATE collaboration_proposals SET status='applied' WHERE id=? AND status='pending'").run(proposalId);
      return body;
    });
    res.json(result);
  });
  app.post("/api/proposals/:id/reject", (req, res) => {
    const who = cookieActor(req); const proposalId = identifier.parse(req.params.id);
    store.transaction(() => {
      const row = store.one("SELECT * FROM collaboration_proposals WHERE id=?", proposalId);
      if (!row) fail(404, "提案不存在。", "not_found");
      const { scope } = authorizedPage(store, who, String(row.page_id), true);
      if (scope !== row.scope) fail(409, "页面分享位置已变化。", "generation_conflict");
      if (row.status !== "pending") fail(409, "此提案已处理。", "conflict");
      store.db.prepare("UPDATE collaboration_proposals SET status='rejected' WHERE id=? AND status='pending'").run(proposalId);
    });
    res.json({ ok: true });
  });
}
