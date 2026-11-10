import {
  BLOCK_ORDER_STEP,
  blockOrderBetween,
  blocksInOrder,
  createBlock,
  descendantsOf,
  orderedBlocks,
  pageLine,
} from "../../core/block-tree";
import { concatInlineContent, inlinePlainText, sliceInlineContent, splitInlineContent } from "../../core/inline-content";
import type { Block, BlockKind, BlockMutation, BlockTree, Embed, InlineContent } from "../../core/types";

export interface EditorTransaction {
  mutations: BlockMutation[];
  focus?: { id: string; offset: number };
}

export function applyEditorTransaction(tree: BlockTree, transaction: EditorTransaction): BlockTree {
  const byId = { ...tree.by_id };
  for (const mutation of transaction.mutations) {
    if (mutation.action === "delete") delete byId[mutation.blockId];
    else byId[mutation.block.id] = structuredClone(mutation.block);
  }
  return { by_id: byId };
}

export function updateBlockContent(tree: BlockTree, blockId: string, content: InlineContent): EditorTransaction | null {
  const block = tree.by_id[blockId];
  if (!block) return null;
  return { mutations: [{ action: "put", block: { ...block, content } }] };
}

export function updateBlockFields(tree: BlockTree, blockId: string, patch: Partial<Block>): EditorTransaction | null {
  const block = tree.by_id[blockId];
  if (!block) return null;
  return { mutations: [{ action: "put", block: { ...block, ...patch, id: block.id } }] };
}

export function convertBlock(tree: BlockTree, blockId: string, kind: BlockKind): EditorTransaction | null {
  const block = tree.by_id[blockId];
  if (!block) return null;
  const converted: Block = {
    ...block,
    kind,
    ...(kind === "todo" ? { checked: block.checked ?? false } : { checked: undefined }),
  };
  return {
    mutations: [{ action: "put", block: converted }],
    focus: kind === "divider" ? undefined : { id: blockId, offset: inlinePlainText(block.content).length },
  };
}

/** ⌘Enter on lines (Winston, round 59: "for the items (markdown list "- "),
 *  I want to use cmd + enter to turn it to todo list"): bulleted lines become
 *  to-dos, left unticked; lines that are all to-dos already are ticked — or,
 *  when every one is ticked, unticked — as Notion's ⌘Enter does. Lines of
 *  any other kind are left as they are: null when nothing would change. */
export function checkLines(tree: BlockTree, blockIds: readonly string[]): EditorTransaction | null {
  const lines = blockIds.map((blockId) => tree.by_id[blockId]).filter((block): block is Block => Boolean(block));
  const bullets = lines.filter((block) => block.kind === "bullet");
  if (bullets.length) {
    return {
      mutations: bullets.map((block) => ({ action: "put" as const, block: { ...block, kind: "todo" as const, checked: false } })),
    };
  }
  const todos = lines.filter((block) => block.kind === "todo");
  if (!todos.length) return null;
  const tick = todos.some((block) => !block.checked);
  return {
    mutations: todos.map((block) => ({ action: "put" as const, block: { ...block, checked: tick } })),
  };
}

/** Whether a line holds nothing but the web link `href` — the words around
 *  it, if any, only spaces. */
export function lineIsOnlyLink(block: Block, href: string): boolean {
  const linked = block.content.filter((run) => run.marks?.link === href);
  return linked.some((run) => run.text.trim())
    && block.content.every((run) => run.marks?.link === href || !run.text.trim());
}

/** A link turned into its card (Notion's embed): a line that holds nothing
 *  but the link, and nothing under it, becomes the card; any other line
 *  keeps its words and gets the card on a line of its own after it. */
export function embedLink(tree: BlockTree, blockId: string, href: string, embed: Embed, newId: string): EditorTransaction | null {
  const block = tree.by_id[blockId];
  if (!block) return null;
  const leaf = !orderedBlocks(tree, block.id).length;
  if (leaf && lineIsOnlyLink(block, href)) {
    const { checked: _checked, language: _language, icon: _icon, color: _color, ...rest } = block;
    return { mutations: [{ action: "put", block: { ...rest, kind: "embed", content: [], embed } }] };
  }
  const siblings = orderedBlocks(tree, block.parent_id);
  const next = siblings[siblings.findIndex((item) => item.id === blockId) + 1];
  const card = createBlock(newId, "embed", {
    parent_id: block.parent_id,
    order: blockOrderBetween(tree, block.parent_id, block.id, next?.id),
    embed,
  });
  return { mutations: [{ action: "put", block: card }] };
}

/** A card back to the line it came from: its address, linked. */
export function embedToLink(tree: BlockTree, blockId: string): EditorTransaction | null {
  const block = tree.by_id[blockId];
  const address = block?.embed?.url;
  if (!block || block.kind !== "embed" || !address) return null;
  // A line has no width of its own: the card's goes with it.
  const { embed: _embed, width: _width, ...rest } = block;
  return {
    mutations: [{ action: "put", block: { ...rest, kind: "text", content: [{ text: address, marks: { link: address } }] } }],
    focus: { id: block.id, offset: address.length },
  };
}

/** A new block right after another — or, `before`, right before it (the
 *  margin's "+" Alt-clicked). */
