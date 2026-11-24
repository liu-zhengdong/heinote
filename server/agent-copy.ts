import type { Express, Request } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { descendantPageIds, inTrash, isPurging } from "../src/core/page-tree.ts";
import { relinkContent } from "../src/core/block-tree.ts";
import { blockRecordId } from "../src/platform/record-ids.ts";
import type { LoadedNotePage, StoredFile } from "../src/core/types.ts";
import { fail, id, type Actor, type Row, type Store } from "./store.ts";
import { externalScope, mutation } from "./mutation.ts";
import { recordTokenEvent } from "./token-identity.ts";

/* Copying a page's whole tree into another scope — the agent counterpart of
   the window's "拷贝到个人空间". Unlike the window's copy (which leaves
   attachments pointing at the source space), references here are remapped
   and the bytes re-stored under the destination's file index, so the copy
   is self-contained. Pages get fresh ids; links to copied pages point at
   the copies; links pointing outside stay literal. */

const inputSchema = z.object({
  requestId: z.string().min(1).max(256),
  /** Destination: "personal" or a space id the member may write to. */
  spaceId: z.string().min(1).max(256).optional(),
  /** Where the copy lands inside the destination; defaults: a knowledge
   *  base's home page, otherwise the destination's top level. */
  parentId: z.string().min(1).max(256).optional(),
}).strict();

const safeFileName = (name: string): string => {
  const sanitize = (value: string) => value.normalize("NFKD").replace(/[^\w.-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  const ext = /\.[^./]{1,10}$/.exec(name)?.[0] ?? "";
  const stem = sanitize(ext ? name.slice(0, -ext.length) : name) || "file";
  return `${stem}${ext}`.slice(-80);
};
const copiedPath = (file: StoredFile) => `files/agent/${randomUUID().replaceAll("-", "")}/${safeFileName(file.name)}`;

/** Rewrites every StoredFile nested anywhere in `value` through `rewrite`
 *  (blocks' `file`, image mentions, cover/icon/property pictures).
 *  A StoredFile is the only record shape carrying path+owner+size+type. */
function remapFiles<T>(value: T, rewrite: (file: StoredFile) => StoredFile): T {
  const visit = (node: unknown): unknown => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(visit);
    const record = node as Row;
    if (typeof record.path === "string" && typeof record.size === "number" && typeof record.type === "string" && typeof record.owner === "string") {
      return rewrite(record as StoredFile);
    }
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, visit(entry)]));
  };
  return visit(value) as T;
}

