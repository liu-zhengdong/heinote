import type { Express, Request } from "express";
import { z } from "zod";
import { blocksInOrder, createBlock, newPage, normalizeBlockTree, normalizePage } from "../src/core/block-tree.ts";
import { blockTreeToMarkdown, readableDescriber } from "../src/core/export-markdown.ts";
import { MENTION_CHAR } from "../src/core/inline-content.ts";
import { markdownToBlockTree } from "../src/core/markdown-blocks.ts";
import {
  buildMemoTagTree,
  extractTagsFromBlockTree,
  memoMatchesTag,
  memoSummaryTitle,
  normalizeMemoTag,
  rewriteTagInBlockTree,
  type MemoTagNode,
} from "../src/core/memos.ts";
import { contentOfRuns } from "../src/core/stored-runs.ts";
import type { Block, BlockTree, LoadedNotePage, StoredFile } from "../src/core/types.ts";
import { checkedStoredFile, storedFileSchema } from "./agent-files.ts";
import { asAuthor, fail, id, type Actor, type Row, type Store } from "./store.ts";
import { recordTokenEvent } from "./token-identity.ts";

export interface MemoCommentDto {
  id: string;
  parentId: string;
  text: string;
  markdown: string;
  blockTree: BlockTree;
  tags: string[];
  attachments: StoredFile[];
  createdAt: string;
  updatedAt: string;
}

