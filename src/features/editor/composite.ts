import { bodyPath, trashWrites } from "../../app/page-rows";
import { createBlock, descendantsOf, lineLink, pageLine } from "../../core/block-tree";
import type { Block, BlockTree, NotePage } from "../../core/types";
import type { WorkspaceMutation } from "../../platform/workspace-document";
import { applyEditorTransaction, duplicateBlocks, topLevelBlocks, type EditorTransaction } from "./editor-commands";

/* A block is a page — its own record, in the trash when deleted, shared,
   linked and listed as a page is. In the page it lives in it is drawn, and
   edited, in place: paragraphs grouped under its name.

   So the editor sees ONE tree (`composeTree`): the page's own paragraphs,
   with each block shown in place standing among them as a `page` node — its
   id the block's page id — that holds that page's own paragraphs, and the
   blocks shown in place in it, and so on down. Whatever the editor does to
   that tree goes back to the pages whose records hold each node
   (`routeTransaction`): a paragraph written inside a block is written to the
   block's page, one carried out of it moves to the page it lands in, a block
   made from paragraphs is a new page, a block deleted goes to the trash with
   everything in it, and one dissolved into the page around it is gone. A
   block stands in its page on a line holding a link to it, shown; any other
   link to a page is only a link — carried, copied or deleted, it never
   moves, copies or trashes the page it links to. */

export interface Composite {
  /** The page the tree is drawn for. */
  pageId: string;
  tree: BlockTree;
  /** Each block shown in place: the id of its row in the page it is shown
   *  in. */
  rows: ReadonlyMap<string, string>;
  /** The page whose record holds each node — for a block shown in place,
   *  the page holding its row. */
  owner: ReadonlyMap<string, string>;
  /** The page records it was made from: the page drawn and every block
   *  drawn in it, each as the record it was then. */
  sources: ReadonlyMap<string, NotePage>;
}

/** Whether a page's line is drawn as the page itself, in place: a document
 *  that lives in the page holding the line, shown there, not locked, and one
 *  this reader may write in — anything else is drawn as the row or the
 *  read-only frame it has always had. */
export type ShowInPlace = (row: Block, page: NotePage) => boolean;

/* Blocks of a page drawn one level down keep their identity from one
   composition to the next — only a changed block is a new object — so rows
   that did not change are not drawn again. */
const lifted = new WeakMap<Block, Block>();
function liftedInto(block: Block, pageId: string): Block {
  if (block.parent_id) return block;
  const cached = lifted.get(block);
  if (cached?.parent_id === pageId) return cached;
  const moved = { ...block, parent_id: pageId };
  lifted.set(block, moved);
  return moved;
}

/** The tree the editor draws for `top` — a page, or an old version of one:
 *  its own blocks, with every block of it shown in place drawn as itself,
 *  holding its own. Cycle-safe; a block whose paragraphs share ids with ones
 *  already drawn stays a row. */
export function composeTree(pages: Record<string, NotePage>, top: NotePage, showInPlace: ShowInPlace): Composite {
  const pageId = top.id;
  const byId: Record<string, Block> = {};
  const rows = new Map<string, string>();
  const owner = new Map<string, string>();
  const sources = new Map<string, NotePage>();
  const taken = new Set<string>([pageId, ...Object.keys(top.block_tree.by_id)]);
  const inPlace = (row: Block, holder: NotePage): NotePage | undefined => {
    const link = lineLink(row);
    if (!link?.expanded || link.locked) return undefined;
    const target = pages[link.page_id];
    if (!target || target.archived || target.kind !== "document" || target.parent_id !== holder.id) return undefined;
    if (taken.has(target.id) || Object.keys(target.block_tree.by_id).some((id) => taken.has(id))) return undefined;
    return showInPlace(row, target) ? target : undefined;
  };
  // A page's own top-level blocks go under `under`: its node, or the top.
  const place = (page: NotePage, under: string | null) => {
    sources.set(page.id, page);
    for (const block of Object.values(page.block_tree.by_id)) {
      const target = inPlace(block, page);
      if (target) {
        taken.add(target.id);
        for (const id of Object.keys(target.block_tree.by_id)) taken.add(id);
        // Its name and icon are its page's, exactly as the page keeps them.
        byId[target.id] = {
          ...createBlock(target.id, "page", { parent_id: block.parent_id ?? under, order: block.order }),
          ...(target.title ? { name: target.title } : {}),
          ...(target.icon ? { icon: target.icon } : {}),
        };
        rows.set(target.id, block.id);
        owner.set(target.id, page.id);
        place(target, target.id);
        continue;
      }
      byId[block.id] = under ? liftedInto(block, under) : block;
      owner.set(block.id, page.id);
    }
  };
  place(top, null);
  return { pageId, tree: { by_id: byId }, rows, owner, sources };
}

export interface RouteOptions {
  author: string;
  now: string;
  /** A fresh block id, for the row a new block stands on. */
  newId(): string;
  /** A cut, and what it takes: these nodes, and all inside them, are on their
   *  way elsewhere — a page among them keeps its record, to be pasted — not
   *  to the trash. */
  cut?: readonly string[];
}