function insertBlockBeside(tree: BlockTree, blockId: string, newId: string, kind: BlockKind, before: boolean): EditorTransaction | null {
  const block = tree.by_id[blockId];
  if (!block) return null;
  const siblings = orderedBlocks(tree, block.parent_id);
  const index = siblings.findIndex((item) => item.id === blockId);
  const [previous, next] = before ? [siblings[index - 1], block] : [block, siblings[index + 1]];
  const inserted = createBlock(newId, kind, {
    parent_id: block.parent_id,
    order: blockOrderBetween(tree, block.parent_id, previous?.id, next?.id),
  });
  return {
    mutations: [{ action: "put", block: inserted }],
    focus: { id: inserted.id, offset: 0 },
  };
}

/** A new line under `blockId`, first among what it holds: what is dropped
 *  just under a list item belongs to it. */
export function insertFirstChild(tree: BlockTree, blockId: string, newId: string, kind: BlockKind = "text"): EditorTransaction | null {
  if (!tree.by_id[blockId]) return null;
  const first = orderedBlocks(tree, blockId)[0];
  const inserted = createBlock(newId, kind, { parent_id: blockId, order: blockOrderBetween(tree, blockId, undefined, first?.id) });
  return { mutations: [{ action: "put", block: inserted }], focus: { id: inserted.id, offset: 0 } };
}

export const insertBlockAfter = (tree: BlockTree, blockId: string, newId: string, kind: BlockKind = "text") =>
  insertBlockBeside(tree, blockId, newId, kind, false);

export const insertBlockBefore = (tree: BlockTree, blockId: string, newId: string, kind: BlockKind = "text") =>
  insertBlockBeside(tree, blockId, newId, kind, true);

export function splitBlock(
  tree: BlockTree,
  blockId: string,
  offset: number,
  newId: string,
  nextKind: BlockKind = "text",
): EditorTransaction | null {
  const block = tree.by_id[blockId];
  if (!block) return null;
  const [left, right] = splitInlineContent(block.content, offset);
  const inserted = insertBlockAfter(tree, blockId, newId, nextKind);
  if (!inserted) return null;
  const nextBlock = (inserted.mutations[0] as Extract<BlockMutation, { action: "put" }>).block;
  return {
    mutations: [
      { action: "put", block: { ...block, content: left } },
      { action: "put", block: { ...nextBlock, content: right } },
    ],
    focus: { id: newId, offset: 0 },
  };
}

export function deleteBlock(tree: BlockTree, blockId: string): EditorTransaction | null {
  const block = tree.by_id[blockId];
  if (!block) return null;
  const siblings = orderedBlocks(tree, block.parent_id);
  if (siblings.length === 1 && block.parent_id === null) {
    const replacement = { ...block, kind: "text" as const, content: [], checked: undefined, language: undefined };
    return { mutations: [{ action: "put", block: replacement }], focus: { id: block.id, offset: 0 } };
  }
  const index = siblings.findIndex((item) => item.id === blockId);
  const removed = [block, ...descendantsOf(tree, blockId)];
  const gone = new Set(removed.map((item) => item.id));
  // The caret goes to a neighbour — never into a block (a `page` node holds
  // no words), but to the line read just before, or else just after.
  let focus: Block | undefined = siblings[index - 1] ?? siblings[index + 1] ?? tree.by_id[block.parent_id ?? ""];
  if (!focus || focus.kind === "page" || focus.kind === "table") focus = nearestParagraph(tree, blockId, -1, gone) ?? nearestParagraph(tree, blockId, 1, gone);
  return {
    mutations: removed.map((item) => ({ action: "delete" as const, blockId: item.id })),
    focus: focus ? { id: focus.id, offset: inlinePlainText(focus.content).length } : undefined,
  };
}

/** The nearest paragraph that takes words, reading back (-1) or on (1) from a
 *  block, skipping `skip`. */
export function nearestParagraph(tree: BlockTree, blockId: string, direction: -1 | 1, skip: ReadonlySet<string> = new Set()): Block | undefined {
  const order = documentOrder(tree);
  const from = order.findIndex((item) => item.id === blockId);
  if (from < 0) return undefined;
  for (let index = from + direction; index >= 0 && index < order.length; index += direction) {
    const candidate = order[index];
    if (!skip.has(candidate.id) && !UNWRITABLE.has(candidate.kind)) return candidate;
  }
  return undefined;
}

export function mergeBlockBackward(tree: BlockTree, blockId: string): EditorTransaction | null {
  const block = tree.by_id[blockId];
  if (!block) return null;
  const siblings = orderedBlocks(tree, block.parent_id);
  const index = siblings.findIndex((item) => item.id === blockId);
  let previous: Block | undefined = siblings[index - 1];
  // Right after a block (a `page` node), the words join its last paragraph —
  // the line they are read after.
  const seen = new Set<string>();
  while (previous?.kind === "page" && !seen.has(previous.id)) {
    seen.add(previous.id);
    previous = orderedBlocks(tree, previous.id).at(-1);
  }
  if (!previous || previous.kind === "divider" || block.kind === "divider") return deleteBlock(tree, blockId);
  const offset = inlinePlainText(previous.content).length;
  const existingChildren = orderedBlocks(tree, previous.id);
  const movedChildren = orderedBlocks(tree, block.id).map((child, childIndex) => ({
    ...child,
    parent_id: previous.id,
    order: (existingChildren.at(-1)?.order ?? 0) + (childIndex + 1) * BLOCK_ORDER_STEP,
  }));
  return {
    mutations: [
      { action: "put", block: { ...previous, content: concatInlineContent(previous.content, block.content) } },
      ...movedChildren.map((child) => ({ action: "put" as const, block: child })),
      { action: "delete", blockId },
    ],
    focus: { id: previous.id, offset },
  };
}

