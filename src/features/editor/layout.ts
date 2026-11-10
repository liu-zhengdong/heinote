import { orderedBlocks } from "../../core/block-tree";
import type { Block, BlockTree } from "../../core/types";

export interface Rendered {
  /** A paragraph. (A block folded away is not drawn here at all: it is a
   *  sub-page's row in its page, for everyone.) */
  block: Block;
  depth: number;
  /** Position within the current run of numbered siblings. */
  index: number;
}

/** What the editor draws: paragraphs as rows, and blocks — pages shown in
 *  place, `page` nodes — as frames around the rows they hold. */
export type Item =
  | { kind: "row"; row: Rendered }
  | {
    kind: "page";
    page: Block;
    depth: number;
    items: Item[];
  };

/** Depth-first order of the lines (`rows`), with list numbering restarted
 *  whenever a run of numbered siblings is interrupted — and the same rows
 *  nested in the blocks that hold them (`items`), for drawing. A block is not
 *  a line of its own: its paragraphs sit at its depth and number on as if it
 *  were not there.
 *
 *  Nothing folds here. A block folded is folded for everyone: it is no longer
 *  drawn in place but stands on its row, as a sub-page does (composite.ts
 *  draws only the blocks whose rows are shown). */
export function layout(tree: BlockTree): { rows: Rendered[]; items: Item[] } {
  const rows: Rendered[] = [];
  const row = (block: Block, depth: number, index: number): Item => {
    const drawn = { block, depth, index };
    rows.push(drawn);
    return { kind: "row", row: drawn };
  };
  const visit = (parentId: string | null, depth: number, run: { value: number }): Item[] => {
    const items: Item[] = [];
    for (const block of orderedBlocks(tree, parentId)) {
      if (block.kind === "page") {
        items.push({ kind: "page", page: block, depth, items: visit(block.id, depth, run) });
        continue;
      }
      run.value = block.kind === "numbered" ? run.value + 1 : 0;
      items.push(row(block, depth, run.value));
      items.push(...visit(block.id, depth + 1, { value: 0 }));
    }
    return items;
  };
  return { rows, items: visit(null, 0, { value: 0 }) };
}