export function attachAgentCopy(app: Express, { store, actor }: { store: Store; actor: (req: Request) => Actor }): void {
  app.post("/api/v1/pages/:id/copy", async (req, res) => {
    const who = actor(req);
    const input = inputSchema.parse(req.body);
    const pageId = String(req.params.id);

    // Load page metadata only (no full-vault blocks/versions) and clone
    // content-addressed attachment index rows zero-copy inside the transaction.
    const source = store.page(who, pageId);
    const all = store.pagesState(who);
    if (inTrash(all, pageId)) {
      if (isPurging(all, pageId)) fail(404, "页面不存在。", "not_found");
      fail(409, "页面在回收站中，先恢复再拷贝。", "conflict");
    }
    const ids = [pageId, ...descendantPageIds(all, pageId)];
    const pages: LoadedNotePage[] = [];
    for (const idInTree of ids) {
      if (inTrash(all, idInTree)) continue;
      const found = store.page(who, idInTree);
      if (found.scope === source.scope) pages.push(found.page);
    }

    mutation(store, actor, req, res, input,
      (who) => {
        const source = store.page(who, pageId);
        const sourceTrash = store.pageTrashState(source.scope, pageId);
        if (sourceTrash.purging) fail(404, "页面不存在。", "not_found");
        if (sourceTrash.archived) fail(409, "页面在回收站中，先恢复再拷贝。", "conflict");
        const parent = input.parentId ? store.page(who, input.parentId) : undefined;
        const explicitScope = input.spaceId ? store.scope(who, input.spaceId, true) : undefined;
        if (parent && explicitScope && parent.scope !== explicitScope) fail(400, "父页面不属于目标空间。", "bad_request");
        const targetScope = parent?.scope ?? explicitScope ?? store.scope(who, "personal", true);
        store.scope(who, externalScope(targetScope), true);
        if (parent && parent.page.kind !== "document") fail(400, "父页面必须是文档页面。", "bad_request");
        if (parent) {
          const parentTrash = store.pageTrashState(parent.scope, parent.page.id);
          if (parentTrash.purging) fail(404, "父页面不存在。", "not_found");
          if (parentTrash.archived) fail(409, "父页面已归档。", "conflict");
        }
        const library = store.knowledgeBases.get(targetScope);
        const destination = parent?.page ?? (library ? store.page(who, library.homePageId).page : undefined);
        if (destination && destination.kind !== "document") fail(400, "父页面必须是文档页面。", "bad_request");
        if (!destination && !targetScope.startsWith("user:") && !library && !store.ownsScope(who, targetScope)) {
          fail(403, "只有所有者可以在共享空间顶层创建页面。", "owner_required");
        }
        return { source, targetScope, destination };
      },
      (who, { source, targetScope, destination }) => {
        const inPersonal = targetScope.startsWith("user:");
        // Fresh ids for the whole tree; internal links remapped, external
        // mentions left pointing where they did.
        const idsBySource = new Map(pages.map((page) => [page.id, id()]));
        const pathsBySource = new Map<string, string>();
        const copyFile = (file: StoredFile): StoredFile => {
          const path = pathsBySource.get(file.path) ?? copiedPath(file);
          pathsBySource.set(file.path, path);
          const cloned = store.files.clone(source.scope, file.path, targetScope, path);
          if (cloned === "conflict") fail(409, "附件路径冲突。", "conflict");
          const preview = file.preview
            ? (() => {
                const next = copiedPath(file);
                const previewCloned = store.files.clone(source.scope, file.preview, targetScope, next);
                if (previewCloned === "conflict") fail(409, "附件路径冲突。", "conflict");
                return next;
              })()
            : undefined;
          const { space: _space, ...rest } = file;
          return { ...rest, path, owner: who.user.id, ...(inPersonal ? {} : { space: targetScope }), ...(preview ? { preview } : {}) };
        };

        const now = new Date().toISOString();
        const author = who.user.id;
        const newRoot = idsBySource.get(pageId)!;
        for (const page of pages) {
          const isRoot = page.id === pageId;
          const copy: LoadedNotePage = remapFiles(structuredClone(page), copyFile);
          copy.id = idsBySource.get(page.id)!;
          copy.parent_id = isRoot ? destination?.id ?? null
            : idsBySource.get(page.parent_id ?? "") ?? null;
          copy.block_tree = {
            by_id: Object.fromEntries(Object.values(copy.block_tree.by_id).map((block) => {
              const renamed = {
                ...block,
                id: id(),
                parent_id: block.parent_id ? idsBySource.get(block.parent_id) ?? null : null,
                content: relinkContent(block.content, idsBySource),
              };
              return [renamed.id, renamed];
            })),
          };
          copy.created_at = now; copy.updated_at = now;
          copy.created_by = author; copy.updated_by = author;
          delete copy.share_space_id;
          // An app's bindings point at databases in the source space; the
          // copy keeps its source but arrives unbound.
          if (copy.app && targetScope !== source.scope) copy.app = { draft: copy.app.draft, enabled: copy.app.enabled };
          // A copied tree lands at the destination's top as a shared root.
          if (isRoot && !destination && !inPersonal) copy.share_space_id = targetScope;
          store.savePage(targetScope, copy, who, "复制了页面");
        }

        // Same as POST /pages: a child page also appears as an expanded link
        // at the end of its parent's body.
        if (destination) {
          const siblings = Object.values(destination.block_tree.by_id).filter((block) => !block.parent_id);
          const top = siblings.length ? Math.max(...siblings.map((block) => block.order)) : 0;
          const blockId = id();
          const docRow = store.one("SELECT generation FROM collaboration_documents WHERE scope=? AND page_id=?", targetScope, destination.id);
          const expected = docRow ? [{ scope: externalScope(targetScope), pageId: destination.id, generation: String(docRow.generation), revision: store.revision(targetScope, destination.id) }] : [];
          store.apply(who, [{ scope: externalScope(targetScope), collection: "blocks", id: blockRecordId(destination.id, blockId), action: "put", base: null,
            value: { id: blockId, page: destination.id, kind: "text", order: top + 1024, content: [{ embed: { mention: { kind: "page", page_id: newRoot, expanded: true } } }] } }], `copy-link:${input.requestId}`, [], expected);
        }
        recordTokenEvent(store.db, who.tokenId, { action: "copy", pageId: newRoot, pageTitle: source.page.title });
        // Materialize the copied pages' collaboration documents so the reply's
        // snapshot (pageDto) finds them — commit-time flush hasn't run yet.
        store.collaboration.flush();
        return { status: 201, body: store.pageDto(who, newRoot), scope: targetScope, pageIds: [newRoot, ...(destination ? [destination.id] : [])] };
      });
  });
}