/** Leaves a new page's row where a slash command was typed — folded (a
 *  sub-page, a full-page database) or `shown` in place (a database drawn
 *  here): in place of the block when the command was all it held, after it
 *  otherwise, so the words either side survive.
 *
 *  A database shown here that lands LAST also gets an empty paragraph after
 *  it. It cannot take a caret, so without one there is nowhere below it to
 *  keep writing except by finding the page's bottom margin with the mouse. */
export function embedPage(
  tree: BlockTree,
  blockId: string,
  pageId: string,
  remaining: InlineContent,
  ids: { embed: string; trailing: string },
  { shown = false, database = false }: { shown?: boolean; database?: boolean } = {},
): EditorTransaction | null {
  const block = tree.by_id[blockId];
  if (!block) return null;
  const mutations: BlockMutation[] = [];
  // The page's line holds nothing but its link — shown here, as a block.
  const link = pageLine("", pageId, { expanded: shown }).content;
  let embed: Block;
  if (!inlinePlainText(remaining)) {
    embed = { ...block, kind: "text", content: link, checked: undefined, language: undefined };
    mutations.push({ action: "put", block: embed });
  } else {
    const inserted = insertBlockAfter(tree, blockId, ids.embed);
    if (!inserted) return null;
    const put = inserted.mutations[0] as Extract<BlockMutation, { action: "put" }>;
    embed = { ...put.block, content: link };
    mutations.push({ action: "put", block: { ...block, content: remaining } }, { action: "put", block: embed });
  }
  // A database shown here takes no caret: a line follows it when it would
  // otherwise end the page.
  if (shown && database) {
    const placed = applyEditorTransaction(tree, { mutations });
    if (orderedBlocks(placed, embed.parent_id).at(-1)?.id === embed.id) {
      const trailing = insertBlockAfter(placed, embed.id, ids.trailing);
      if (trailing) mutations.push(...trailing.mutations);
    }
  }
  return { mutations };
}

/** Every block in the order it is read: each block, then its children, then
 *  its next sibling. */
export function documentOrder(tree: BlockTree): Block[] {
  return [...blocksInOrder(tree)];
}

/** Replaces a selection that runs across blocks with `insert` (nothing, for
 *  Backspace and Delete): the first block keeps what came before the selection,
 *  gains whatever is typed, and takes on what came after it in the last block;
 *  every block after the first, up to and including the last, goes — the
 *  dividers and embeds between them too, as in Notion.
 *
 *  Each block is its own editing host, so the browser cannot do this: left to
 *  itself, a delete over three paragraphs only ever reaches the one the caret
 *  started in.
 *
 *  Children below the selection are never lost with their parent. A deleted
 *  block's surviving children move under the first block (or beside it, when
 *  it cannot hold children), in the order they were in. */
export function deleteAcrossBlocks(
  tree: BlockTree,
  ranges: Array<{ blockId: string; start: number; end: number }>,
  insert: InlineContent = [],
  canHaveChildren: (block: Block) => boolean = () => true,
): EditorTransaction | null {
  if (ranges.length < 2) return null;
  const order = documentOrder(tree);
  const firstRange = ranges[0];
  const lastRange = ranges[ranges.length - 1];
  const from = order.findIndex((block) => block.id === firstRange.blockId);
  const to = order.findIndex((block) => block.id === lastRange.blockId);
  if (from < 0 || to <= from) return null;
  const first = order[from];
  const last = order[to];

  // A block (a `page` node) the selection runs into or out of keeps what is
  // left of it; one it covers whole is left empty and goes with it (see
  // `withoutEmptyPages`).
  const doomed = new Set(order.slice(from + 1, to + 1).filter((block) => block.kind !== "page").map((block) => block.id));
  const merged: Block = {
    ...first,
    content: concatInlineContent(
      concatInlineContent(sliceInlineContent(first.content, 0, firstRange.start), insert),
      sliceInlineContent(last.content, lastRange.end, inlinePlainText(last.content).length),
    ),
  };

  // Survivors whose parent is going: re-home them, in reading order.
  const orphans = order.filter((block) => !doomed.has(block.id) && block.parent_id !== null && doomed.has(block.parent_id));
  const home = canHaveChildren(first) ? first.id : first.parent_id;
  const siblingsAtHome = orderedBlocks(tree, home).filter((block) => !doomed.has(block.id) && block.id !== first.id);
  // Under the first block they follow its own children; beside it they slot
  // between it and whatever sibling comes next.
  let cursor = home === first.id ? (siblingsAtHome.at(-1)?.order ?? 0) : first.order;
  const nextAtHome = home === first.id
    ? undefined
    : orderedBlocks(tree, home).find((block) => block.order > first.order && !doomed.has(block.id));
  const step = nextAtHome ? (nextAtHome.order - first.order) / (orphans.length + 1) : BLOCK_ORDER_STEP;
  const rehomed = orphans.map((block) => {
    cursor += step;
    return { ...block, parent_id: home, order: cursor };
  });

  return {
    mutations: [
      { action: "put", block: merged },
      ...rehomed.map((block) => ({ action: "put" as const, block })),
      ...[...doomed].map((blockId) => ({ action: "delete" as const, blockId })),
    ],
    focus: { id: first.id, offset: firstRange.start + inlinePlainText(insert).length },
  };
}


