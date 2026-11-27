import { z } from "zod";
import { fail, type Actor, type Row, type Store } from "./store.ts";

export const transferSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("share"), spaceId: z.string().min(1).max(256) }).strict(),
  z.object({ action: z.literal("stop-share") }).strict(),
  z.object({ action: z.literal("move"), targetParentId: z.string().min(1).max(256).nullable(), sidebarOrder: z.number().finite().optional() }).strict(),
]);

export type TransferInput = z.infer<typeof transferSchema>;

export interface TransferResult {
  ok: true;
  pageId: string;
  sourceScope: string;
  targetScope: string;
  movedPages: number;
}

const externalScope = (scope: string) => scope.startsWith("user:") ? "personal" : scope;

/** Collect `rootId` and all of its descendants inside `scope` via one indexed
 *  page-table scan (cycle-safe, O(N)). */
function collectSubtree(store: Store, scope: string, rootId: string): { ids: string[]; rows: Map<string, Row> } {
  const raw = store.all("SELECT id, value FROM records WHERE scope=? AND collection='pages'", scope);
  const rows = new Map<string, Row>();
  const children = new Map<string, string[]>();
  for (const row of raw) {
    const id = String(row.id);
    const value = JSON.parse(String(row.value)) as Row;
    rows.set(id, value);
    if (typeof value.parent_id === "string" && value.parent_id) {
      const list = children.get(value.parent_id);
      if (list) list.push(id);
      else children.set(value.parent_id, [id]);
    }
  }
  if (!rows.has(rootId)) fail(404, "页面不存在。", "not_found");
  const ids: string[] = [];
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i];
    ids.push(current);
    for (const childId of children.get(current) ?? []) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      queue.push(childId);
    }
  }
  return { ids, rows };
}

/**
 * Unified server-side subtree scope transfer (UC-59):
 * - `share`: personal subtree -> ordinary shared space (leaves owner pointer)
 * - `stop-share`: ordinary shared root -> owner's personal space (revokes share)
 * - `move`: cross-space move between personal and ordinary shared spaces
 *
 * Moves records directly inside SQLite in 400-ID chunks without round-tripping
 * bodies/histories through the browser or hitting the 10,000-write batch cap.
 */
