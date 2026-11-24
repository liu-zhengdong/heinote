import type { Express, Request } from "express";
import { z } from "zod";
import { BLOCK_KINDS, CONTENT_COLORS } from "../schema.ts";
import {
  applyPageOp,
  blockFieldKey,
  clonePageState,
  pageStateFromRecords,
  parentOf,
  readField,
  wouldCreateCycle,
} from "../src/collaboration/ot/page.ts";
import { isValidTextBoundary, normalizeRichText, richTextLength } from "../src/collaboration/ot/text.ts";
import type { PageOp, TextStep } from "../src/collaboration/protocol.ts";
import { markdownInlineToContent } from "../src/core/inline-markdown.ts";
import { markdownToBlockTree } from "../src/core/markdown-blocks.ts";
import { isKeptLink } from "../src/core/inline-content.ts";
import { storedRuns } from "../src/core/stored-runs.ts";
import type { RichText } from "../src/platform/schema.ts";
import { checkedStoredFile, storedFileSchema } from "./agent-files.ts";
import { fail, hash, id, type Actor, type Row, type Store } from "./store.ts";
import { recordTokenEvent } from "./token-identity.ts";

const identifier = z.string().min(1).max(256);
const position = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const toggle = z.boolean().nullable().optional();
const marks = z.object({
  bold: toggle, italic: toggle, underline: toggle, strike: toggle, code: toggle,
  link: z.string().max(4096).refine(isKeptLink, "链接必须使用 http、https 或页面引用。").nullable().optional(),
  color: z.enum(CONTENT_COLORS).nullable().optional(),
}).strict();
const inlineFormat = z.enum(["markdown"]).optional();
const operationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("insert_text"), blockId: identifier, index: z.union([z.literal("start"), z.literal("end"), position]), text: z.string().max(100000), format: inlineFormat }).strict(),
  z.object({ type: z.literal("delete_text"), blockId: identifier, index: position, length: position }).strict(),
  z.object({ type: z.literal("format_text"), blockId: identifier, index: position, length: position, marks }).strict(),
  z.object({ type: z.literal("insert_block"), afterId: identifier.optional(), text: z.string().max(100000), kind: z.enum(BLOCK_KINDS).optional(), file: storedFileSchema.optional(), format: inlineFormat }).strict(),
  z.object({ type: z.literal("insert_image"), blockId: identifier, index: z.union([z.literal("start"), z.literal("end"), position]), file: storedFileSchema, width: z.number().int().min(16).max(10000).optional() }).strict(),
  z.object({ type: z.literal("insert_page_link"), blockId: identifier, index: z.union([z.literal("start"), z.literal("end"), position]), pageId: identifier, expanded: z.boolean().optional(), locked: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("insert_blocks"), afterId: identifier.optional(), markdown: z.string().max(100000) }).strict(),
  z.object({ type: z.literal("delete_block"), blockId: identifier }).strict(),
  z.object({ type: z.literal("move_block"), blockId: identifier, parentId: identifier.nullable().optional(), order: z.number().finite() }).strict(),
]);
const commandSchema = z.object({
  requestId: z.string().min(1).max(256),
  generation: z.string().min(1).max(100).optional(),
  epoch: z.string().min(1).max(100).optional(),
  baseRevision: z.string().min(1).max(100).optional(),
  baseSeq: z.number().int().min(0).optional(),
  mode: z.enum(["apply", "suggest"]).default("apply"),
  operations: z.array(operationSchema).min(1).max(100),
}).strict().superRefine((val, ctx) => {
  if (!val.generation && !val.epoch) {
    ctx.addIssue({ code: "custom", path: ["epoch"], message: "必须提供 epoch 或 generation。" });
  } else if (val.generation && val.epoch && val.generation !== val.epoch) {
    ctx.addIssue({ code: "custom", path: ["epoch"], message: "epoch 与 generation 必须一致。" });
  }
});
const reviewSchema = z.object({ baseRevision: z.string().min(1).max(100).optional() }).strict();
type Operation = z.infer<typeof operationSchema>;
type Command = z.infer<typeof commandSchema>;
type Reply = { status: number; body: object };

const externalScope = (actual: string) => actual.startsWith("user:") ? "personal" : actual;
const structural = (operation: Operation) =>
  operation.type === "insert_block" || operation.type === "insert_blocks" || operation.type === "delete_block" || operation.type === "move_block";
const needsRevision = (operations: Operation[]) =>
  operations.some((operation) => structural(operation) || operation.type !== "insert_text" || typeof operation.index === "number");