/* ── Blocks as a group ──────────────────────────────────────────────────
   Notion's blocks are things you pick up several at a time: select them, and
   delete, duplicate, turn into, indent, move, copy or send them elsewhere
   together. Every group command acts on the TOP-LEVEL selection — a selected
   block whose parent is also selected travels inside its parent. */

const UNWRITABLE: ReadonlySet<BlockKind> = new Set(["divider", "file", "table", "embed", "page"]);

/** The selected blocks a group command acts on, in reading order. */
export function topLevelBlocks(tree: BlockTree, blockIds: readonly string[]): Block[] {
  const selected = new Set(blockIds);
  return documentOrder(tree).filter((block) => {
    if (!selected.has(block.id)) return false;
    const seen = new Set<string>();
    let parentId = block.parent_id;
    while (parentId && !seen.has(parentId)) {
      if (selected.has(parentId)) return false;
      seen.add(parentId);
      parentId = tree.by_id[parentId]?.parent_id ?? null;
    }
    return true;
  });
}

/** `count` orders, in order, strictly between two siblings' (either may be
 *  missing: the start or the end of the run). */
export function ordersBetween(left: number | undefined, right: number | undefined, count: number): number[] {
  const slots = Array.from({ length: count }, (_, index) => index + 1);
  if (left === undefined && right === undefined) return slots.map((slot) => slot * BLOCK_ORDER_STEP);
  if (right === undefined) return slots.map((slot) => (left as number) + slot * BLOCK_ORDER_STEP);
  const start = left ?? right - (count + 1) * BLOCK_ORDER_STEP;
  const step = (right - start) / (count + 1);
  return slots.map((slot) => start + step * slot);
}

function subtreeIds(tree: BlockTree, blocks: readonly Block[]): Set<string> {
  return new Set(blocks.flatMap((block) => [block.id, ...descendantsOf(tree, block.id).map((child) => child.id)]));
}

/** Siblings that share a parent and sit next to each other — the shape
 *  indenting and nudging a group need. */
function contiguousSiblings(tree: BlockTree, blocks: readonly Block[]): Block[] | null {
  const parentId = blocks[0]?.parent_id;
  if (parentId === undefined || blocks.some((block) => block.parent_id !== parentId)) return null;
  const siblings = orderedBlocks(tree, parentId);
  const indexes = blocks.map((block) => siblings.findIndex((item) => item.id === block.id));
  return indexes.every((value, index) => index === 0 || value === indexes[index - 1] + 1) ? siblings : null;
}

function lastWritable(blocks: readonly Block[], tree: BlockTree): { id: string; offset: number } | undefined {
  const inOrder = documentOrder(tree).filter((block) => blocks.some((item) => item.id === block.id));
  const last = [...inOrder].reverse().find((block) => !UNWRITABLE.has(block.kind));
  return last ? { id: last.id, offset: inlinePlainText(last.content).length } : undefined;
}

/** Deletes the blocks and everything inside them. A page is never left with
 *  no block at all: it keeps one empty paragraph to write in. */
export function deleteBlocks(tree: BlockTree, blockIds: readonly string[], newId: string): EditorTransaction | null {
  const tops = topLevelBlocks(tree, blockIds);
  if (!tops.length) return null;
  const doomed = subtreeIds(tree, tops);
  const mutations: BlockMutation[] = [...doomed].map((blockId) => ({ action: "delete", blockId }));
  if (!Object.values(tree.by_id).some((block) => block.parent_id === null && !doomed.has(block.id))) {
    mutations.push({ action: "put", block: createBlock(newId) });
  }
  return { mutations };
}

/** Copies of the blocks and their subtrees, together, after the last of them. */
export function duplicateBlocks(
  tree: BlockTree,
  blockIds: readonly string[],
  idFactory: () => string,
): { transaction: EditorTransaction; copies: string[] } | null {
  const tops = topLevelBlocks(tree, blockIds);
  const last = tops.at(-1);
  if (!last) return null;
  const siblings = orderedBlocks(tree, last.parent_id);
  const next = siblings[siblings.findIndex((block) => block.id === last.id) + 1];
  const orders = ordersBetween(last.order, next?.order, tops.length);
  const copies: Block[] = [];
  const roots: string[] = [];
  const walk = (sourceId: string, copyId: string) => {
    for (const child of orderedBlocks(tree, sourceId)) {
      const childId = idFactory();
      copies.push({ ...structuredClone(child), id: childId, parent_id: copyId });
      walk(child.id, childId);
    }
  };
  tops.forEach((top, index) => {
    const copyId = idFactory();
    roots.push(copyId);
    copies.push({ ...structuredClone(top), id: copyId, parent_id: last.parent_id, order: orders[index] });
    walk(top.id, copyId);
  });
  return {
    transaction: {
      mutations: copies.map((block) => ({ action: "put" as const, block })),
    },
    copies: roots,
  };
}