export interface MemoDto {
  id: string;
  parentId: null;
  text: string;
  markdown: string;
  blockTree: BlockTree;
  summary: string;
  tags: string[];
  pinned: boolean;
  archived: boolean;
  archivedAt: string | null;
  attachments: StoredFile[];
  mentions: Array<{ pageId: string; title: string }>;
  comments: MemoCommentDto[];
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

const currentTime = () => new Date().toISOString();

function requirePersonalScope(store: Store, who: Actor, write: boolean, requestedSpace?: string): string {
  if (requestedSpace !== undefined && requestedSpace !== "personal") {
    fail(400, "闪念仅支持个人空间。", "bad_request");
  }
  return store.scope(who, "personal", write);
}

function parseBlockTreeFromRows(pageId: string, rows: Array<{ id: string; value: Row }>): BlockTree {
  const byId: Record<string, unknown> = {};
  for (const row of rows) {
    const { page: _page, ...rest } = row.value;
    const rawId = typeof rest.id === "string" && rest.id ? rest.id : row.id;
    byId[rawId] = { ...rest, id: rawId, content: contentOfRuns(rest.content) };
  }
  const tree = normalizeBlockTree({ by_id: byId });
  if (!Object.keys(tree.by_id).length) {
    const rootId = `block_${pageId}_root`;
    tree.by_id[rootId] = createBlock(rootId);
  }
  return tree;
}

function loadBlockTrees(store: Store, scope: string, pageIds: readonly string[]): Map<string, BlockTree> {
  const grouped = new Map<string, Array<{ id: string; value: Row }>>();
  for (const pageId of pageIds) grouped.set(pageId, []);
  const chunkSize = 400;
  for (let offset = 0; offset < pageIds.length; offset += chunkSize) {
    const slice = pageIds.slice(offset, offset + chunkSize);
    if (!slice.length) continue;
    const marks = slice.map(() => "?").join(",");
    const rows = store.all(
      `SELECT id,value FROM records WHERE scope=? AND collection='blocks' AND json_extract(value,'$.page') IN (${marks})`,
      scope,
      ...slice,
    );
    for (const row of rows) {
      const value = JSON.parse(String(row.value)) as Row;
      const pageId = typeof value.page === "string" ? value.page : "";
      if (!pageId) continue;
      grouped.get(pageId)?.push({ id: String(row.id), value });
    }
  }
  const trees = new Map<string, BlockTree>();
  for (const [pageId, rows] of grouped) {
    trees.set(pageId, parseBlockTreeFromRows(pageId, rows));
  }
  return trees;
}

function attachmentsFromTree(tree: BlockTree): StoredFile[] {
  const files: StoredFile[] = [];
  const seen = new Set<string>();
  for (const block of blocksInOrder(tree)) {
    if (block.kind === "file" && block.file && !seen.has(block.file.path)) {
      seen.add(block.file.path);
      files.push(block.file);
    }
    for (const run of block.content) {
      if (run.mention?.kind === "image" && !seen.has(run.mention.file.path)) {
        seen.add(run.mention.file.path);
        files.push(run.mention.file);
      }
    }
  }
  return files;
}

function mentionsFromTree(tree: BlockTree, titleOf: (pageId: string) => string): Array<{ pageId: string; title: string }> {
  const out: Array<{ pageId: string; title: string }> = [];
  const seen = new Set<string>();
  for (const block of blocksInOrder(tree)) {
    for (const run of block.content) {
      if (run.mention?.kind !== "page" || seen.has(run.mention.page_id)) continue;
      seen.add(run.mention.page_id);
      out.push({ pageId: run.mention.page_id, title: titleOf(run.mention.page_id) || "Untitled" });
    }
  }
  return out;
}

function pageTitleResolver(store: Store, who: Actor): (pageId: string) => string {
  const cache = new Map<string, string>();
  return (pageId: string) => {
    if (cache.has(pageId)) return cache.get(pageId)!;
    const record = store.pageRecord(who, pageId);
    const runs = Array.isArray(record?.title_content) ? (record.title_content as Array<{ text?: string }>) : [];
    const title = runs.map((run) => run.text ?? "").join("");
    cache.set(pageId, title);
    return title;
  };
}

function plainTextOfTree(tree: BlockTree, titleOf: (pageId: string) => string): string {
  const describe = readableDescriber(titleOf);
  return blocksInOrder(tree)
    ? [...blocksInOrder(tree)].map((block) => {
      if (block.kind === "todo") {
        const words = block.content.map((run) => (run.mention ? describe(run.mention).label : run.text)).join("");
        return `- [${block.checked ? "x" : " "}] ${words}`;
      }
      return block.content.map((run) => (run.mention ? describe(run.mention).label : run.text)).join("");
    }).join("\n")
    : "";
}

function serializeComment(row: Row, tree: BlockTree, titleOf: (pageId: string) => string): MemoCommentDto {
  const markdown = blockTreeToMarkdown(tree, titleOf);
  const text = plainTextOfTree(tree, titleOf);
  const tags = Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : [];
  return {
    id: String(row.id),
    parentId: String(row.parent_id),
    text,
    markdown,
    blockTree: tree,
    tags,
    attachments: attachmentsFromTree(tree),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function serializeMemo(
  row: Row,
  tree: BlockTree,
  comments: Array<{ row: Row; tree: BlockTree }>,
  titleOf: (pageId: string) => string,
): MemoDto {
  const markdown = blockTreeToMarkdown(tree, titleOf);
  const text = plainTextOfTree(tree, titleOf);
  const tags = Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : [];
  const commentDtos = comments.map((entry) => serializeComment(entry.row, entry.tree, titleOf));
  return {
    id: String(row.id),
    parentId: null,
    text,
    markdown,
    blockTree: tree,
    summary: memoSummaryTitle(text || markdown),
    tags,
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    archivedAt: typeof row.archived_at === "string" ? row.archived_at : null,
    attachments: attachmentsFromTree(tree),
    mentions: mentionsFromTree(tree, titleOf),
    comments: commentDtos,
    commentCount: commentDtos.length,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function nextRootOrder(byId: Readonly<Record<string, Block>>): number {
  let maxOrder = 0;
  for (const block of Object.values(byId)) {
    if (block.parent_id === null && block.order > maxOrder) maxOrder = block.order;
  }
  return maxOrder + 1024;
}

function buildMemoBlockTree(
  store: Store,
  who: Actor,
  scope: string,
  bodyText: string,
  attachments: unknown[] | undefined,
  mentionPageIds: string[] | undefined,
): BlockTree {
  const tree = bodyText ? markdownToBlockTree(bodyText, id) : { by_id: {} as Record<string, Block> };
  // Resolve `@[[pageId]]` tokens or explicit mentionPageIds safely into page mentions.
  if (mentionPageIds?.length) {
    const validTitles = new Map<string, string>();
    for (const pageId of mentionPageIds) {
      const target = store.pageRecord(who, pageId);
      if (target && target.kind !== "memo" && !target.archived && !target.purging) {
        const runs = Array.isArray(target.title_content) ? (target.title_content as Array<{ text?: string }>) : [];
        validTitles.set(pageId, runs.map((r) => r.text ?? "").join("") || "Untitled");
      }
    }
    if (validTitles.size) {
      for (const block of Object.values(tree.by_id)) {
        if (block.kind === "code" || block.kind === "equation") continue;
        const expandedRuns: typeof block.content = [];
        for (const run of block.content) {
          if (run.mention || run.marks?.code) { expandedRuns.push(run); continue; }
          let cursor = 0;
          const raw = run.text;
          const re = /\[\[page:([a-zA-Z0-9_-]+)\]\]/g;
          let match: RegExpExecArray | null;
          while ((match = re.exec(raw)) !== null) {
            const pageId = match[1];
            if (!validTitles.has(pageId)) continue;
            if (match.index > cursor) expandedRuns.push({ text: raw.slice(cursor, match.index), ...(run.marks ? { marks: run.marks } : {}) });
            expandedRuns.push({ text: MENTION_CHAR, mention: { kind: "page", page_id: pageId } });
            cursor = match.index + match[0].length;
          }
          if (cursor < raw.length) expandedRuns.push({ text: raw.slice(cursor), ...(run.marks ? { marks: run.marks } : {}) });
        }
        if (expandedRuns.length) block.content = expandedRuns;
      }
    }
  }

  if (attachments?.length) {
    let order = nextRootOrder(tree.by_id);
    for (const rawFile of attachments) {
      const file = checkedStoredFile(store, who, scope, rawFile, true);
      const blockId = id();
      tree.by_id[blockId] = createBlock(blockId, "text", {
        order,
        content: [{ text: MENTION_CHAR, mention: { kind: "image", file } }],
      });
      order += 1024;
    }
  }

  if (!Object.keys(tree.by_id).length) {
    const blockId = id();
    tree.by_id[blockId] = createBlock(blockId, "text", { order: 1024, content: [] });
  }
  return { by_id: { ...tree.by_id } };
}

function readPinnedMemoTags(store: Store, scope: string): string[] {
  const settings = store.record(scope, "workspace_settings", "preferences");
  if (!settings || !Array.isArray(settings.pinned_memo_tags)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of settings.pinned_memo_tags) {
    if (typeof raw !== "string") continue;
    const tag = normalizeMemoTag(raw);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function writePinnedMemoTags(store: Store, scope: string, tags: string[]): string[] {
  const current = store.record(scope, "workspace_settings", "preferences") ?? {};
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = normalizeMemoTag(raw);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    normalized.push(tag);
  }
  store.put(scope, "workspace_settings", "preferences", { ...current, pinned_memo_tags: normalized });
  return normalized;
}

function loadAllPersonalMemoRows(store: Store, scope: string): {
  topRows: Row[];
  commentsByParent: Map<string, Row[]>;
  byId: Map<string, Row>;
} {
  const sqlRows = store.all(
    "SELECT value FROM records WHERE scope=? AND collection='pages' AND json_extract(value,'$.kind')='memo'",
    scope,
  );
  const topRows: Row[] = [];
  const commentsByParent = new Map<string, Row[]>();
  const byId = new Map<string, Row>();
  for (const sqlRow of sqlRows) {
    const value = JSON.parse(String(sqlRow.value)) as Row;
    if (value.purging) continue;
    const rowId = String(value.id);
    byId.set(rowId, value);
    if (typeof value.parent_id === "string" && value.parent_id) {
      const list = commentsByParent.get(value.parent_id);
      if (list) list.push(value);
      else commentsByParent.set(value.parent_id, [value]);
    } else {
      topRows.push(value);
    }
  }
  for (const list of commentsByParent.values()) {
    list.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)) || String(left.id).localeCompare(String(right.id)));
  }
  return { topRows, commentsByParent, byId };
}

function tagTreeFromRows(topRows: readonly Row[]): MemoTagNode[] {
  const active = topRows
    .filter((row) => !row.archived)
    .map((row) => ({ tags: Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === "string") : [] }));
  return buildMemoTagTree(active);
}

function memoCursorKey(row: Row): string {
  return `${row.pinned ? "1" : "0"}|${String(row.created_at)}|${String(row.id)}`;
}

function compareMemoDesc(left: Row, right: Row): number {
  const leftPin = left.pinned ? 1 : 0;
  const rightPin = right.pinned ? 1 : 0;
  if (leftPin !== rightPin) return rightPin - leftPin;
  return String(right.created_at).localeCompare(String(left.created_at)) || String(right.id).localeCompare(String(left.id));
}

function deleteMemoRecordAndChildren(store: Store, actor: Actor, scope: string, targetId: string, childIds: readonly string[]): void {
  const batchScope = scope.startsWith("user:") ? "personal" : scope;
  const writes = [...childIds, targetId].flatMap((pageId) => {
    const existing = store.record(scope, "pages", pageId);
    if (!existing) return [];
    return [{
      action: "delete" as const,
      scope: batchScope,
      collection: "pages",
      id: pageId,
      base: existing,
    }];
  });
  if (writes.length) store.applyBatch(actor, writes);
}

function appendCommentBlocks(
  targetTree: BlockTree,
  comment: Row,
  commentTree: BlockTree,
): void {
  let nextOrder = nextRootOrder(targetTree.by_id);
  const dividerId = id();
  const headingId = id();
  const hasExistingDivider = Object.values(targetTree.by_id).some(
    (block) => block.kind === "heading3" && block.content.map((r) => r.text).join("") === "批注记录",
  );
  if (!hasExistingDivider) {
    targetTree.by_id[dividerId] = createBlock(dividerId, "divider", { order: nextOrder });
    nextOrder += 1024;
    targetTree.by_id[headingId] = createBlock(headingId, "heading3", {
      order: nextOrder,
      content: [{ text: "批注记录" }],
    });
    nextOrder += 1024;
  }

  const stamp = String(comment.created_at).replace("T", " ").slice(0, 16);
  const stampId = id();
  targetTree.by_id[stampId] = createBlock(stampId, "text", {
    order: nextOrder,
    content: [{ text: stamp, marks: { bold: true } }],
  });
  nextOrder += 1024;

  const idMap = new Map<string, string>();
  const ordered = [...blocksInOrder(commentTree)];
  for (const block of ordered) idMap.set(block.id, id());
  for (const block of ordered) {
    const newId = idMap.get(block.id)!;
    const newParentId = block.parent_id ? (idMap.get(block.parent_id) ?? null) : null;
    const order = newParentId === null ? nextOrder : block.order;
    if (newParentId === null) nextOrder += 1024;
    targetTree.by_id[newId] = {
      ...structuredClone(block),
      id: newId,
      parent_id: newParentId,
      order,
    };
  }
}

function hasMemoTreeContent(tree: BlockTree): boolean {
  return Object.values(tree.by_id).some((block) => (
    block.kind === "divider"
    || (block.kind === "file" && Boolean(block.file))
    || (block.kind === "embed" && Boolean(block.embed))
    || block.kind === "table"
    || block.content.some((run) => Boolean(run.mention) || Boolean(run.text.trim()))
  ));
}

function validateMemoBlockTree(
  store: Store,
  who: Actor,
  scope: string,
  rawTree: { by_id: Record<string, unknown> },
): BlockTree {
  const normalized = normalizeBlockTree(rawTree);
  const nextById: Record<string, Block> = {};
  for (const [blockId, block] of Object.entries(normalized.by_id)) {
    const file = block.kind === "file" && block.file
      ? checkedStoredFile(store, who, scope, block.file, false)
      : block.file;
    const content = block.content.map((run) => {
      if (run.mention?.kind !== "image") return run;
      const verified = checkedStoredFile(store, who, scope, run.mention.file, true);
      return { ...run, mention: { ...run.mention, file: verified } };
    });
    nextById[blockId] = {
      ...block,
      content,
      ...(file ? { file } : {}),
    };
  }
  const tree: BlockTree = { by_id: nextById };
  if (!hasMemoTreeContent(tree)) fail(400, "闪念内容不能为空。", "bad_request");
  return tree;
}

const rawBlockTreeSchema = z.object({ by_id: z.record(z.string(), z.unknown()) }).strict();

const createMemoSchema = z.object({
  text: z.string().max(100000).optional(),
  markdown: z.string().max(100000).optional(),
  blockTree: rawBlockTreeSchema.optional(),
  parentId: z.string().min(1).max(256).optional(),
  pinned: z.boolean().optional(),
  attachments: z.array(storedFileSchema).max(20).optional(),
  mentionPageIds: z.array(z.string().min(1).max(256)).max(50).optional(),
  spaceId: z.string().min(1).max(256).optional(),
  scope: z.string().min(1).max(256).optional(),
}).strict();

const updateMemoSchema = z.object({
  text: z.string().max(100000).optional(),
  markdown: z.string().max(100000).optional(),
  blockTree: rawBlockTreeSchema.optional(),
  pinned: z.boolean().optional(),
  attachments: z.array(storedFileSchema).max(20).optional(),
  mentionPageIds: z.array(z.string().min(1).max(256)).max(50).optional(),
}).strict();

export function attachMemos(app: Express, store: Store, actor: (req: Request) => Actor): void {
  app.get("/api/v1/memos/tags", (req, res) => {
    const who = actor(req);
    const spaceParam = typeof req.query.space === "string" ? req.query.space : typeof req.query.scope === "string" ? req.query.scope : undefined;
    const scope = requirePersonalScope(store, who, false, spaceParam);
    const { topRows } = loadAllPersonalMemoRows(store, scope);
    res.json({
      tags: tagTreeFromRows(topRows),
      pinnedTags: readPinnedMemoTags(store, scope),
    });
  });

  app.put("/api/v1/memos/tags/pinned", (req, res) => {
    const who = actor(req);
    const scope = requirePersonalScope(store, who, true);
    const input = z.object({ tags: z.array(z.string().min(1).max(60)).max(100) }).strict().parse(req.body);
    const pinnedTags = store.transaction(() => writePinnedMemoTags(store, scope, input.tags));
    res.json({ pinnedTags });
  });

  app.post("/api/v1/memos/tags/rename", (req, res) => {
    const who = actor(req);
    const scope = requirePersonalScope(store, who, true);
    const input = z.object({ from: z.string().min(1).max(60), to: z.string().min(1).max(60) }).strict().parse(req.body);
    const fromTag = normalizeMemoTag(input.from);
    const toTag = normalizeMemoTag(input.to);
    if (!fromTag || !toTag) fail(400, "标签名称无效。", "bad_request");

    const result = store.transaction(() => {
      const { topRows, commentsByParent } = loadAllPersonalMemoRows(store, scope);
      const candidateIds: string[] = [];
      for (const row of topRows) {
        const tags = Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === "string") : [];
        if (memoMatchesTag(tags, fromTag)) candidateIds.push(String(row.id));
        for (const comment of commentsByParent.get(String(row.id)) ?? []) {
          const cTags = Array.isArray(comment.tags) ? comment.tags.filter((t): t is string => typeof t === "string") : [];
          if (memoMatchesTag(cTags, fromTag)) candidateIds.push(String(comment.id));
        }
      }
      const trees = loadBlockTrees(store, scope, candidateIds);
      let updated = 0;
      const nowIso = currentTime();
      for (const rowId of candidateIds) {
        const raw = store.record(scope, "pages", rowId);
        const tree = trees.get(rowId);
        if (!raw || !tree) continue;
        const rewritten = rewriteTagInBlockTree(tree, fromTag, toTag);
        if (!rewritten.changed) continue;
        const page = normalizePage({
          ...raw,
          id: rowId,
          parent_id: typeof raw.parent_id === "string" ? raw.parent_id : null,
          block_tree: rewritten.tree,
        }) as LoadedNotePage;
        page.tags = extractTagsFromBlockTree(rewritten.tree);
        page.updated_at = nowIso;
        page.updated_by = asAuthor(who);
        store.savePage(scope, page, who, "重命名了闪念标签");
        updated += 1;
      }

      const replacePin = (tag: string) => tag === fromTag ? toTag : tag.startsWith(`${fromTag}/`) ? `${toTag}${tag.slice(fromTag.length)}` : tag;
      const pinnedTags = writePinnedMemoTags(store, scope, readPinnedMemoTags(store, scope).map(replacePin));
      const refreshed = loadAllPersonalMemoRows(store, scope);
      return { updated, tags: tagTreeFromRows(refreshed.topRows), pinnedTags };
    });

    res.json(result);
  });

  app.post("/api/v1/memos/tags/delete", (req, res) => {
    const who = actor(req);
    const scope = requirePersonalScope(store, who, true);
    const input = z.object({ tag: z.string().min(1).max(60) }).strict().parse(req.body);
    const targetTag = normalizeMemoTag(input.tag);
    if (!targetTag) fail(400, "标签名称无效。", "bad_request");

    const result = store.transaction(() => {
      const { topRows, commentsByParent } = loadAllPersonalMemoRows(store, scope);
      const candidateIds: string[] = [];
      for (const row of topRows) {
        const tags = Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === "string") : [];
        if (memoMatchesTag(tags, targetTag)) candidateIds.push(String(row.id));
        for (const comment of commentsByParent.get(String(row.id)) ?? []) {
          const cTags = Array.isArray(comment.tags) ? comment.tags.filter((t): t is string => typeof t === "string") : [];
          if (memoMatchesTag(cTags, targetTag)) candidateIds.push(String(comment.id));
        }
      }
      const trees = loadBlockTrees(store, scope, candidateIds);
      let updated = 0;
      const nowIso = currentTime();
      for (const rowId of candidateIds) {
        const raw = store.record(scope, "pages", rowId);
        const tree = trees.get(rowId);
        if (!raw || !tree) continue;
        const rewritten = rewriteTagInBlockTree(tree, targetTag, null);
        if (!rewritten.changed) continue;
        const page = normalizePage({
          ...raw,
          id: rowId,
          parent_id: typeof raw.parent_id === "string" ? raw.parent_id : null,
          block_tree: rewritten.tree,
        }) as LoadedNotePage;
        page.tags = extractTagsFromBlockTree(rewritten.tree);
        page.updated_at = nowIso;
        page.updated_by = asAuthor(who);
        store.savePage(scope, page, who, "移除了闪念标签");
        updated += 1;
      }

      const remainingPins = readPinnedMemoTags(store, scope).filter((t) => t !== targetTag && !t.startsWith(`${targetTag}/`));
      const pinnedTags = writePinnedMemoTags(store, scope, remainingPins);
      const refreshed = loadAllPersonalMemoRows(store, scope);
      return { updated, tags: tagTreeFromRows(refreshed.topRows), pinnedTags };
    });

    res.json(result);
  });