function authorizedPage(store: Store, who: Actor, pageId: string, write: boolean, requestedScope?: string) {
  const found = store.page(who, pageId);
  const scopeName = externalScope(found.scope);
  const actual = store.scope(who, scopeName, write);
  if (requestedScope !== undefined && store.scope(who, requestedScope, write) !== actual) fail(404, "页面不属于指定空间。", "not_found");
  return { ...found, scopeName };
}

function assertBoundary(runs: RichText, index: number): void {
  if (index > richTextLength(runs)) fail(400, "文字范围超出段落。", "bad_request");
  if (!isValidTextBoundary(runs, index)) fail(400, "文字范围不能切开 emoji 字符。", "bad_request");
}

function runsToInsertSteps(runs: RichText): TextStep[] {
  const steps: TextStep[] = [];
  for (const run of normalizeRichText(runs)) {
    if (run.embed !== undefined) {
      steps.push(run.marks ? { insert: { embed: structuredClone(run.embed) }, marks: structuredClone(run.marks) } : { insert: { embed: structuredClone(run.embed) } });
    } else if (typeof run.text === "string" && run.text.length) {
      steps.push(run.marks ? { insert: run.text, marks: structuredClone(run.marks) } : { insert: run.text });
    }
  }
  return steps;
}

/** Translate Agent HTTP operations into semantic `PageOp[]` verified against the live page state. */
function translateOperations(
  store: Store,
  who: Actor,
  actualScope: string,
  pageId: string,
  operations: Operation[],
): PageOp[] {
  const bundle = store.pageBundle(actualScope, pageId);
  if (!bundle.page) fail(404, "页面不存在。", "not_found");
  const working = clonePageState(pageStateFromRecords(pageId, bundle.page, bundle.blocks));
  const planned: PageOp[] = [];

  const emit = (op: PageOp) => {
    applyPageOp(working, op, "materialize");
    planned.push(op);
  };

  const requireBlock = (blockId: string) => {
    const block = working.blocks.get(blockId);
    if (!block) fail(404, "段落不存在或不属于当前页面。", "not_found");
    return block;
  };

  const readBlockText = (blockId: string): RichText => {
    requireBlock(blockId);
    return readField(working, blockFieldKey(pageId, blockId)) ?? [];
  };

  for (const operation of operations) {
    if (operation.type === "insert_block") {
      const after = operation.afterId ? requireBlock(operation.afterId) : undefined;
      const parentId = after ? parentOf(after) : null;
      const kind = operation.file !== undefined ? "file" : operation.kind ?? "text";
      const file = operation.file === undefined ? undefined : checkedStoredFile(store, who, actualScope, operation.file);
      const blockId = id();
      const content: RichText = operation.format === "markdown"
        ? normalizeRichText(storedRuns(markdownInlineToContent(operation.text)) as RichText)
        : operation.text ? [{ text: operation.text }] : [];
      emit({
        type: "create_block",
        block: {
          id: blockId,
          page: pageId,
          kind,
          ...(file ? { file } : {}),
          ...(parentId ? { parent_id: parentId } : {}),
          content,
        },
        parentId,
        ...(after ? { afterId: String(after.id) } : {}),
      });
      continue;
    }

    if (operation.type === "insert_blocks") {
      const after = operation.afterId ? requireBlock(operation.afterId) : undefined;
      const rootParent = after ? parentOf(after) : null;
      const tree = markdownToBlockTree(operation.markdown, id);
      const ordered = Object.values(tree.by_id).sort((a, b) => {
        const depth = (block: typeof a): number => block.parent_id ? depth(tree.by_id[block.parent_id]) + 1 : 0;
        return depth(a) - depth(b) || a.order - b.order;
      });
      let cursorAfterId = after ? String(after.id) : undefined;
      for (const block of ordered) {
        const isRoot = !block.parent_id;
        const targetParent = isRoot ? rootParent : block.parent_id!;
        const { parent_id: _p, ...rest } = block;
        const content = normalizeRichText(storedRuns(block.content) as RichText);
        emit({
          type: "create_block",
          block: {
            ...rest,
            page: pageId,
            ...(targetParent ? { parent_id: targetParent } : {}),
            content,
          },
          parentId: targetParent,
          ...(isRoot && cursorAfterId ? { afterId: cursorAfterId } : {}),
        });
        if (isRoot) cursorAfterId = block.id;
      }
      continue;
    }

    if (operation.type === "insert_page_link") {
      requireBlock(operation.blockId);
      if (operation.pageId === pageId) fail(400, "页面不能嵌入自身。", "bad_request");
      const target = store.page(who, operation.pageId);
      const targetTrash = store.pageTrashState(target.scope, target.page.id);
      if (targetTrash.archived || targetTrash.purging) fail(404, "目标页面不存在。", "not_found");
      const current = readBlockText(operation.blockId);
      const index = operation.index === "start" ? 0 : operation.index === "end" ? richTextLength(current) : operation.index;
      assertBoundary(current, index);
      const mention = { mention: { kind: "page", page_id: operation.pageId, ...(operation.expanded ? { expanded: true } : {}), ...(operation.locked ? { locked: true } : {}) } };
      const steps: TextStep[] = [...(index > 0 ? [{ retain: index }] : []), { insert: { embed: mention } }];
      emit({ type: "text", field: blockFieldKey(pageId, operation.blockId), ops: steps });
      continue;
    }

    if (operation.type === "insert_image") {
      const row = requireBlock(operation.blockId);
      if (["file", "table", "divider", "embed"].includes(String(row.kind))) {
        fail(400, "图片只能放进文字段落。", "bad_request");
      }
      const file = checkedStoredFile(store, who, actualScope, operation.file, true);
      const current = readBlockText(operation.blockId);
      const index = operation.index === "start" ? 0 : operation.index === "end" ? richTextLength(current) : operation.index;
      assertBoundary(current, index);
      const mention = { mention: { kind: "image", file, ...(operation.width ? { width: operation.width } : {}) } };
      const steps: TextStep[] = [...(index > 0 ? [{ retain: index }] : []), { insert: { embed: mention } }];
      emit({ type: "text", field: blockFieldKey(pageId, operation.blockId), ops: steps });
      continue;
    }

    if (operation.type === "delete_block") {
      requireBlock(operation.blockId);
      const remove = new Set([operation.blockId]);
      for (let changed = true; changed;) {
        changed = false;
        for (const [blockId, row] of working.blocks) {
          if (!remove.has(blockId) && remove.has(parentOf(row) ?? "")) {
            remove.add(blockId);
            changed = true;
          }
        }
      }
      emit({ type: "delete_blocks", blockIds: [...remove] });
      continue;
    }

    if (operation.type === "move_block") {
      const row = requireBlock(operation.blockId);
      const parent = operation.parentId === undefined ? parentOf(row) : operation.parentId;
      if (parent !== null) requireBlock(parent);
      if (parent === operation.blockId) fail(400, "段落不能成为自身的父段落。", "bad_request");
      if (wouldCreateCycle(working, operation.blockId, parent)) fail(400, "段落不能形成循环。", "bad_request");
      // Explicit numeric order: resolve nearest sibling anchors so semantic move lands at requested order.
      const siblings = [...working.blocks.values()]
        .filter((b) => String(b.id) !== operation.blockId && parentOf(b) === parent)
        .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0) || String(a.id).localeCompare(String(b.id)));
      const after = [...siblings].reverse().find((b) => Number(b.order ?? 0) < operation.order);
      const before = siblings.find((b) => Number(b.order ?? 0) >= operation.order);
      emit({
        type: "move_blocks",
        blockIds: [operation.blockId],
        parentId: parent,
        ...(after ? { afterId: String(after.id) } : {}),
        ...(before ? { beforeId: String(before.id) } : {}),
        assignedOrders: { [operation.blockId]: operation.order },
      });
      // Ensure explicit requested numeric order is preserved when unambiguous.
      const placed = working.blocks.get(operation.blockId);
      if (placed) placed.order = operation.order;
      continue;
    }

    const current = readBlockText(operation.blockId);
    const index = operation.index === "start" ? 0 : operation.index === "end" ? richTextLength(current) : operation.index;
    assertBoundary(current, index);

    if (operation.type === "insert_text") {
      const insertSteps: TextStep[] = operation.format === "markdown"
        ? runsToInsertSteps(storedRuns(markdownInlineToContent(operation.text)) as RichText)
        : operation.text ? [{ insert: operation.text }] : [];
      if (insertSteps.length) {
        const steps: TextStep[] = [...(index > 0 ? [{ retain: index }] : []), ...insertSteps];
        emit({ type: "text", field: blockFieldKey(pageId, operation.blockId), ops: steps });
      }
    } else if (operation.type === "delete_text") {
      const end = index + operation.length;
      if (!Number.isSafeInteger(end)) fail(400, "文字范围无效。", "bad_request");
      assertBoundary(current, end);
      if (operation.length > 0) {
        const steps: TextStep[] = [...(index > 0 ? [{ retain: index }] : []), { delete: operation.length }];
        emit({ type: "text", field: blockFieldKey(pageId, operation.blockId), ops: steps });
      }
    } else if (operation.type === "format_text") {
      const end = index + operation.length;
      if (!Number.isSafeInteger(end)) fail(400, "文字范围无效。", "bad_request");
      assertBoundary(current, end);
      const cleanMarks = Object.fromEntries(Object.entries(operation.marks).filter(([, value]) => value !== undefined));
      if (operation.length > 0 && Object.keys(cleanMarks).length) {
        const steps: TextStep[] = [...(index > 0 ? [{ retain: index }] : []), { retain: operation.length, marks: cleanMarks }];
        emit({ type: "text", field: blockFieldKey(pageId, operation.blockId), ops: steps });
      }
    }
  }

  return planned;
}