/** Moves the blocks, in order, above or below a target or into its children
 *  (last). Refuses a target inside what is being moved. */
export function moveBlocks(
  tree: BlockTree,
  blockIds: readonly string[],
  target: { id: string; edge: "above" | "below" | "inside" },
): EditorTransaction | null {
  const tops = topLevelBlocks(tree, blockIds);
  const anchor = tree.by_id[target.id];
  if (!tops.length || !anchor) return null;
  const moving = subtreeIds(tree, tops);
  if (moving.has(anchor.id)) return null;
  let parentId: string | null;
  let left: number | undefined;
  let right: number | undefined;
  if (target.edge === "inside") {
    parentId = anchor.id;
    left = orderedBlocks(tree, anchor.id).filter((block) => !moving.has(block.id)).at(-1)?.order;
  } else {
    parentId = anchor.parent_id;
    const siblings = orderedBlocks(tree, parentId).filter((block) => !moving.has(block.id));
    const index = siblings.findIndex((block) => block.id === anchor.id);
    if (target.edge === "above") {
      left = siblings[index - 1]?.order;
      right = anchor.order;
    } else {
      left = anchor.order;
      right = siblings[index + 1]?.order;
    }
  }
  const orders = ordersBetween(left, right, tops.length);
  return {
    mutations: tops.map((block, index) => ({ action: "put" as const, block: { ...block, parent_id: parentId, order: orders[index] } })),
  };
}

/** ⌘⇧↑ / ⌘⇧↓ on a group: past the sibling above or below, all together. */
export function shiftBlocks(tree: BlockTree, blockIds: readonly string[], direction: -1 | 1): EditorTransaction | null {
  const tops = topLevelBlocks(tree, blockIds);
  const siblings = contiguousSiblings(tree, tops);
  if (!siblings) return null;
  const first = siblings.findIndex((block) => block.id === tops[0].id);
  const neighbour = siblings[direction === -1 ? first - 1 : first + tops.length];
  if (!neighbour) return null;
  const moved = moveBlocks(tree, tops.map((block) => block.id), { id: neighbour.id, edge: direction === -1 ? "above" : "below" });
  return moved ? { ...moved } : null;
}

/** Tab on a group: the sibling above takes them all in, after its own children. */
export function indentBlocks(tree: BlockTree, blockIds: readonly string[]): EditorTransaction | null {
  const tops = topLevelBlocks(tree, blockIds);
  const siblings = contiguousSiblings(tree, tops);
  if (!siblings) return null;
  const previous = siblings[siblings.findIndex((block) => block.id === tops[0].id) - 1];
  if (!previous || previous.kind === "page") return null;
  const orders = ordersBetween(orderedBlocks(tree, previous.id).at(-1)?.order, undefined, tops.length);
  return {
    mutations: tops.map((block, index) => ({ action: "put" as const, block: { ...block, parent_id: previous.id, order: orders[index] } })),
  };
}

/** Shift+Tab on a group: out beside their parent, and — as for one block —
 *  the siblings that followed them become the last one's children, so the
 *  page reads in the same order. */
export function outdentBlocks(tree: BlockTree, blockIds: readonly string[]): EditorTransaction | null {
  const tops = topLevelBlocks(tree, blockIds);
  const siblings = contiguousSiblings(tree, tops);
  const parent = tops[0]?.parent_id ? tree.by_id[tops[0].parent_id] : undefined;
  if (!siblings || !parent || parent.kind === "page") return null;
  const outer = orderedBlocks(tree, parent.parent_id);
  const after = outer[outer.findIndex((block) => block.id === parent.id) + 1];
  const orders = ordersBetween(parent.order, after?.order, tops.length);
  const last = tops[tops.length - 1];
  const trailing = siblings.slice(siblings.findIndex((block) => block.id === last.id) + 1);
  const adopted = ordersBetween(orderedBlocks(tree, last.id).at(-1)?.order, undefined, trailing.length);
  return {
    mutations: [
      ...tops.map((block, index) => ({ action: "put" as const, block: { ...block, parent_id: parent.parent_id, order: orders[index] } })),
      ...trailing.map((block, index) => ({ action: "put" as const, block: { ...block, parent_id: last.id, order: adopted[index] } })),
    ],
  };
}

/** Turn into, for every selected block that is text in some form — never a
 *  page's row, nor a folded block, which is a whole block and not a line. */
export function convertBlocks(tree: BlockTree, blockIds: readonly string[], kind: BlockKind): EditorTransaction | null {
  const mutations = blockIds
    .map((blockId) => tree.by_id[blockId])
    // A table is its grid, and a card its link, not words in a costume:
    // turned into a line either would lose what it is.
    .filter((block): block is Block => Boolean(block) && block.kind !== "page" && block.kind !== "table" && block.kind !== "embed")
    .flatMap((block) => convertBlock(tree, block.id, kind)?.mutations ?? []);
  return mutations.length ? { mutations } : null;
}

/** Colour, for every selected block but a divider or a folded block: a text
 *  colour, a background, or none. */
export function colorBlocks(tree: BlockTree, blockIds: readonly string[], color: Block["color"]): EditorTransaction | null {
  const mutations = blockIds
    .map((blockId) => tree.by_id[blockId])
    .filter((block): block is Block => Boolean(block) && block.kind !== "divider" && block.kind !== "page")
    .map((block) => ({ action: "put" as const, block: { ...block, color } }));
  return mutations.length ? { mutations } : null;
}