  app.get("/api/v1/memos", (req, res) => {
    const who = actor(req);
    const spaceParam = typeof req.query.space === "string" ? req.query.space : typeof req.query.scope === "string" ? req.query.scope : undefined;
    const scope = requirePersonalScope(store, who, false, spaceParam);
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const cursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : undefined;
    const filter = typeof req.query.filter === "string" ? req.query.filter : "all";
    const tagFilter = typeof req.query.tag === "string" && req.query.tag.trim() ? normalizeMemoTag(req.query.tag) : "";
    const q = typeof req.query.q === "string" ? req.query.q.trim().normalize("NFKC").toLowerCase() : "";
    const around = typeof req.query.around === "string" && req.query.around ? req.query.around : undefined;

    const { topRows, commentsByParent } = loadAllPersonalMemoRows(store, scope);
    const activeRows = topRows.filter((row) => !row.archived);
    const trashedRows = topRows.filter((row) => Boolean(row.archived));

    const counts = {
      all: activeRows.length,
      pinned: activeRows.filter((row) => Boolean(row.pinned)).length,
      commented: activeRows.filter((row) => (commentsByParent.get(String(row.id))?.length ?? 0) > 0).length,
      untagged: activeRows.filter((row) => !Array.isArray(row.tags) || row.tags.length === 0).length,
      trashed: trashedRows.length,
    };

    let pool = filter === "trashed" ? [...trashedRows] : [...activeRows];
    if (filter === "pinned") pool = pool.filter((row) => Boolean(row.pinned));
    else if (filter === "commented") pool = pool.filter((row) => (commentsByParent.get(String(row.id))?.length ?? 0) > 0);
    else if (filter === "untagged") pool = pool.filter((row) => !Array.isArray(row.tags) || row.tags.length === 0);

    if (tagFilter) {
      pool = pool.filter((row) => {
        const tags = Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === "string") : [];
        return memoMatchesTag(tags, tagFilter);
      });
    }

    if (filter === "trashed") {
      pool.sort((left, right) =>
        String(right.archived_at ?? right.created_at).localeCompare(String(left.archived_at ?? left.created_at))
        || String(right.id).localeCompare(String(left.id)));
    } else {
      pool.sort(compareMemoDesc);
    }

    const titleOf = pageTitleResolver(store, who);
    let preloadedTrees: Map<string, BlockTree> | null = null;
    if (q) {
      const searchIds: string[] = [];
      for (const row of pool) {
        const rowId = String(row.id);
        searchIds.push(rowId);
        for (const comment of commentsByParent.get(rowId) ?? []) searchIds.push(String(comment.id));
      }
      preloadedTrees = loadBlockTrees(store, scope, searchIds);
      pool = pool.filter((row) => {
        const rowId = String(row.id);
        const tags = Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === "string") : [];
        if (tags.some((t) => t.normalize("NFKC").toLowerCase().includes(q.startsWith("#") ? q.slice(1) : q))) return true;
        const tree = preloadedTrees!.get(rowId);
        if (tree && plainTextOfTree(tree, titleOf).normalize("NFKC").toLowerCase().includes(q)) return true;
        for (const comment of commentsByParent.get(rowId) ?? []) {
          const cTree = preloadedTrees!.get(String(comment.id));
          if (cTree && plainTextOfTree(cTree, titleOf).normalize("NFKC").toLowerCase().includes(q)) return true;
        }
        return false;
      });
    }

