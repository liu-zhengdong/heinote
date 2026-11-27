import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { createId, uuid } from "../core/ids";
import { BLOCK_ORDER_STEP, isLoadedPage, linesFor, newPage, orderedBlocks, pageLine, pageName, relinkContent } from "../core/block-tree";
import { databaseRows, newDatabaseConfig, rowKey, rowOrderAfter } from "../features/database/database-model";
import { markFresh } from "../features/database/fresh";
import { reidentify } from "../features/editor/editor-commands";
import type { BlockMutation, BlockTree, DatabaseConfig, NotePage, PageVersion, SpaceSummary } from "../core/types";
import { canDeletePage as canDeletePageIn, canMovePage as canMovePageIn, canOrderPage as canOrderPageIn, canRestorePage as canRestorePageIn, canShelvePage as canShelvePageIn, canTrashPage as canTrashPageIn, descendantPageIds, inTrash, spaceOfPage } from "../core/page-tree";
import { comparePages, nextSidebarOrder, planSidebarReorder } from "../features/sidebar/tree";
import { firstPageInSpace, navigationSpaceOf } from "../core/space-navigation";
import { renamedTitle } from "../core/title";
import { pageBasis } from "../collaboration/client";
import { publishRecovery } from "../collaboration/recovery";
import type { PlatformClient } from "../platform/client";
import { ApiError, request } from "../platform/http";
import type { WorkspaceDocument, WorkspaceMutation } from "../platform/workspace-document";
import { bodyPath, linkIntoParent, trashWrites } from "./page-rows";

/** The fields of a page a caller may change directly; its body is the
 *  editor's, written block by block. */
export type PagePatch = Partial<Omit<NotePage, "id" | "block_tree" | "created_at" | "created_by" | "updated_at" | "updated_by">>;

export interface CreatePageOptions {
  /** Open the page once it exists. On by default: creating a page is usually
   *  the start of writing in it. An inline database is the exception — it is
   *  made to be drawn where you already are, not to take you somewhere else. */
  select?: boolean;
  /** A database's starting shape, in place of the blank one-table default. */
  database?: DatabaseConfig;
  /** Leave the page's block at the end of its parent's body, as Notion does
   *  for a page made from the sidebar. The editor, which leaves its own block
   *  where the caret is, does not ask. */
  block?: boolean;
  /** Its name from the start — a page made from a mention is named by what
   *  was typed after the `@`. */
  title?: string;
}

export interface MovePageOptions {
  /** Target manual sidebar order for the moved/reordered page. */
  sidebarOrder?: number;
  /** Optional sibling re-spacing map produced by `planSidebarReorder`. */
  rewriteOrders?: Record<string, number>;
}

/** Active siblings under `parentId` (null: top level of personal navigation). */
function siblingsUnder(pages: Record<string, NotePage>, parentId: string | null): NotePage[] {
  return Object.values(pages).filter((page) => page?.id && !inTrash(pages, page.id) && (page.parent_id ?? null) === parentId);
}

/** A copied page's body: every paragraph under a fresh id — so the copy and
 *  the original can be drawn side by side, a block beside its copy — and its
 *  links to the pages copied with it pointing at their copies. */
function remapPageBlocks(tree: BlockTree, copies: ReadonlyMap<string, string>): BlockTree {
  const fresh = reidentify(tree, () => createId("block"));
  return {
    by_id: Object.fromEntries(Object.values(fresh.by_id).map((block) => [block.id, { ...block, content: relinkContent(block.content, copies) }])),
  };
}

function blankPage(id: string, kind: NotePage["kind"], parentId: string | null, author: string): NotePage {
  return {
    ...newPage(id, kind, parentId, { now: new Date().toISOString(), author }, createId("block")),
    // A database starts as Notion's blank one: a table, and every row's name.
    ...(kind === "database" ? { database: newDatabaseConfig("table", createId("view"), () => createId("property")) } : {}),
    // An app starts unconfigured: no source, no bindings.
    ...(kind === "app" ? { app: {} } : {}),
  };
}