function execute(
  store: Store,
  who: Actor,
  pageId: string,
  scopeName: string,
  actualScope: string,
  input: Pick<Command, "generation" | "epoch" | "baseRevision" | "baseSeq" | "operations">,
  suggest: boolean,
): object {
  const current = store.collaboration.snapshot(who, scopeName, pageId);
  if (!current.canEdit) fail(403, "此页面仅可查看。", "read_only");
  const expectedEpoch = input.epoch ?? input.generation;
  if (current.epoch !== expectedEpoch) fail(409, "页面结构或版本已变化。请重新读取。", "generation_conflict");
  if (input.baseSeq === undefined && needsRevision(input.operations) && !input.baseRevision) {
    fail(400, "数值范围与结构操作必须携带页面基础修订。", "bad_request");
  }
  if (input.baseRevision !== undefined && input.baseRevision !== current.revision) {
    fail(409, "页面已有新修改。请重新读取。", "conflict");
  }
  const ops = translateOperations(store, who, actualScope, pageId, input.operations);
  if (suggest) return { baseRevision: current.revision, generation: current.generation };
  if (ops.length) {
    const baseSeq = input.baseSeq !== undefined ? input.baseSeq : current.seq;
    store.applyBatch(who, [], undefined, [{
      scope: scopeName,
      pageId,
      epoch: current.epoch,
      baseSeq,
      ops,
    }]);
  }
  const dto = store.pageDto(who, pageId);
  recordTokenEvent(store.db, who.tokenId, { action: "edit", pageId, pageTitle: dto.title ?? "" });
  const snapshot = store.collaboration.snapshot(who, scopeName, pageId);
  return { ...dto, collaboration: { scope: snapshot.scope, pageId, generation: snapshot.generation, epoch: snapshot.epoch, seq: snapshot.seq, revision: snapshot.revision } };
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
      store.collaboration.markRequest(input.requestId);
      let reply: Reply;
      if (input.mode === "suggest") {
        const basis = execute(store, who, pageId, scopeName, scope, input, true) as { baseRevision: string; generation: string };
        const proposalId = id(); const createdAt = new Date().toISOString();
        const { siteRole: _siteRole, ...author } = who.user;
        const snapshot = { ...author, ...(who.displayName ? { displayName: who.displayName } : {}), ...(who.avatar ? { avatarUrl: who.avatar } : {}) };
        store.db.prepare("INSERT INTO collaboration_proposals VALUES(?,?,?,?,?,?,?,?,?,?)").run(proposalId, scope, pageId, basis.generation, basis.baseRevision, JSON.stringify(input.operations), who.user.id, JSON.stringify(snapshot), "pending", createdAt);
        const pageTitle = store.page(who, pageId).page.title ?? "";
        recordTokenEvent(store.db, who.tokenId, { action: "propose", pageId, pageTitle, versionId: proposalId });
        reply = { status: 201, body: proposalDto(store.one("SELECT * FROM collaboration_proposals WHERE id=?", proposalId)!) };
      } else {
        reply = { status: 200, body: execute(store, who, pageId, scopeName, scope, input, false) };
      }
      store.saveRequest(who.user.id, requestId, digest, reply);
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
      const body = execute(store, who, String(row.page_id), scopeName, scope, { generation: String(row.generation), baseRevision: String(row.base_revision), operations }, false);
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
      if (scope !== row.scope) fail(409, "页面分享位置已变化。请重新生成提案。", "generation_conflict");
      if (row.status !== "pending") fail(409, "此提案已处理。", "conflict");
      store.db.prepare("UPDATE collaboration_proposals SET status='rejected' WHERE id=? AND status='pending'").run(proposalId);
    });
    res.json({ ok: true });
  });
}