/* ── Fragments: blocks lifted out of a page ─────────────────────────────── */

/** The blocks, with everything inside them, as a body of their own: the
 *  top-level ones become its roots, in order. Ids are kept — a fragment
 *  that is moved is the same blocks somewhere else. */
export function extractFragment(tree: BlockTree, blockIds: readonly string[]): BlockTree {
  const byId: Record<string, Block> = {};
  topLevelBlocks(tree, blockIds).forEach((top, index) => {
    byId[top.id] = { ...structuredClone(top), parent_id: null, order: (index + 1) * BLOCK_ORDER_STEP };
    for (const child of descendantsOf(tree, top.id)) byId[child.id] = structuredClone(child);
  });
  return { by_id: byId };
}

/** The part of the page a text selection covers, as blocks: the first and
 *  last cut to the selection, everything between them whole — dividers and
 *  embeds included, since a selection deletes those too. */
export function selectionFragment(
  tree: BlockTree,
  ranges: Array<{ blockId: string; start: number; end: number }>,
): BlockTree {
  const order = documentOrder(tree);
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  const from = order.findIndex((block) => block.id === first?.blockId);
  const to = order.findIndex((block) => block.id === last?.blockId);
  if (from < 0 || to < from) return { by_id: {} };
  // Words copied are paragraphs: the blocks they sit in stay where they are,
  // and what they held lands as plain paragraphs.
  const covered = order.slice(from, to + 1).filter((block) => block.kind !== "page");
  const inside = new Set(covered.map((block) => block.id));
  const byId: Record<string, Block> = {};
  let rootIndex = 0;
  for (const block of covered) {
    const range = ranges.find((item) => item.blockId === block.id);
    const content = range && (block.id === first.blockId || block.id === last.blockId)
      ? sliceInlineContent(block.content, range.start, range.end)
      : structuredClone(block.content);
    const nested = block.parent_id !== null && inside.has(block.parent_id);
    if (!nested) rootIndex += 1;
    byId[block.id] = {
      ...structuredClone(block),
      content,
      parent_id: nested ? block.parent_id : null,
      order: nested ? block.order : rootIndex * BLOCK_ORDER_STEP,
    };
  }
  return { by_id: byId };
}

/** The same fragment under fresh ids, so it can be pasted any number of times
 *  — but for the blocks `keep` holds on to: a cut block, pasted, is that same
 *  block (a page) moving. */
export function reidentify(fragment: BlockTree, idFactory: () => string, keep: (block: Block) => boolean = () => false): BlockTree {
  const ids = new Map(Object.values(fragment.by_id).map((block) => [block.id, keep(block) ? block.id : idFactory()]));
  const byId: Record<string, Block> = {};
  for (const block of Object.values(fragment.by_id)) {
    const id = ids.get(block.id) as string;
    byId[id] = { ...structuredClone(block), id, parent_id: block.parent_id ? ids.get(block.parent_id) ?? null : null };
  }
  return { by_id: byId };
}

/** A fragment's blocks, its roots re-ordered to sit between two neighbours
 *  under `parentId`. */
function placeFragment(fragment: BlockTree, parentId: string | null, left: number | undefined, right: number | undefined): Block[] {
  const roots = orderedBlocks(fragment);
  const orders = ordersBetween(left, right, roots.length);
  const placed = new Map(roots.map((root, index) => [root.id, { ...root, parent_id: parentId, order: orders[index] }]));
  return Object.values(fragment.by_id).map((block) => placed.get(block.id) ?? block);
}

/** Puts a fragment's blocks after a block, as its next siblings. */
export function insertFragmentAfter(tree: BlockTree, blockId: string, fragment: BlockTree): EditorTransaction | null {
  const anchor = tree.by_id[blockId];
  if (!anchor || !Object.keys(fragment.by_id).length) return null;
  const siblings = orderedBlocks(tree, anchor.parent_id);
  const next = siblings[siblings.findIndex((block) => block.id === anchor.id) + 1];
  const placed = placeFragment(fragment, anchor.parent_id, anchor.order, next?.order);
  const after = applyEditorTransaction(tree, { mutations: placed.map((block) => ({ action: "put" as const, block })) });
  return {
    mutations: placed.map((block) => ({ action: "put" as const, block })),
    focus: lastWritable(placed, after),
  };
}

/** Puts a fragment at the end of a body — where "Move to" sends blocks. A
 *  body nobody has written in yet gives up its empty paragraph to them. */
export function appendFragment(tree: BlockTree, fragment: BlockTree): BlockMutation[] {
  const roots = orderedBlocks(tree);
  const blank = roots.length === 1 && roots[0].kind === "text" && !inlinePlainText(roots[0].content)
    && !orderedBlocks(tree, roots[0].id).length;
  const placed = placeFragment(fragment, null, blank ? undefined : roots.at(-1)?.order, undefined);
  return [
    ...(blank ? [{ action: "delete" as const, blockId: roots[0].id }] : []),
    ...placed.map((block) => ({ action: "put" as const, block })),
  ];
}