/** What the editor did to the composed tree, as writes to the pages holding
 *  each node. */
export function routeTransaction(
  composite: Composite,
  pages: Record<string, NotePage>,
  transaction: EditorTransaction,
  options: RouteOptions,
): WorkspaceMutation[] {
  const before = composite.tree;
  const after = applyEditorTransaction(before, transaction);
  const isNewPage = (id: string) => after.by_id[id]?.kind === "page" && !before.by_id[id];
  const isBlockPage = (id: string | null | undefined): id is string => Boolean(id && (composite.rows.has(id) || isNewPage(id)));
  const ownerAfter = (id: string): string => {
    const seen = new Set<string>();
    for (let parent = after.by_id[id]?.parent_id ?? null; parent && !seen.has(parent); parent = after.by_id[parent]?.parent_id ?? null) {
      seen.add(parent);
      if (isBlockPage(parent)) return parent;
    }
    return composite.pageId;
  };
  const stored = (block: Block, holder: string): Block => (block.parent_id === holder ? { ...block, parent_id: null } : block);
  const cutRoots = new Set(options.cut ?? []);
  const taken = (id: string): boolean => {
    const seen = new Set<string>();
    for (let at: string | null = id; at && !seen.has(at); at = before.by_id[at]?.parent_id ?? null) {
      if (cutRoots.has(at)) return true;
      seen.add(at);
    }
    return false;
  };
  const rowOf = (pageId: string): Block | undefined => {
    const rowId = composite.rows.get(pageId);
    const holder = composite.owner.get(pageId);
    return rowId && holder ? composite.sources.get(holder)?.block_tree.by_id[rowId] : undefined;
  };

  // What the transaction reaches: the nodes it names, and everything under
  // them before and after — a paragraph carried into a block takes the lines
  // under it along.
  const reached = new Set<string>();
  for (const mutation of transaction.mutations) {
    const id = mutation.action === "delete" ? mutation.blockId : mutation.block.id;
    reached.add(id);
    for (const block of descendantsOf(before, id)) reached.add(block.id);
    for (const block of descendantsOf(after, id)) reached.add(block.id);
  }

  // Blocks that leave: with everything in them (the trash, or — cut — on
  // their way elsewhere), or dissolved into the page around them. The
  // outermost is settled first: a block inside one going to the trash goes
  // with it, as it is.
  const archived = new Set<string>();
  const dissolved = new Set<string>();
  const sealed = new Set<string>();
  const leaving = [...reached]
    .filter((id) => !after.by_id[id] && composite.rows.has(id))
    .sort((left, right) => depth(before, left) - depth(before, right));
  for (const id of leaving) {
    if (sealed.has(id)) continue;
    const inside = descendantsOf(before, id).map((block) => block.id);
    // Emptied by a cut that did not take it whole, a block is done: what it
    // held is on its way elsewhere as lines — as when it is dissolved.
    if ((options.cut && !taken(id)) || inside.some((inner) => after.by_id[inner])) {
      dissolved.add(id);
    } else {
      archived.add(id);
      for (const inner of inside) sealed.add(inner);
    }
  }

  const creations: WorkspaceMutation[] = [];
  const bodies: WorkspaceMutation[] = [];
  const moves: WorkspaceMutation[] = [];
  const fields: WorkspaceMutation[] = [];
  const endings: WorkspaceMutation[] = [];
  const touched = new Set<string>();
  const made = new Map<string, NotePage>();
  const put = (holder: string, block: Block) => {
    const page = made.get(holder);
    if (page) {
      page.block_tree.by_id[block.id] = block;
      return;
    }
    bodies.push({ type: "set", path: bodyPath(holder, block.id), value: block });
    touched.add(holder);
  };
  const remove = (holder: string, blockId: string) => {
    if (dissolved.has(holder) || made.has(holder)) return;
    bodies.push({ type: "delete", path: bodyPath(holder, blockId) });
    touched.add(holder);
  };
  // New blocks first, outermost first, so each exists before anything is put
  // in it or moved under it. One whose page is already there — a cut block
  // pasted back — keeps its record and all it holds, and only moves here.
  const newPages = [...reached].filter(isNewPage).sort((left, right) => depth(after, left) - depth(after, right));
  const adopted = new Set<string>();
  for (const id of newPages) {
    if (pages[id]) {
      adopted.add(id);
      for (const block of descendantsOf(after, id)) sealed.add(block.id);
      continue;
    }
    const node = after.by_id[id];
    made.set(id, {
      id,
      title: node.name ?? "",
      icon: node.icon ?? "",
      kind: "document",
      parent_id: ownerAfter(id),
      block_tree: { by_id: {} },
      created_at: options.now,
      updated_at: options.now,
      created_by: options.author,
      updated_by: options.author,
    });
  }

  for (const id of reached) {
    const was = before.by_id[id];
    const now = after.by_id[id];
    const from = composite.owner.get(id);
    if (!now) {
      // Gone. A block that left is settled below; what was inside one that
      // went to the trash goes with it.
      if (!was || !from || composite.rows.has(id) || sealed.has(id)) continue;
      remove(from, id);
      continue;
    }
    if (sealed.has(id)) continue;
    const to = ownerAfter(id);
    if (isBlockPage(id)) {
      // A block's own node is its row in the page it is shown in, and its
      // name and icon are its page's.
      const parentId = now.parent_id === to ? null : now.parent_id;
      if (!composite.rows.has(id)) {
        put(to, pageLine(options.newId(), id, { expanded: true, parent_id: parentId, order: now.order }));
        if (adopted.has(id)) {
          moves.push({ type: "set", path: ["pages", id, "parent_id"], value: to });
          if (pages[id]?.archived) moves.push({ type: "delete", path: ["pages", id, "archived"] }, { type: "delete", path: ["pages", id, "archived_at"] });
        }
        continue;
      }
      const old = rowOf(id);
      if (!old) continue;
      const row = { ...old, parent_id: parentId, order: now.order };
      if (from !== to) {
        if (from) remove(from, row.id);
        put(to, row);
        moves.push({ type: "set", path: ["pages", id, "parent_id"], value: to });
      } else if (old.parent_id !== row.parent_id || old.order !== row.order) {
        put(to, row);
      }
      const page = pages[id];
      if (page && (now.name ?? "") !== page.title) fields.push({ type: "set", path: ["pages", id, "title"], value: now.name ?? "" });
      if (page && (now.icon ?? "") !== page.icon) fields.push({ type: "set", path: ["pages", id, "icon"], value: now.icon ?? "" });
      if (page && ((now.name ?? "") !== page.title || (now.icon ?? "") !== page.icon)) touched.add(id);
      continue;
    }
    if (from && from !== to) {
      remove(from, id);
      put(to, stored(now, to));
    } else if (!was || was !== now) {
      put(to, stored(now, to));
    }
  }

  for (const id of archived) {
    const row = rowOf(id);
    const from = composite.owner.get(id);
    if (!row || !from) continue;
    remove(from, row.id);
    if (taken(id)) continue;
    endings.push(...trashWrites(id));
  }
  for (const id of dissolved) {
    const row = rowOf(id);
    const from = composite.owner.get(id);
    if (row && from) remove(from, row.id);
    endings.push({ type: "delete", path: ["pages", id] }, { type: "delete", path: ["versions", id] });
    touched.delete(id);
  }

  for (const page of made.values()) creations.push({ type: "set", path: ["pages", page.id], value: page });
  const stamps = [...touched]
    .filter((id) => !dissolved.has(id) && !made.has(id))
    .flatMap((id): WorkspaceMutation[] => [
      { type: "set", path: ["pages", id, "updated_at"], value: options.now },
      { type: "set", path: ["pages", id, "updated_by"], value: options.author },
    ]);
  return [...creations, ...bodies, ...moves, ...fields, ...endings, ...stamps];
}

