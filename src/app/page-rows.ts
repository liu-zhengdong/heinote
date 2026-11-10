import { isBlankBody, lastRootOrder } from "../core/block-tree";
import type { Block, NotePage } from "../core/types";
import type { WorkspaceMutation } from "../platform/workspace-document";

/* A page lives in its parent, as a file in a folder (`parent_id`); a page's
   words only link to pages. A page made from inside another gets a line
   linking to it there, which it never depends on: moving, trashing and
   restoring a page leave every link where it is. Only a document has a
   body; a database's rows are the pages it holds. */

/** Where a block of a page's body is written. */
export function bodyPath(pageId: string, blockId: string): string[] {
  return ["pages", pageId, "block_tree", "by_id", blockId];
}

/** A body nobody has written in gives up its one empty line to what comes. */
function replacingBlank(parent: NotePage): { mutations: WorkspaceMutation[]; order?: number } {
  if (!isBlankBody(parent.block_tree)) return { mutations: [] };
  const blank = Object.values(parent.block_tree.by_id)[0];
  return { mutations: [{ type: "delete", path: bodyPath(parent.id, blank.id) }], order: blank.order };
}

/** Puts a line last in a parent's body — in place of the empty line of a
 *  body nobody has written in. */
export function linkIntoParent(parent: NotePage | null | undefined, row: Block): WorkspaceMutation[] {
  if (parent?.kind !== "document") return [];
  const blank = replacingBlank(parent);
  const order = blank.order ?? lastRootOrder(parent.block_tree);
  return [...blank.mutations, { type: "set", path: bodyPath(parent.id, row.id), value: { ...row, parent_id: null, order } }];
}

/** A page to the trash: the links to it stay, and read as in the trash. */
export function trashWrites(pageId: string): WorkspaceMutation[] {
  return [
    { type: "set", path: ["pages", pageId, "archived"], value: true },
    { type: "set", path: ["pages", pageId, "archived_at"], value: new Date().toISOString() },
  ];
}