    let startIndex = 0;
    if (cursor) {
      if (filter === "trashed") {
        const idx = pool.findIndex((row) => `${String(row.archived_at ?? row.created_at)}|${String(row.id)}` === cursor);
        if (idx >= 0) startIndex = idx + 1;
      } else {
        const idx = pool.findIndex((row) => memoCursorKey(row) === cursor);
        if (idx >= 0) startIndex = idx + 1;
        else {
          // Fallback to lexicographical cursor comparison when the cursor item changed/moved.
          const [cPin, cTime, cId] = cursor.split("|", 3);
          const found = pool.findIndex((row) => {
            const rPin = row.pinned ? "1" : "0";
            if (rPin !== cPin) return Number(rPin) < Number(cPin);
            const rTime = String(row.created_at);
            if (rTime !== cTime) return rTime < cTime;
            return String(row.id) < (cId ?? "");
          });
          startIndex = found >= 0 ? found : pool.length;
        }
      }
    }

    let pageSlice = pool.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + pageSlice.length < pool.length;
    const lastRow = pageSlice.at(-1);
    const nextCursor = hasMore && lastRow
      ? (filter === "trashed" ? `${String(lastRow.archived_at ?? lastRow.created_at)}|${String(lastRow.id)}` : memoCursorKey(lastRow))
      : null;