export function pasteFragment(
  tree: BlockTree,
  blockId: string,
  range: { start: number; end: number },
  fragment: BlockTree,
  idFactory: () => string,
): EditorTransaction | null {
  const block = tree.by_id[blockId];
  const roots = orderedBlocks(fragment);
  if (!block || !roots.length) return null;
  const length = inlinePlainText(block.content).length;
  const head = sliceInlineContent(block.content, 0, range.start);
  const tail = sliceInlineContent(block.content, range.end, length);
  const hasText = (content: InlineContent) => inlinePlainText(content).length > 0;
  const plain = (item: Block) => item.kind === "text" && !orderedBlocks(fragment, item.id).length;
  const put = (item: Block) => ({ action: "put" as const, block: item });
  const finish = (mutations: BlockMutation[], focus: EditorTransaction["focus"]): EditorTransaction => (
    { mutations, focus }
  );

  if (roots.length === 1 && plain(roots[0])) {
    const words = roots[0].content;
    return finish(
      [put({ ...block, content: concatInlineContent(concatInlineContent(head, words), tail) })],
      { id: block.id, offset: range.start + inlinePlainText(words).length },
    );
  }

  const siblings = orderedBlocks(tree, block.parent_id);
  const index = siblings.findIndex((item) => item.id === block.id);
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  const childless = !orderedBlocks(tree, block.id).length;

  if (!hasText(head) && !hasText(tail) && childless && !UNWRITABLE.has(block.kind)) {
    const placed = placeFragment(fragment, block.parent_id, previous?.order, next?.order);
    const after = applyEditorTransaction(tree, { mutations: [{ action: "delete", blockId: block.id }, ...placed.map(put)] });
    return finish([{ action: "delete", blockId: block.id }, ...placed.map(put)], lastWritable(placed, after));
  }

  if (!hasText(head)) {
    const placed = placeFragment(fragment, block.parent_id, previous?.order, block.order);
    const mutations = [put({ ...block, content: tail }), ...placed.map(put)];
    return finish(mutations, lastWritable(placed, applyEditorTransaction(tree, { mutations })));
  }

  if (plain(roots[0])) {
    const [first, ...rest] = roots;
    const restFragment: BlockTree = { by_id: { ...fragment.by_id } };
    delete restFragment.by_id[first.id];
    const placed = placeFragment(restFragment, block.parent_id, block.order, next?.order);
    const lastRoot = placed.find((item) => item.id === rest.at(-1)?.id);
    const mutations: BlockMutation[] = [put({ ...block, content: concatInlineContent(head, first.content) })];
    let focus: EditorTransaction["focus"];
    if (lastRoot && hasText(tail) && lastRoot.kind === "text" && !orderedBlocks(restFragment, lastRoot.id).length) {
      const joined = placed.map((item) => item.id === lastRoot.id ? { ...item, content: concatInlineContent(item.content, tail) } : item);
      mutations.push(...joined.map(put));
      focus = { id: lastRoot.id, offset: inlinePlainText(lastRoot.content).length };
    } else {
      mutations.push(...placed.map(put));
      if (hasText(tail)) {
        const orders = ordersBetween(lastRoot?.order ?? block.order, next?.order, 1);
        mutations.push(put(createBlock(idFactory(), block.kind, {
          parent_id: block.parent_id,
          order: orders[0],
          content: tail,
          ...(block.checked === undefined ? {} : { checked: block.checked }),
        })));
      }
      focus = lastWritable(placed, applyEditorTransaction(tree, { mutations }));
    }
    return finish(mutations, focus);
  }

  // One more slot than there are blocks when the words after the caret need a
  // line of their own.
  const slots = ordersBetween(block.order, next?.order, roots.length + (hasText(tail) ? 1 : 0));
  const reordered = Object.values(fragment.by_id).map((item) => {
    const rootIndex = roots.findIndex((root) => root.id === item.id);
    return rootIndex >= 0 ? { ...item, parent_id: block.parent_id, order: slots[rootIndex] } : item;
  });
  const mutations: BlockMutation[] = [put({ ...block, content: head }), ...reordered.map(put)];
  if (hasText(tail)) {
    mutations.push(put(createBlock(idFactory(), block.kind, {
      parent_id: block.parent_id,
      order: slots[roots.length],
      content: tail,
      ...(block.checked === undefined ? {} : { checked: block.checked }),
    })));
  }
  return finish(mutations, lastWritable(reordered, applyEditorTransaction(tree, { mutations })));
}

/* ── Blocks: paragraphs grouped by hand ─────────────────────────────────
   A block (a `page` node) holds a run of whole paragraphs that sit side by
   side under one parent. Being a node of the tree, it can hold blocks but
   never half of one, and two blocks never overlap. */

/** The ids from the top of the tree down to a block, the block last. */
function ancestry(tree: BlockTree, blockId: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  for (let id: string | null = blockId; id && tree.by_id[id] && !seen.has(id); id = tree.by_id[id]?.parent_id ?? null) {
    seen.add(id);
    chain.unshift(id);
  }
  return chain;
}

/** The run of siblings a new block takes: the smallest one under a single
 *  parent that holds every one of `blockIds` whole. */