function depth(tree: BlockTree, id: string): number {
  let count = 0;
  const seen = new Set<string>();
  for (let parent = tree.by_id[id]?.parent_id ?? null; parent && !seen.has(parent); parent = tree.by_id[parent]?.parent_id ?? null) {
    seen.add(parent);
    count += 1;
  }
  return count;
}

/** A piece of the composed tree as one page would hold it: each block in it
 *  (a page of its own) as the row it stands on, what that block holds left
 *  to its own page. */
export function storedFragment(composite: Composite, fragment: BlockTree): BlockTree {
  const byId: Record<string, Block> = {};
  const insideBlock = (block: Block): boolean => {
    const seen = new Set<string>();
    for (let parent = block.parent_id; parent && !seen.has(parent); parent = fragment.by_id[parent]?.parent_id ?? null) {
      seen.add(parent);
      if (composite.rows.has(parent)) return true;
    }
    return false;
  };
  for (const block of Object.values(fragment.by_id)) {
    if (insideBlock(block)) continue;
    const rowId = composite.rows.get(block.id);
    byId[rowId ?? block.id] = rowId
      ? pageLine(rowId, block.id, { expanded: true, parent_id: block.parent_id, order: block.order })
      : block;
  }
  return { by_id: byId };
}

/** A selection copied as the editor copies it: a block shown in place as the
 *  page it is, under its name; lines in place — a link among them a link to
 *  the same page — right after the last of them. Answers what the lines
 *  write (none without lines) and every copy's id, the lines' first. */
export function duplicateSelection(
  composite: Composite,
  ids: readonly string[],
  options: {
    duplicatePage(pageId: string, options: { block?: boolean; sameTitle?: boolean }): string | null;
    newId(): string;
  },
): { transaction: EditorTransaction | null; copies: string[] } {
  const tops = topLevelBlocks(composite.tree, ids);
  const pageCopies = tops.filter((block) => composite.rows.has(block.id))
    .map((block) => options.duplicatePage(block.id, { sameTitle: true }))
    .filter((copy): copy is string => Boolean(copy));
  const lines = tops.filter((block) => !composite.rows.has(block.id)).map((block) => block.id);
  const result = lines.length ? duplicateBlocks(composite.tree, lines, options.newId) : null;
  const transaction = result?.transaction ?? null;
  return { transaction, copies: [...(result?.copies ?? []), ...pageCopies] };
}