    if (around && !pageSlice.some((row) => String(row.id) === around)) {
      const target = pool.find((row) => String(row.id) === around);
      if (target) pageSlice = [...pageSlice, target];
    }

    const neededIds: string[] = [];
    for (const row of pageSlice) {
      const rowId = String(row.id);
      neededIds.push(rowId);
      for (const comment of commentsByParent.get(rowId) ?? []) neededIds.push(String(comment.id));
    }
    const trees = preloadedTrees ?? loadBlockTrees(store, scope, neededIds);
    const memos = pageSlice.map((row) => {
      const rowId = String(row.id);
      const commentEntries = (commentsByParent.get(rowId) ?? []).map((cRow) => ({
        row: cRow,
        tree: trees.get(String(cRow.id)) ?? parseBlockTreeFromRows(String(cRow.id), []),
      }));
      return serializeMemo(row, trees.get(rowId) ?? parseBlockTreeFromRows(rowId, []), commentEntries, titleOf);
    });

    res.json({ memos, nextCursor, hasMore, counts });
  });

  app.post("/api/v1/memos", (req, res) => {
    const who = actor(req);
    const input = createMemoSchema.parse(req.body ?? {});
    const bodyFormats = [input.text, input.markdown, input.blockTree].filter((v) => v !== undefined).length;
    if (bodyFormats > 1) {
      fail(400, "text、markdown 与 blockTree 只能提供一个。", "bad_request");
    }
    if (input.scope && input.spaceId && input.scope !== input.spaceId) {
      fail(400, "指定空间不一致。", "bad_request");
    }
    const scope = requirePersonalScope(store, who, true, input.scope ?? input.spaceId);
    const rawBody = (input.markdown ?? input.text ?? "").trimEnd();
    if (!input.blockTree && !rawBody.trim() && !(input.attachments?.length)) {
      fail(400, "请输入闪念内容或附加图片。", "bad_request");
    }

    const titleOf = pageTitleResolver(store, who);
    const created = store.transaction(() => {
      if (input.parentId) {
        const parent = store.record(scope, "pages", input.parentId);
        if (!parent || parent.kind !== "memo" || parent.purging) fail(404, "闪念不存在。", "not_found");
        if (parent.archived) fail(409, "回收站中的闪念不能添加批注。", "archived");
        if (parent.parent_id) fail(400, "批注仅支持一层嵌套。", "bad_request");
        if (input.pinned) fail(400, "批注不支持置顶。", "bad_request");
      }

      const nowIso = currentTime();
      const memoId = id();
      const tree = input.blockTree
        ? validateMemoBlockTree(store, who, scope, input.blockTree)
        : buildMemoBlockTree(store, who, scope, rawBody, input.attachments, input.mentionPageIds);
      const page = newPage(memoId, "memo", input.parentId ?? null, { author: who.user.id, now: nowIso }, id());
      page.block_tree = tree;
      page.tags = extractTagsFromBlockTree(tree);
      if (input.pinned && !input.parentId) page.pinned = true;

      store.savePage(scope, page, who, input.parentId ? "添加了闪念批注" : "创建了闪念");
      const savedRow = store.record(scope, "pages", memoId)!;
      recordTokenEvent(store.db, who.tokenId, {
        action: "create",
        pageId: memoId,
        pageTitle: memoSummaryTitle(plainTextOfTree(tree, titleOf) || "闪念"),
      });
      return input.parentId
        ? serializeComment(savedRow, tree, titleOf)
        : serializeMemo(savedRow, tree, [], titleOf);
    });

    res.status(201).json(created);
  });

  app.patch("/api/v1/memos/:id", (req, res) => {
    const who = actor(req);
    const scope = requirePersonalScope(store, who, true);
    const memoId = String(req.params.id);
    const input = updateMemoSchema.parse(req.body ?? {});
    const bodyFormats = [input.text, input.markdown, input.blockTree].filter((v) => v !== undefined).length;
    if (bodyFormats > 1) {
      fail(400, "text、markdown 与 blockTree 只能提供一个。", "bad_request");
    }
    if (input.text === undefined && input.markdown === undefined && input.blockTree === undefined && input.pinned === undefined && input.attachments === undefined) {
      fail(400, "没有要修改的内容。", "bad_request");
    }

    const titleOf = pageTitleResolver(store, who);
    const updated = store.transaction(() => {
      const existing = store.record(scope, "pages", memoId);
      if (!existing || existing.kind !== "memo" || existing.purging) fail(404, "闪念不存在。", "not_found");
      if (existing.archived) fail(409, "回收站中的闪念不能修改，请先恢复。", "archived");
      const isComment = typeof existing.parent_id === "string" && Boolean(existing.parent_id);
      if (isComment && input.pinned !== undefined) fail(400, "批注不支持置顶。", "bad_request");

      const currentTrees = loadBlockTrees(store, scope, [memoId]);
      let nextTree = currentTrees.get(memoId)!;
      if (input.blockTree !== undefined) {
        nextTree = validateMemoBlockTree(store, who, scope, input.blockTree);
      } else if (input.markdown !== undefined || input.text !== undefined || input.attachments !== undefined) {
        const nextText = input.markdown !== undefined
          ? input.markdown.trimEnd()
          : input.text !== undefined
            ? input.text.trimEnd()
            : blockTreeToMarkdown(nextTree, titleOf);
        const nextFiles = input.attachments !== undefined ? input.attachments : attachmentsFromTree(nextTree);
        if (!nextText.trim() && !nextFiles.length) fail(400, "闪念内容不能为空。", "bad_request");
        nextTree = buildMemoBlockTree(store, who, scope, nextText, nextFiles, input.mentionPageIds);
      }

      const page = normalizePage({
        ...existing,
        id: memoId,
        parent_id: isComment ? String(existing.parent_id) : null,
        block_tree: nextTree,
      }) as LoadedNotePage;
      page.tags = extractTagsFromBlockTree(nextTree);
      if (input.pinned !== undefined) {
        if (input.pinned) page.pinned = true;
        else delete page.pinned;
      }
      page.updated_at = currentTime();
      page.updated_by = asAuthor(who);

      store.savePage(scope, page, who, isComment ? "修改了闪念批注" : "修改了闪念");
      const savedRow = store.record(scope, "pages", memoId)!;
      recordTokenEvent(store.db, who.tokenId, {
        action: "edit",
        pageId: memoId,
        pageTitle: memoSummaryTitle(plainTextOfTree(nextTree, titleOf)),
      });

      if (isComment) return serializeComment(savedRow, nextTree, titleOf);
      const { commentsByParent } = loadAllPersonalMemoRows(store, scope);
      const commentRows = commentsByParent.get(memoId) ?? [];
      const commentTrees = loadBlockTrees(store, scope, commentRows.map((c) => String(c.id)));
      return serializeMemo(
        savedRow,
        nextTree,
        commentRows.map((c) => ({ row: c, tree: commentTrees.get(String(c.id))! })),
        titleOf,
      );
    });

    res.json(updated);
  });

  app.delete("/api/v1/memos/:id", (req, res) => {
    const who = actor(req);
    const scope = requirePersonalScope(store, who, true);
    const memoId = String(req.params.id);
    const permanent = req.query.permanent === "true" || req.query.permanent === "1";

    const outcome = store.transaction(() => {
      const existing = store.record(scope, "pages", memoId);
      if (!existing || existing.kind !== "memo" || existing.purging) fail(404, "闪念不存在。", "not_found");
      const isComment = typeof existing.parent_id === "string" && Boolean(existing.parent_id);
      if (isComment) {
        deleteMemoRecordAndChildren(store, who, scope, memoId, []);
        recordTokenEvent(store.db, who.tokenId, { action: "edit", pageId: String(existing.parent_id), pageTitle: "删除闪念批注" });
        return { ok: true, id: memoId, deleted: true };
      }
      if (permanent) {
        if (!existing.archived) fail(400, "请先移入回收站再彻底删除。", "bad_request");
        const { commentsByParent } = loadAllPersonalMemoRows(store, scope);
        const childIds = (commentsByParent.get(memoId) ?? []).map((c) => String(c.id));
        deleteMemoRecordAndChildren(store, who, scope, memoId, childIds);
        return { ok: true, id: memoId, deleted: true };
      }
      if (!existing.archived) {
        const nowIso = currentTime();
        store.put(scope, "pages", memoId, { ...existing, archived: true, archived_at: nowIso });
        recordTokenEvent(store.db, who.tokenId, { action: "edit", pageId: memoId, pageTitle: "闪念移入回收站" });
      }
      return { ok: true, id: memoId, archived: true };
    });

    res.json(outcome);
  });

  app.post("/api/v1/memos/:id/restore", (req, res) => {
    const who = actor(req);
    const scope = requirePersonalScope(store, who, true);
    const memoId = String(req.params.id);
    const titleOf = pageTitleResolver(store, who);

    const restored = store.transaction(() => {
      const existing = store.record(scope, "pages", memoId);
      if (!existing || existing.kind !== "memo" || existing.purging) fail(404, "闪念不存在。", "not_found");
      if (existing.parent_id) fail(400, "批注不支持单独恢复。", "bad_request");
      if (!existing.archived) fail(409, "该闪念不在回收站中。", "conflict");

      const nextRow = { ...existing };
      delete nextRow.archived;
      delete nextRow.archived_at;
      store.put(scope, "pages", memoId, nextRow);

      const { commentsByParent } = loadAllPersonalMemoRows(store, scope);
      const commentRows = commentsByParent.get(memoId) ?? [];
      const ids = [memoId, ...commentRows.map((c) => String(c.id))];
      const trees = loadBlockTrees(store, scope, ids);
      recordTokenEvent(store.db, who.tokenId, {
        action: "restore",
        pageId: memoId,
        pageTitle: memoSummaryTitle(plainTextOfTree(trees.get(memoId)!, titleOf)),
      });
      return serializeMemo(
        nextRow,
        trees.get(memoId)!,
        commentRows.map((c) => ({ row: c, tree: trees.get(String(c.id))! })),
        titleOf,
      );
    });

    res.json(restored);
  });

  app.post("/api/v1/memos/:id/promote", (req, res) => {
    const who = actor(req);
    const scope = requirePersonalScope(store, who, true);
    const memoId = String(req.params.id);
    const input = z.object({ title: z.string().max(500).optional() }).strict().parse(req.body ?? {});
    const titleOf = pageTitleResolver(store, who);

    const outcome = store.transaction(() => {
      const existing = store.record(scope, "pages", memoId);
      if (!existing || existing.kind !== "memo" || existing.purging) fail(404, "闪念不存在。", "not_found");
      if (existing.parent_id) fail(400, "批注不能直接转为正式页面。", "bad_request");
      if (existing.archived) fail(409, "回收站中的闪念请先恢复后再转正。", "archived");

      const { commentsByParent } = loadAllPersonalMemoRows(store, scope);
      const commentRows = commentsByParent.get(memoId) ?? [];
      const trees = loadBlockTrees(store, scope, [memoId, ...commentRows.map((c) => String(c.id))]);
      const parentTree = trees.get(memoId)!;
      const derivedTitle = input.title?.trim() || memoSummaryTitle(plainTextOfTree(parentTree, titleOf));

      for (const comment of commentRows) {
        const cTree = trees.get(String(comment.id));
        if (cTree) appendCommentBlocks(parentTree, comment, cTree);
      }

      const promoted = normalizePage({
        ...existing,
        id: memoId,
        kind: "document",
        parent_id: null,
        title: derivedTitle,
        title_content: [{ text: derivedTitle }],
        block_tree: parentTree,
      }) as LoadedNotePage;
      delete promoted.pinned;
      delete promoted.tags;
      promoted.title = derivedTitle;
      promoted.title_content = [{ text: derivedTitle }];
      promoted.updated_at = currentTime();
      promoted.updated_by = asAuthor(who);

      store.savePage(scope, promoted, who, "由闪念转为正式页面");
      store.collaboration.noteScope(scope);
      if (commentRows.length) {
        const [firstComment, ...restComments] = commentRows;
        deleteMemoRecordAndChildren(
          store,
          who,
          scope,
          String(firstComment.id),
          restComments.map((comment) => String(comment.id)),
        );
      }
      recordTokenEvent(store.db, who.tokenId, { action: "edit", pageId: memoId, pageTitle: derivedTitle });
      return { page: store.pageDto(who, memoId), mergedComments: commentRows.length };
    });

    res.json(outcome);
  });
}