export function pageSpan(tree: BlockTree, blockIds: readonly string[]): { parentId: string | null; blocks: Block[] } | null {
  const chains = blockIds.map((blockId) => ancestry(tree, blockId)).filter((chain) => chain.length);
  if (!chains.length) return null;
  const shortest = Math.min(...chains.map((chain) => chain.length));
  let shared = 0;
  while (shared < shortest && chains.every((chain) => chain[shared] === chains[0][shared])) shared += 1;
  if (shared === shortest) {
    // One of them holds all the others (or they are all one): it is the run.
    const block = tree.by_id[chains[0][shared - 1]];
    return block ? { parentId: block.parent_id, blocks: [block] } : null;
  }
  const parentId = shared ? chains[0][shared - 1] : null;
  const heads = new Set(chains.map((chain) => chain[shared]));
  const siblings = orderedBlocks(tree, parentId);
  const indexes = siblings.flatMap((block, index) => (heads.has(block.id) ? [index] : []));
  if (!indexes.length) return null;
  return { parentId, blocks: siblings.slice(Math.min(...indexes), Math.max(...indexes) + 1) };
}

/** Makes the paragraphs `blockIds` touch a block — a new page, drawn in
 *  place — widened to whole paragraphs at the level they share. When they
 *  are exactly a block already, that block is the answer and nothing
 *  changes. */
export function pageFromBlocks(
  tree: BlockTree,
  blockIds: readonly string[],
  newId: string,
): { pageId: string; transaction: EditorTransaction | null } | null {
  const span = pageSpan(tree, blockIds);
  if (!span?.blocks.length) return null;
  const parent = span.parentId ? tree.by_id[span.parentId] : undefined;
  if (parent?.kind === "page" && orderedBlocks(tree, parent.id).length === span.blocks.length) {
    return { pageId: parent.id, transaction: null };
  }
  if (span.blocks.length === 1 && span.blocks[0].kind === "page") return { pageId: span.blocks[0].id, transaction: null };
  const node = createBlock(newId, "page", { parent_id: span.parentId, order: span.blocks[0].order });
  return {
    pageId: newId,
    transaction: {
      mutations: [
        { action: "put", block: node },
        ...span.blocks.map((block) => ({ action: "put" as const, block: { ...block, parent_id: newId } })),
      ],
    },
  };
}

/** Undoes a block: its paragraphs stay exactly where they are, loose, and
 *  its page is gone. */
export function unwrapPage(tree: BlockTree, pageId: string): EditorTransaction | null {
  const node = tree.by_id[pageId];
  if (node?.kind !== "page") return null;
  const siblings = orderedBlocks(tree, node.parent_id);
  const index = siblings.findIndex((block) => block.id === pageId);
  const children = orderedBlocks(tree, pageId);
  const orders = ordersBetween(siblings[index - 1]?.order, siblings[index + 1]?.order, children.length);
  return {
    mutations: [
      ...children.map((child, childIndex) => ({
        action: "put" as const,
        block: { ...child, parent_id: node.parent_id, order: orders[childIndex] },
      })),
      { action: "delete", blockId: pageId },
    ],
  };
}

/** Enter on an empty last line of a block: the line steps out, to just after
 *  the block — the way Enter on an empty item leaves a list. */
export function leavePage(tree: BlockTree, blockId: string): EditorTransaction | null {
  const block = tree.by_id[blockId];
  const holder = block?.parent_id ? tree.by_id[block.parent_id] : undefined;
  if (!block || holder?.kind !== "page") return null;
  return {
    mutations: [{
      action: "put",
      block: { ...block, parent_id: holder.parent_id, order: blockOrderBetween(tree, holder.parent_id, holder.id, nextSiblingOf(tree, holder)?.id) },
    }],
    focus: { id: block.id, offset: 0 },
  };
}

function nextSiblingOf(tree: BlockTree, block: Block): Block | undefined {
  const siblings = orderedBlocks(tree, block.parent_id);
  return siblings[siblings.findIndex((item) => item.id === block.id) + 1];
}

/** Whether a paragraph is the last of the block that holds it. */
export function isLastInPage(tree: BlockTree, blockId: string): boolean {
  const block = tree.by_id[blockId];
  const holder = block?.parent_id ? tree.by_id[block.parent_id] : undefined;
  return holder?.kind === "page" && orderedBlocks(tree, holder.id).at(-1)?.id === blockId;
}

/** A transaction with the blocks it leaves holding nothing taken out too — a
 *  block is at least one paragraph — and, should that empty the page, an
 *  empty paragraph to write in. Transactions that move nothing between
 *  parents are passed through as they are. */
export function withoutEmptyPages(tree: BlockTree, transaction: EditorTransaction, newId: () => string): EditorTransaction {
  const moves = transaction.mutations.some((mutation) => (
    mutation.action === "delete" || tree.by_id[mutation.block.id]?.parent_id !== mutation.block.parent_id
  ));
  if (!moves) return transaction;
  let after = applyEditorTransaction(tree, transaction);
  const extra: BlockMutation[] = [];
  for (let pass = 0; pass < 64; pass += 1) {
    const empty = Object.values(after.by_id).filter((block) => block.kind === "page" && !orderedBlocks(after, block.id).length);
    if (!empty.length) break;
    const deletes = empty.map((block) => ({ action: "delete" as const, blockId: block.id }));
    extra.push(...deletes);
    after = applyEditorTransaction(after, { mutations: deletes });
  }
  if (!extra.length) return transaction;
  if (!orderedBlocks(after).length) extra.push({ action: "put", block: createBlock(newId()) });
  return { ...transaction, mutations: [...transaction.mutations, ...extra] };
}