export interface PageOpsDeps {
  document: WorkspaceDocument | null;
  platform: PlatformClient | null;
  activeSpaceId: string;
  selectedPageId: string;
  selectedRef: MutableRefObject<string>;
  spaces: Record<string, SpaceSummary>;
  spacesRef: MutableRefObject<Record<string, SpaceSummary>>;
  commit(mutations: WorkspaceMutation[], record?: boolean): void;
  selectPage(pageId: string): void;
  setSelectedPageId: Dispatch<SetStateAction<string>>;
  setEmptySpaceId: Dispatch<SetStateAction<string>>;
}

export function useWorkspacePageOps({
  document,
  platform,
  activeSpaceId,
  selectedPageId,
  selectedRef,
  spaces,
  spacesRef,
  commit,
  selectPage,
  setSelectedPageId,
  setEmptySpaceId,
}: PageOpsDeps) {
  /* Leaving a page checkpoints it. Without this, page history only ever holds
     renames, and the panel has nothing worth restoring. `checkpointPage`
     discards a snapshot identical to the last one, so simply walking the tree
     records nothing. */
  const previousPageId = useRef("");

  const createPage = useCallback((
    parentId: string | null = null,
    kind: NotePage["kind"] = "document",
    options: CreatePageOptions = {},
  ) => {
    if (!document || !platform) return null;
    parentId ??= spacesRef.current[activeSpaceId]?.knowledgeBase?.homePageId ?? null;
    if (parentId && (!document.state.pages[parentId] || inTrash(document.state.pages, parentId))) return null;
    const scope = parentId ? spaceOfPage(document.state.pages, parentId) : undefined;
    const targetSpace = scope ? spacesRef.current[scope] : undefined;
    if (scope && (!targetSpace || targetSpace.knowledgeBase?.archived || !["owner", "admin", "editor"].includes(targetSpace.role))) return null;
    const id = createId(kind === "database" ? "database" : "page");
    const blank = blankPage(id, kind, parentId, platform.bootstrap.user.displayName);
    const siblings = siblingsUnder(document.state.pages, parentId);
    const ordered: NotePage = { ...blank, sidebar_order: nextSidebarOrder(siblings, Date.now()) };
    const named = options.title ? { ...ordered, title: options.title } : ordered;
    const page = kind === "database" && options.database ? { ...named, database: options.database } : named;
    const mutations: WorkspaceMutation[] = [{ type: "set", path: ["pages", id], value: page }];
    const parent = parentId ? document.state.pages[parentId] : null;
    if (!parentId) mutations.push({ type: "set", path: ["roots"], value: [...document.state.roots, id] });
    if (options.block) {
      const link = linkIntoParent(parent, pageLine(createId("block"), id));
      if (link.length) mutations.push(...link);
      /* A parent whose body is not pulled in (UC-48) gets its link late:
         the body is pulled, then the line lands among its rows — the page
         is never left out of where it was made. */
      else if (parent && !isLoadedPage(parent)) {
        void document.loadPages([parent.id]).then(() => {
          const fresh = document.state.pages[parent.id];
          if (fresh?.kind === "document") commit(linkIntoParent(fresh, pageLine(createId("block"), id)));
        }).catch(() => undefined);
      }
    }
    commit(mutations);
    if (options.select !== false) {
      markFresh(id);
      setSelectedPageId(id);
    }
    return id;
  }, [commit, document, platform, activeSpaceId, spacesRef, setSelectedPageId]);

  const updatePage = useCallback((pageId: string, patch: PagePatch) => {
    if (!document || !platform) return;
    const current = document.state.pages[pageId];
    if (!current) return;
    // A name renamed as plain words — the page list, "Name…", a database's
    // title — keeps its links on the words the rename did not touch.
    const fields: PagePatch = patch.title !== undefined && !("title_content" in patch)
      ? { ...patch, ...renamedTitle(current, patch.title) }
      : patch;
    /* An emoji icon and a picture icon set one another out. Setting `icon`
     *  to anything — emoji or nothing — drops `icon_image`; setting
     *  `icon_image` empties `icon` (a page record keeps it always: "" is its
     *  empty). */
    if ("icon" in fields && !("icon_image" in fields)) fields.icon_image = undefined;
    else if ("icon_image" in fields && !("icon" in fields)) fields.icon = "";
    const mutations: WorkspaceMutation[] = [];
    for (const [key, value] of Object.entries(fields)) {
      if (JSON.stringify(current[key as keyof NotePage]) === JSON.stringify(value)) continue;
      if (value === undefined) mutations.push({ type: "delete", path: ["pages", pageId, key] });
      else mutations.push({ type: "set", path: ["pages", pageId, key], value });
    }
    if (!mutations.length) return;
    commit([
      ...mutations,
      { type: "set", path: ["pages", pageId, "updated_at"], value: new Date().toISOString() },
      { type: "set", path: ["pages", pageId, "updated_by"], value: platform.bootstrap.user.displayName },
    ]);
  }, [commit, document, platform]);

  const duplicateNow = useCallback((pageId: string, options: { block?: boolean; sameTitle?: boolean; toPersonal?: boolean } = {}) => {
    if (!document || !platform) return null;
    const source = document.state.pages[pageId];
    if (!source) return null;
    const sourceScope = spaceOfPage(document.state.pages, pageId);
    const sourceSpace = sourceScope ? spacesRef.current[sourceScope] : undefined;
    /* Copying out to the member's own space is allowed even for viewers —
       they can already read every word; blocking the copy would be
       ceremonial. The copy is a new page, not a move, so the knowledge-base
       boundary (pages never move in or out) is untouched. */
    if (sourceSpace?.knowledgeBase && !options.toPersonal
        && (sourceSpace.knowledgeBase.homePageId === pageId || sourceSpace.knowledgeBase.archived || sourceSpace.role === "viewer")) return null;
    const now = new Date().toISOString();
    const author = platform.bootstrap.user.displayName;
    const idByOriginal = new Map<string, string>([[pageId, createId(source.kind === "database" ? "database" : "page")]]);
    for (const id of descendantPageIds(document.state.pages, pageId)) idByOriginal.set(id, createId("page"));

    const mutations: WorkspaceMutation[] = [];
    for (const [originalId, copyId] of idByOriginal) {
      const original = document.state.pages[originalId];
      if (!original) continue;
      const title = originalId === pageId && !options.sameTitle ? `${pageName(original)} (copy)` : original.title;
      const copy: NotePage = {
        ...structuredClone(original),
        ...(original.block_tree ? { block_tree: remapPageBlocks(structuredClone(original.block_tree), idByOriginal) } : {}),
        id: copyId,
        // The copy's name keeps the original's links.
        ...renamedTitle(original, title),
        // To the personal space: the copy's root detaches, so its records
        // land in the member's own plane — a fresh private page that can be
        // shared or published like any other.
        parent_id: options.toPersonal && originalId === pageId ? null
          : original.parent_id && idByOriginal.has(original.parent_id)
            ? idByOriginal.get(original.parent_id)!
            : original.parent_id,
        created_at: now,
        updated_at: now,
        created_by: author,
        updated_by: author,
      };
      delete copy.share_space_id;
      if (originalId === pageId) {
        delete copy.shelved;
        delete copy.shelved_at;
      }
      // A row copied with its database keeps its place among the rows; the
      // row copied by itself goes right after the original.
      const database = original.parent_id ? document.state.pages[original.parent_id] : undefined;
      if (database?.kind === "database") {
        copy.row_order = originalId === pageId
          ? rowOrderAfter(databaseRows(document.state.pages, database.id), pageId, Date.now())
          : rowKey(original);
      }
      mutations.push({ type: "set", path: ["pages", copyId], value: copy });
    }

    const rootCopyId = idByOriginal.get(pageId)!;
    const copyParentId = options.toPersonal ? null : (source.parent_id ?? null);
    const copySiblings = siblingsUnder(document.state.pages, copyParentId).sort(comparePages("manual"));
    const copyWrite = mutations.find((item) => item.type === "set" && item.path.length === 2 && item.path[0] === "pages" && item.path[1] === rootCopyId);
    if (copyWrite?.type === "set" && copyWrite.value && typeof copyWrite.value === "object") {
      const copyPage = copyWrite.value as NotePage;
      if (options.toPersonal) {
        copyPage.sidebar_order = nextSidebarOrder(copySiblings, Date.now());
      } else {
        const afterIndex = copySiblings.findIndex((item) => item.id === pageId) + 1;
        const plan = planSidebarReorder(copySiblings, copyPage, afterIndex > 0 ? afterIndex : copySiblings.length, {
          currentSort: "manual",
          now: Date.now(),
          canOrder: (candidateId) => canOrderPageIn(document.state.pages, spacesRef.current, candidateId),
        });
        if (plan) {
          copyPage.sidebar_order = plan.sidebar_order;
          if (plan.rewrite) {
            for (const [siblingId, order] of Object.entries(plan.rewrite)) {
              if (siblingId !== rootCopyId) mutations.push({ type: "set", path: ["pages", siblingId, "sidebar_order"], value: order });
            }
          }
        }
      }
    }
    // The copy's line goes right after the original's, in their parent. A
    // copy bound for the personal space has no parent there — skip the
    // back-reference entirely.
    const holder = !options.toPersonal && source.parent_id ? document.state.pages[source.parent_id] : undefined;
    const home = options.block !== false && holder?.kind === "document" && isLoadedPage(holder) ? linesFor(holder.block_tree, pageId)[0] : undefined;
    if (holder && home && isLoadedPage(holder)) {
      const siblings = orderedBlocks(holder.block_tree, home.parent_id);
      const next = siblings[siblings.findIndex((block) => block.id === home.id) + 1];
      const blockId = createId("block");
      mutations.push({
        type: "set",
        path: bodyPath(holder.id, blockId),
        value: { ...home, id: blockId, content: relinkContent(home.content, new Map([[pageId, rootCopyId]])), order: next ? (home.order + next.order) / 2 : home.order + BLOCK_ORDER_STEP },
      });
    }
    if (!source.parent_id || options.toPersonal) {
      const roots = [...document.state.roots];
      roots.splice(options.toPersonal ? roots.length : roots.indexOf(pageId) + 1, 0, rootCopyId);
      mutations.push({ type: "set", path: ["roots"], value: roots });
    }
    commit(mutations);
    return rootCopyId;
  }, [commit, document, platform, spacesRef]);

  /* Copying needs every body of the tree: an unread page's copy would be
     born empty. The synchronous path runs when it is all in; otherwise the
     bodies are pulled (UC-48) and the copy made then — callers of the slow
     path get `null` now and the page appears on its own. */
  const duplicatePage = useCallback((pageId: string, options: { block?: boolean; sameTitle?: boolean; toPersonal?: boolean } = {}) => {
    if (!document || !platform) return null;
    const needed = [pageId, ...descendantPageIds(document.state.pages, pageId)];
    const missing = needed.filter((id) => !isLoadedPage(document.state.pages[id]));
    if (missing.length) {
      void document.loadPages(missing).then(() => duplicateNow(pageId, options)).catch(() => undefined);
      return null;
    }
    return duplicateNow(pageId, options);
  }, [document, platform, duplicateNow]);

  const copyPageTo = useCallback(async (pageId: string, parentId: string | null): Promise<string | null> => {
    if (!document || !platform) return null;
    const targetSpace = parentId ? spaceOfPage(document.state.pages, parentId) : undefined;
    const body: Record<string, string> = { requestId: `copy-${uuid()}` };
    if (parentId) {
      body.parentId = parentId;
      if (targetSpace) body.spaceId = targetSpace;
    } else {
      body.spaceId = "personal";
    }
    const answer = await request<{ id: string }>(`/api/v1/pages/${encodeURIComponent(pageId)}/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await document.refreshScope(targetSpace ?? "personal");
    void document.loadPages(parentId ? [answer.id, parentId] : [answer.id]).catch(() => undefined);
    return answer.id;
  }, [document, platform]);

  /** Re-parents and/or reorders a page in the sidebar tree. Refuses to drop a
   *  page inside its own subtree, which is the only move that could orphan a
   *  branch. */
  const movePage = useCallback((pageId: string, parentId: string | null, options: MovePageOptions = {}) => {
    if (!document) return;
    const page = document.state.pages[pageId];
    if (!page || pageId === parentId) return;
    const currentParentId = page.parent_id ?? null;
    const sameParent = currentParentId === parentId;
    if (sameParent) {
      if (options.sidebarOrder === undefined && !options.rewriteOrders) return;
      if (!canOrderPageIn(document.state.pages, spacesRef.current, pageId)) return;
      const mutations: WorkspaceMutation[] = [];
      if (options.rewriteOrders) {
        for (const [id, order] of Object.entries(options.rewriteOrders)) {
          if (id === pageId || canOrderPageIn(document.state.pages, spacesRef.current, id)) {
            if (document.state.pages[id]?.sidebar_order !== order) {
              mutations.push({ type: "set", path: ["pages", id, "sidebar_order"], value: order });
            }
          }
        }
      } else if (options.sidebarOrder !== undefined && page.sidebar_order !== options.sidebarOrder) {
        mutations.push({ type: "set", path: ["pages", pageId, "sidebar_order"], value: options.sidebarOrder });
      }
      if (mutations.length) commit(mutations);
      return;
    }
    if (!canMovePageIn(document.state.pages, spacesRef.current, pageId, parentId)) return;
    if (parentId && descendantPageIds(document.state.pages, pageId).includes(parentId)) return;
    const nextOrder = options.sidebarOrder ?? nextSidebarOrder(
      siblingsUnder(document.state.pages, parentId).filter((item) => item.id !== pageId),
      Date.now(),
    );
    /* A move across scopes runs server-side (UC-59) so large subtrees transfer
       in SQLite without pulling all bodies/histories into the browser. */
    const crossing = spaceOfPage(document.state.pages, pageId) !== (parentId ? spaceOfPage(document.state.pages, parentId) : undefined);
    if (crossing) {
      const siblingRewrites = options.rewriteOrders
        ? Object.entries(options.rewriteOrders).filter(([id]) => id !== pageId && canOrderPageIn(document.state.pages, spacesRef.current, id))
        : [];
      void document.transferPage(pageId, parentId, { sidebarOrder: nextOrder }).then(() => {
        if (!siblingRewrites.length) return;
        const writes: WorkspaceMutation[] = siblingRewrites
          .filter(([id, order]) => document.state.pages[id] && document.state.pages[id].sidebar_order !== order)
          .map(([id, order]) => ({ type: "set", path: ["pages", id, "sidebar_order"], value: order }));
        if (writes.length) commit(writes);
      }).catch((error) => {
        if (platform) publishRecovery(platform.bootstrap.user.id, { message: error instanceof Error ? error.message : "页面移动失败。", writes: [] });
      });
      return;
    }
    const mutations: WorkspaceMutation[] = [
      { type: "set", path: ["pages", pageId, "parent_id"], value: parentId },
      { type: "set", path: ["pages", pageId, "sidebar_order"], value: nextOrder },
    ];
    if (options.rewriteOrders) {
      for (const [id, order] of Object.entries(options.rewriteOrders)) {
        if (id === pageId) continue;
        if (canOrderPageIn(document.state.pages, spacesRef.current, id) && document.state.pages[id]?.sidebar_order !== order) {
          mutations.push({ type: "set", path: ["pages", id, "sidebar_order"], value: order });
        }
      }
    }
    const roots = document.state.roots.filter((id) => id !== pageId);
    mutations.push({ type: "set", path: ["roots"], value: parentId ? roots : [...roots, pageId] });
    const nextParent = parentId ? document.state.pages[parentId] : null;
    // Into a database, it is the newest of its rows.
    if (nextParent?.kind === "database") mutations.push({ type: "set", path: ["pages", pageId, "row_order"], value: Date.now() });
    commit(mutations);
  }, [commit, document, platform, spacesRef]);

  const applyBlockMutations = useCallback((pageId: string, mutations: BlockMutation[]) => {
    if (!document || !platform || !mutations.length) return;
    const now = new Date().toISOString();
    commit([
      ...mutations.map((mutation) => mutation.action === "put" ? {
        type: "set" as const,
        path: ["pages", pageId, "block_tree", "by_id", mutation.block.id],
        value: mutation.block,
      } : {
        type: "delete" as const,
        path: ["pages", pageId, "block_tree", "by_id", mutation.blockId],
      }),
      { type: "set", path: ["pages", pageId, "updated_at"], value: now },
      { type: "set", path: ["pages", pageId, "updated_by"], value: platform.bootstrap.user.displayName },
    ]);
  }, [commit, document, platform]);

  const checkpointPage = useCallback((pageId: string, summary: string) => {
    if (!document || !platform) return true;
    const page = document.state.pages[pageId];
    if (!page) return true;
    if (globalThis.navigator?.onLine === false) return true;
    // A page this member may only read keeps the history its editors write:
    // a viewer's checkpoint would be turned away by the space.
    const spaceId = spaceOfPage(document.state.pages, pageId);
    if (spaceId && (!spaces[spaceId] || spaces[spaceId].role === "viewer" || spaces[spaceId].knowledgeBase?.archived)) return true;
    void document.afterWrites(
      () => request(`/api/v1/pages/${encodeURIComponent(pageId)}/checkpoint`, { method: "POST", body: JSON.stringify({ summary }) }),
      { trackRefusal: false },
    ).catch((error) => {
      if (!(error instanceof ApiError)) return;
      if (error.status >= 500 || error.status === 404 || error.status === 409) return;
      publishRecovery(platform.bootstrap.user.id, { message: error.message || "版本未保存。", writes: [], dedupe: `checkpoint:${pageId}` });
    });
    return true;
  }, [document, platform, spaces]);

  useEffect(() => {
    const leaving = previousPageId.current;
    previousPageId.current = selectedPageId;
    if (leaving && leaving !== selectedPageId) checkpointPage(leaving, "Edited page");
  }, [checkpointPage, selectedPageId]);

  const setPageShelved = useCallback((pageId: string, shelved: boolean) => {
    if (!document || !platform) return;
    if (!canShelvePageIn(document.state.pages, spacesRef.current, pageId)) return;
    const current = document.state.pages[pageId];
    if (!current || Boolean(current.shelved) === shelved) return;
    commit([
      shelved
        ? { type: "set", path: ["pages", pageId, "shelved"], value: true }
        : { type: "delete", path: ["pages", pageId, "shelved"] },
      shelved
        ? { type: "set", path: ["pages", pageId, "shelved_at"], value: new Date().toISOString() }
        : { type: "delete", path: ["pages", pageId, "shelved_at"] },
    ]);
  }, [commit, document, platform, spacesRef]);

  const archivePage = useCallback((pageId: string) => {
    if (!document) return;
    const page = document.state.pages[pageId];
    if (!page || !canTrashPageIn(document.state.pages, spacesRef.current, pageId)) return;
    const affected = new Set([pageId, ...descendantPageIds(document.state.pages, pageId)]);
    const spaceId = navigationSpaceOf(document.state.pages, spacesRef.current, pageId);
    // Links stay in place and identify the page as being in the trash.
    commit(trashWrites(pageId));
    if (affected.has(selectedRef.current)) {
      setEmptySpaceId(spaceId);
      setSelectedPageId(page.parent_id ?? firstPageInSpace(document.state, spacesRef.current, spaceId));
    }
  }, [commit, document, selectedRef, spacesRef, setEmptySpaceId, setSelectedPageId]);

  const restorePage = useCallback((pageId: string, options: { select?: boolean } = {}) => {
    if (!document) return;
    const page = document.state.pages[pageId];
    if (!page || !canRestorePageIn(document.state.pages, spacesRef.current, pageId)) return;
    const scope = spaceOfPage(document.state.pages, pageId);
    const space = scope ? spacesRef.current[scope] : undefined;
    const mutations: WorkspaceMutation[] = [
      { type: "delete", path: ["pages", pageId, "archived"] },
      { type: "delete", path: ["pages", pageId, "archived_at"] },
    ];
    const parent = page.parent_id ? document.state.pages[page.parent_id] : undefined;
    // A restored page whose parent is gone comes back at the top level.
    if (page.parent_id && !parent) {
      const home = space?.knowledgeBase?.homePageId ?? null;
      mutations.push({ type: "set", path: ["pages", pageId, "parent_id"], value: home });
      if (!home) mutations.push({ type: "set", path: ["roots"], value: [...document.state.roots.filter((id) => id !== pageId), pageId] });
    }
    commit(mutations);
    if (options.select !== false) selectPage(pageId);
  }, [commit, document, selectPage, spacesRef]);

  /** Permanent removal from the trash: queues background bottom-up purge on
   *  the server and syncs the immediate `purging` marker back to this window. */
  const deletePage = useCallback(async (pageId: string) => {
    if (!document) return;
    const page = document.state.pages[pageId];
    if (!page) return;
    if (!canDeletePageIn(document.state.pages, spacesRef.current, pageId)) throw new ApiError("当前角色不能永久删除此页面。", 403, "forbidden");
    const scopeName = spaceOfPage(document.state.pages, pageId) ?? "personal";
    const navigationSpace = navigationSpaceOf(document.state.pages, spacesRef.current, pageId);
    const removed = new Set([pageId, ...descendantPageIds(document.state.pages, pageId)]);
    await document.flush();
    await request(`/api/pages/${encodeURIComponent(pageId)}/purge`, {
      method: "POST",
      body: JSON.stringify({ scope: scopeName }),
    });
    await document.refreshScope(scopeName);
    if (scopeName !== "personal") await document.refreshScope("personal");
    if (removed.has(selectedRef.current)) setEmptySpaceId(navigationSpace);
    setSelectedPageId((current) => (removed.has(current) ? "" : current));
  }, [document, selectedRef, spacesRef, setEmptySpaceId, setSelectedPageId]);

  const restoreVersion = useCallback((pageId: string, version: PageVersion) => {
    if (!document || !platform) return;
    void document.afterWrites(async () => {
      const scope = spaceOfPage(document.state.pages, pageId) ?? "personal";
      const basis = pageBasis(scope, pageId);
      await request(`/api/v1/pages/${encodeURIComponent(pageId)}/restore`, { method: "POST", body: JSON.stringify({ versionId: version.id, baseRevision: basis?.revision }) });
    }).catch((error) => publishRecovery(platform.bootstrap.user.id, { message: error instanceof Error ? error.message : "版本未恢复。", writes: [] }));
  }, [document, platform]);

  return {
    createPage,
    updatePage,
    duplicatePage,
    copyPageTo,
    movePage,
    applyBlockMutations,
    checkpointPage,
    setPageShelved,
    archivePage,
    restorePage,
    deletePage,
    restoreVersion,
  };
}