export function transferPageTree(store: Store, actor: Actor, pageId: string, input: TransferInput): TransferResult {
  return store.bulkTransaction(() => {
    const found = store.page(actor, pageId);
    const sourceScope = found.scope;
    const personalScope = `user:${actor.user.id}`;
    store.scope(actor, externalScope(sourceScope), true);
    const sourceTrash = store.pageTrashState(sourceScope, pageId);
    if (sourceTrash.purging) fail(404, "页面不存在。", "not_found");
    if (input.action === "move" && sourceTrash.archived) fail(409, "回收站中的页面不能移动，请先恢复。", "archived");
    if (store.knowledgeBases.get(sourceScope)) fail(403, "页面不能迁入或迁出团队知识库。", "knowledge_base_boundary");

    const sourceRoot = store.record(sourceScope, "pages", pageId);
    if (!sourceRoot) fail(404, "页面不存在。", "not_found");

    const { ids: subtreeIds, rows: sourceRows } = collectSubtree(store, sourceScope, pageId);

    const checkNoNestedShare = (targetScope: string) => {
      for (const id of subtreeIds) {
        if (id === pageId) continue;
        const row = sourceRows.get(id);
        if (row && typeof row.share_space_id === "string" && row.share_space_id && row.share_space_id !== targetScope) {
          fail(400, "子页面已处于独立分享空间，请先取消子页面分享。", "nested_share");
        }
      }
    };

    const moveRecordsBulk = (fromScope: string, toScope: string, descendantIds: readonly string[], allIds: readonly string[]) => {
      for (let i = 0; i < descendantIds.length; i += 400) {
        const chunk = descendantIds.slice(i, i + 400);
        const marks = chunk.map(() => "?").join(",");
        store.db.prepare(
          `INSERT INTO records(scope,collection,id,value)
           SELECT ?,collection,id,value FROM records WHERE scope=? AND collection='pages' AND id IN (${marks})
           ON CONFLICT(scope,collection,id) DO UPDATE SET value=excluded.value`,
        ).run(toScope, fromScope, ...chunk);
        store.db.prepare(
          `DELETE FROM records WHERE scope=? AND collection='pages' AND id IN (${marks})`,
        ).run(fromScope, ...chunk);
      }
      for (const collection of ["blocks", "versions", "page_events"] as const) {
        for (let i = 0; i < allIds.length; i += 400) {
          const chunk = allIds.slice(i, i + 400);
          const marks = chunk.map(() => "?").join(",");
          store.db.prepare(
            `INSERT INTO records(scope,collection,id,value)
             SELECT ?,collection,id,value FROM records WHERE scope=? AND collection=? AND json_extract(value,'$.page') IN (${marks})
             ON CONFLICT(scope,collection,id) DO UPDATE SET value=excluded.value`,
          ).run(toScope, fromScope, collection, ...chunk);
          store.db.prepare(
            `DELETE FROM records WHERE scope=? AND collection=? AND json_extract(value,'$.page') IN (${marks})`,
          ).run(fromScope, collection, ...chunk);
        }
      }
    };

    const deleteSharesFor = (scope: string, ids: readonly string[]) => {
      for (let i = 0; i < ids.length; i += 400) {
        const chunk = ids.slice(i, i + 400);
        const marks = chunk.map(() => "?").join(",");
        store.db.prepare(`DELETE FROM shares WHERE scope=? AND page_id IN (${marks})`).run(scope, ...chunk);
      }
    };

    const revokeShareSpace = (spaceId: string) => {
      store.db.prepare("DELETE FROM members WHERE space_id=? AND role!='owner'").run(spaceId);
      store.db.prepare("UPDATE invitations SET status='revoked' WHERE space_id=? AND status='pending'").run(spaceId);
      store.db.prepare("DELETE FROM shares WHERE scope=?").run(spaceId);
      store.collaboration.notifyPermissionChange({ scope: spaceId });
    };

    const updatePersonalRoots = (mode: "add" | "remove", id: string) => {
      const roots = store.record(personalScope, "workspace_settings", "roots");
      const list = Array.isArray(roots?.roots) ? (roots.roots as string[]) : [];
      if (mode === "remove") {
        if (!list.includes(id)) return;
        store.put(personalScope, "workspace_settings", "roots", { ...(roots ?? {}), roots: list.filter((entry) => entry !== id) });
      } else {
        if (list.includes(id)) return;
        store.put(personalScope, "workspace_settings", "roots", { ...(roots ?? {}), roots: [...list, id] });
      }
    };

    if (input.action === "share") {
      const targetScope = store.scope(actor, input.spaceId, true);
      if (targetScope.startsWith("user:") || store.knowledgeBases.get(targetScope)) {
        fail(403, "只能分享到普通协作空间。", "knowledge_base_boundary");
      }
      if (store.role(actor, targetScope) !== "owner") {
        fail(403, "只有所有者可设置分享位置。", "owner_required");
      }
      if (sourceScope === targetScope && sourceRoot.share_space_id === targetScope) {
        return { ok: true, pageId, sourceScope: externalScope(sourceScope), targetScope: externalScope(targetScope), movedPages: 0 };
      }
      if (sourceScope !== personalScope) {
        fail(409, "页面已处于其他协作空间。", "conflict");
      }
      checkNoNestedShare(targetScope);
      const sharedRoot: Row = { ...sourceRoot, share_space_id: targetScope };
      const descendants = subtreeIds.slice(1);
      store.put(personalScope, "pages", pageId, sharedRoot);
      store.put(targetScope, "pages", pageId, sharedRoot);
      moveRecordsBulk(personalScope, targetScope, descendants, subtreeIds);
      deleteSharesFor(personalScope, subtreeIds);
      store.collaboration.migrateScope(personalScope, targetScope, subtreeIds, pageId);
      return { ok: true, pageId, sourceScope: externalScope(sourceScope), targetScope: externalScope(targetScope), movedPages: subtreeIds.length };
    }

    if (input.action === "stop-share") {
      if (sourceScope.startsWith("user:") || sourceRoot.share_space_id !== sourceScope) {
        fail(409, "目标页面不是已分享的根页面。", "conflict");
      }
      if (store.role(actor, sourceScope) !== "owner") {
        fail(403, "只有所有者可以结束页面分享。", "owner_required");
      }
      const targetScope = personalScope;
      const personalPointer = store.record(targetScope, "pages", pageId);
      const privateRoot: Row = { ...sourceRoot };
      delete privateRoot.share_space_id;
      if (personalPointer && typeof personalPointer.parent_id === "string") privateRoot.parent_id = personalPointer.parent_id;
      else if (personalPointer && personalPointer.parent_id === undefined) delete privateRoot.parent_id;
      const descendants = subtreeIds.slice(1);
      store.put(targetScope, "pages", pageId, privateRoot);
      moveRecordsBulk(sourceScope, targetScope, descendants, subtreeIds);
      store.db.prepare("DELETE FROM records WHERE scope=? AND collection='pages' AND id=?").run(sourceScope, pageId);
      revokeShareSpace(sourceScope);
      store.collaboration.migrateScope(sourceScope, targetScope, subtreeIds, pageId);
      return { ok: true, pageId, sourceScope: externalScope(sourceScope), targetScope: externalScope(targetScope), movedPages: subtreeIds.length };
    }

    // action === "move"
    let targetScope = personalScope;
    let targetParent: Row | undefined;
    if (input.targetParentId !== null) {
      if (input.targetParentId === pageId || subtreeIds.includes(input.targetParentId)) {
        fail(400, "页面不能形成循环。", "bad_request");
      }
      const parentFound = store.page(actor, input.targetParentId);
      targetScope = parentFound.scope;
      store.scope(actor, externalScope(targetScope), true);
      if (store.knowledgeBases.get(targetScope)) fail(403, "页面不能迁入或迁出团队知识库。", "knowledge_base_boundary");
      const targetTrash = store.pageTrashState(targetScope, input.targetParentId);
      if (targetTrash.purging) fail(409, "目标父页面正在删除中。", "purging");
      if (targetTrash.archived) fail(409, "目标父页面在回收站中。", "archived");
      targetParent = store.record(targetScope, "pages", input.targetParentId);
      if (!targetParent) fail(404, "目标父页面不存在。", "not_found");
      if (targetParent.kind === "database" || targetParent.kind === "app") {
        fail(400, "不能将页面移入数据库或应用页面。", "bad_request");
      }
    }

    if (sourceScope === targetScope) {
      if (!sourceScope.startsWith("user:") && sourceRoot.share_space_id === sourceScope && input.targetParentId === null) {
        fail(400, "空间页面必须属于已分享的页面树。", "bad_request");
      }
      const nextRoot: Row = { ...sourceRoot };
      if (input.targetParentId === null) delete nextRoot.parent_id;
      else nextRoot.parent_id = input.targetParentId;
      if (targetParent?.kind === "database") nextRoot.row_order = Date.now();
      if (input.sidebarOrder !== undefined) nextRoot.sidebar_order = input.sidebarOrder;
      store.put(sourceScope, "pages", pageId, nextRoot);
      if (sourceScope === personalScope) updatePersonalRoots(input.targetParentId === null ? "add" : "remove", pageId);
      store.validatePlane(actor, sourceScope, {
        putPages: new Set([pageId]),
        deletedPages: new Set(),
        putBlocks: new Map(),
        putVersions: new Map(),
      });
      return { ok: true, pageId, sourceScope: externalScope(sourceScope), targetScope: externalScope(targetScope), movedPages: 1 };
    }

    const leavingShareRoot = !sourceScope.startsWith("user:") && sourceRoot.share_space_id === sourceScope;
    if (leavingShareRoot && store.role(actor, sourceScope) !== "owner") {
      fail(403, "只有所有者可以结束页面分享。", "owner_required");
    }
    if (!store.ownsScope(actor, sourceScope)) {
      fail(403, "不能将他人共享空间的页面移出，请使用拷贝功能。", "owner_required");
    }
    if (!store.ownsScope(actor, targetScope)) {
      fail(403, "不能将页面移入他人共享的空间，请使用拷贝功能。", "owner_required");
    }
    checkNoNestedShare(targetScope);

    const movedRoot: Row = { ...sourceRoot };
    delete movedRoot.share_space_id;
    if (input.targetParentId === null) delete movedRoot.parent_id;
    else movedRoot.parent_id = input.targetParentId;
    if (targetParent?.kind === "database") movedRoot.row_order = Date.now();
    if (input.sidebarOrder !== undefined) movedRoot.sidebar_order = input.sidebarOrder;

    const descendants = subtreeIds.slice(1);
    store.put(targetScope, "pages", pageId, movedRoot);
    moveRecordsBulk(sourceScope, targetScope, descendants, subtreeIds);
    store.db.prepare("DELETE FROM records WHERE scope=? AND collection='pages' AND id=?").run(sourceScope, pageId);
    if (leavingShareRoot) {
      if (targetScope !== personalScope) {
        store.db.prepare("DELETE FROM records WHERE scope=? AND collection='pages' AND id=?").run(personalScope, pageId);
      }
      revokeShareSpace(sourceScope);
    } else {
      deleteSharesFor(sourceScope, subtreeIds);
    }
    if (sourceScope === personalScope) updatePersonalRoots("remove", pageId);
    if (targetScope === personalScope) updatePersonalRoots(input.targetParentId === null ? "add" : "remove", pageId);
    store.collaboration.migrateScope(sourceScope, targetScope, subtreeIds, pageId);
    return { ok: true, pageId, sourceScope: externalScope(sourceScope), targetScope: externalScope(targetScope), movedPages: subtreeIds.length };
  });
}
