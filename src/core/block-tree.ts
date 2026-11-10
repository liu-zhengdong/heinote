import { isContentColor } from "./colors";
import { normalizeImageWidth, normalizeStoredFile } from "./files";
import {
  inlinePlainText,
  inlineReadableText,
  MENTION_CHAR,
  normalizeInlineContent,
  normalizeMention,
  soleLink,
  type ShownLink,
  type DescribeMention,
} from "./inline-content";
import { normalizeEmbed } from "./embeds";
import { normalizeSimpleTable } from "./simple-table";
import type { Block, BlockKind, BlockTree, InlineContent, NotePage } from "./types";

export const BLOCK_ORDER_STEP = 1024;

export function createBlock(
  id: string,
  kind: BlockKind = "text",
  options: Partial<Omit<Block, "id" | "kind">> = {},
): Block {
  return {
    id,
    kind,
    parent_id: options.parent_id ?? null,
    order: Number.isFinite(options.order) ? Number(options.order) : BLOCK_ORDER_STEP,
    content: normalizeInlineContent(options.content ?? []),
    ...(options.checked === undefined ? {} : { checked: options.checked }),
    ...(options.language === undefined ? {} : { language: options.language }),
    ...(isContentColor(options.color) ? { color: options.color } : {}),
    ...(typeof options.icon === "string" && options.icon && options.icon.length <= 16 ? { icon: options.icon } : {}),
    ...(normalizeStoredFile(options.file) ? { file: normalizeStoredFile(options.file) } : {}),
    ...(normalizeImageWidth(options.width) ? { width: normalizeImageWidth(options.width) } : {}),
    ...(options.align === "center" || options.align === "right" ? { align: options.align } : {}),
    ...(kind === "page" && normalizeBlockName(options.name) ? { name: normalizeBlockName(options.name) } : {}),
    // A table's grid, read through its checks whatever wrote it.
    ...(kind === "table" ? { table: normalizeSimpleTable(options.table) } : {}),
    // A card is what its address says it is (core/embeds.ts).
    ...(kind === "embed" ? embedField(options.embed) : {}),
  };
}

function embedField(value: unknown): Pick<Block, "embed"> {
  const embed = normalizeEmbed(value);
  return embed ? { embed } : {};
}

/** The longest name a block keeps. */
const NAME_LIMIT = 120;

/** A block's name as it is kept: one line, trimmed, never empty. */
export function normalizeBlockName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.replace(/\s+/g, " ").trim().slice(0, NAME_LIMIT);
  return name || undefined;
}

/* Every parent's children, in order, from one pass over a tree. A tree is
   never changed once made — a write makes a new one — so the index is kept
   for as long as the tree is, and found in constant time. (Asking each block
   for its children by scanning the tree, and later reading the whole tree
   again on every call just to check the index, each made drawing a page
   quadratic in its length: 2,000 lines cost 430 ms a keystroke.) So build a
   tree completely before reading it. */
const childIndexes = new WeakMap<BlockTree, Map<string | null, Block[]>>();

function childIndex(tree: BlockTree): Map<string | null, Block[]> {
  const cached = childIndexes.get(tree);
  if (cached) return cached;
  const children = new Map<string | null, Block[]>();
  for (const block of Object.values(tree.by_id)) {
    const siblings = children.get(block.parent_id);
    if (siblings) siblings.push(block);
    else children.set(block.parent_id, [block]);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  }
  childIndexes.set(tree, children);
  return children;
}

export function orderedBlocks(tree: BlockTree, parentId: string | null = null): Block[] {
  return (childIndex(tree).get(parentId) ?? []).slice();
}

/** A new page, as Notion makes one: no name, no icon (the placeholder glyph
 *  is drawn by the UI, and "Add icon" offered on hover), and one empty
 *  paragraph to write in, `blockId`. */
export function newPage(
  id: string,
  kind: NotePage["kind"],
  parentId: string | null,
  stamp: { now: string; author: string },
  blockId: string,
): NotePage {
  return {
    id,
    title: "",
    icon: "",
    kind,
    parent_id: parentId,
    block_tree: { by_id: { [blockId]: createBlock(blockId) } },
    created_at: stamp.now,
    updated_at: stamp.now,
    created_by: stamp.author,
    updated_by: stamp.author,
  };
}

/** The blocks under `parentId` (null: the whole body), in reading order:
 *  each block, then what is under it. Only what the walk reaches from there
 *  is read, so a parent that loops is never reached. */
export function* blocksInOrder(tree: BlockTree, parentId: string | null = null): Generator<Block> {
  for (const block of orderedBlocks(tree, parentId)) {
    yield block;
    yield* blocksInOrder(tree, block.id);
  }
}

export function descendantsOf(tree: BlockTree, blockId: string): Block[] {
  const descendants: Block[] = [];
  const queue = [blockId];
  const seen = new Set<string>();
  while (queue.length) {
    const parentId = queue.shift();
    if (!parentId || seen.has(parentId)) continue;
    seen.add(parentId);
    for (const child of orderedBlocks(tree, parentId)) {
      descendants.push(child);
      queue.push(child.id);
    }
  }
  return descendants;
}

/** The longest first line a page goes by. */
const FIRST_LINE_LIMIT = 80;

/** The line a paragraph reads as: its first words, a file's caption or
 *  name — empty for one with none. */
function lineOf(block: Block, describe?: DescribeMention): string {
  const text = describe
    ? inlineReadableText(block.content, describe)
    : inlinePlainText(block.content).replaceAll(MENTION_CHAR, "");
  const found = text.split("\n").map((part) => part.trim()).find(Boolean)
    ?? (block.kind === "file" ? block.file?.name ?? "" : "");
  // A card reads as what it shows: a video's title, a post's words, else its address.
  const line = found || (block.kind === "embed" ? embedLine(block) : "");
  return line.length > FIRST_LINE_LIMIT ? `${line.slice(0, FIRST_LINE_LIMIT - 1).trimEnd()}…` : line;
}

function embedLine(block: Block): string {
  const embed = normalizeEmbed(block.embed);
  if (!embed) return "";
  const words = embed.provider === "youtube" ? embed.title : embed.text?.split("\n").find(Boolean);
  return words || embed.url;
}

/** The first words under `parentId` (null: the top of the tree), in reading
 *  order — empty when there are none. */
function firstLineUnder(tree: BlockTree, parentId: string | null, describe?: DescribeMention): string {
  for (const block of blocksInOrder(tree, parentId)) {
    const line = lineOf(block, describe);
    if (line) return line;
  }
  return "";
}

/** A page's first line — the first words it holds — which it goes by until
 *  it is named, as a block made from paragraphs is. Empty for one with no
 *  words. */
export function pageFirstLine(page: Pick<NotePage, "block_tree">, describe?: DescribeMention): string {
  return firstLineUnder(page.block_tree, null, describe);
}

/** What a page is called: its title, or — unnamed — its first line, or
 *  "Untitled" when it has neither. A block is a page, and is called the
 *  same way everywhere it is listed. */
export function pageName(page: Pick<NotePage, "title" | "block_tree">, describe?: DescribeMention): string {
  return page.title || pageFirstLine(page, describe) || "Untitled";
}

/** The link a line stands for a page by: a line of words holding nothing
 *  but one link to a page — a sub-page, a block, a database — drawn as the
 *  page's row, or the page itself when shown. */
export function lineLink(block: Block): ShownLink | null {
  return block.kind === "text" ? soleLink(block.content) : null;
}

/** The lines in a body that stand for `pageId`, in reading order. */
export function linesFor(tree: BlockTree | undefined, pageId: string): Block[] {
  return tree ? [...blocksInOrder(tree)].filter((block) => lineLink(block)?.page_id === pageId) : [];
}

/** The words with each link to a page in `copies` pointing at its copy. */
export function relinkContent(content: InlineContent, copies: ReadonlyMap<string, string>): InlineContent {
  return content.map((run) => (run.mention?.kind === "page" && copies.has(run.mention.page_id)
    ? { ...run, mention: { ...run.mention, page_id: copies.get(run.mention.page_id)! } }
    : run));
}

/** A line standing for a page, its link changed by `update`: shown in place,
 *  folded, read only there. */
export function withLineLink(block: Block, update: (link: ShownLink) => ShownLink): Block {
  return { ...block, content: block.content.map((run) => (run.mention?.kind === "page" ? { ...run, mention: update(run.mention) } : run)) };
}

/** A line standing for `pageId`, shown in place when `expanded`. */
export function pageLine(id: string, pageId: string, options: { parent_id?: string | null; order?: number; expanded?: boolean; locked?: boolean } = {}): Block {
  const { expanded, locked, ...place } = options;
  return createBlock(id, "text", {
    ...place,
    content: [{ text: MENTION_CHAR, mention: { kind: "page", page_id: pageId, ...(expanded ? { expanded: true } : {}), ...(locked ? { locked: true } : {}) } }],
  });
}

/** The order that puts a block last in a body. */
export function lastRootOrder(tree: BlockTree): number {
  return (orderedBlocks(tree).at(-1)?.order ?? 0) + BLOCK_ORDER_STEP;
}

/** A body nobody has written in: one empty paragraph. */
export function isBlankBody(tree: BlockTree): boolean {
  const blocks = Object.values(tree.by_id);
  return blocks.length === 1 && blocks[0].kind === "text" && !blocks[0].content.some((run) => run.text);
}

export function blockOrderBetween(
  tree: BlockTree,
  parentId: string | null,
  previousId?: string,
  nextId?: string,
): number {
  const previous = previousId ? tree.by_id[previousId] : undefined;
  const next = nextId ? tree.by_id[nextId] : undefined;
  if (previous && next && previous.parent_id === parentId && next.parent_id === parentId) {
    return previous.order + (next.order - previous.order) / 2;
  }
  if (previous && previous.parent_id === parentId) return previous.order + BLOCK_ORDER_STEP;
  if (next && next.parent_id === parentId) return next.order - BLOCK_ORDER_STEP;
  return BLOCK_ORDER_STEP;
}

/** A paragraph read from the clipboard or a checkpoint — another client
 *  wrote it — with only what Notes writes kept. */
function normalizeStoredBlock(value: unknown): Block | null {
  if (!value || typeof value !== "object") return null;
  const candidate = pictureLine(value as Record<string, unknown>);
  if (typeof candidate.id !== "string" || typeof candidate.kind !== "string") return null;
  return createBlock(candidate.id, candidate.kind as BlockKind, {
    parent_id: typeof candidate.parent_id === "string" ? candidate.parent_id : null,
    order: candidate.order as number,
    content: Array.isArray(candidate.content) ? normalizeInlineContent(candidate.content) : [],
    ...(typeof candidate.checked === "boolean" ? { checked: candidate.checked } : {}),
    ...(typeof candidate.language === "string" ? { language: candidate.language } : {}),
    ...(isContentColor(candidate.color) ? { color: candidate.color } : {}),
    ...(typeof candidate.icon === "string" ? { icon: candidate.icon } : {}),
    ...(candidate.file === undefined ? {} : { file: candidate.file as Block["file"] }),
    ...(candidate.width === undefined ? {} : { width: candidate.width as number }),
    ...(candidate.align === "center" || candidate.align === "right" ? { align: candidate.align } : {}),
    ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
    ...(candidate.table === undefined ? {} : { table: candidate.table as Block["table"] }),
    ...(candidate.embed === undefined ? {} : { embed: candidate.embed as Block["embed"] }),
  });
}

/* A picture, and a sub-page's row, were once paragraphs of their own, kinds
   "image" and "pageLink", and checkpoints kept before migrations/0.0.2.sql
   still hold them (history keeps 30 days: this goes once the last of them is
   retired, after 2026-12-01). One is read as that migration made the rest: a
   line holding its picture, as wide as it was, its caption under it; a line
   holding a link to its page, shown and read only as it was. */
function pictureLine(candidate: Record<string, unknown>): Record<string, unknown> {
  if (candidate.kind === "pageLink") {
    const { page_id, expanded, locked, ...rest } = candidate;
    const link = normalizeMention({ kind: "page", page_id, expanded, locked });
    return { ...rest, kind: "text", content: link ? [{ text: MENTION_CHAR, mention: link }] : [] };
  }
  if (candidate.kind !== "image") return candidate;
  const { file, width, content, ...rest } = candidate;
  const caption = Array.isArray(content) ? normalizeInlineContent(content) : [];
  const picture = normalizeMention({ kind: "image", file, width });
  return {
    ...rest,
    kind: "text",
    content: picture
      ? [{ text: MENTION_CHAR, mention: picture }, ...(caption.length ? [{ text: "\n" }, ...caption] : [])]
      : caption,
  };
}

export function normalizeBlockTree(value: unknown): BlockTree {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rawById = candidate.by_id && typeof candidate.by_id === "object"
    ? candidate.by_id as Record<string, unknown>
    : {};
  const byId: Record<string, Block> = {};
  for (const raw of Object.values(rawById)) {
    const block = normalizeStoredBlock(raw);
    if (block) byId[block.id] = block;
  }
  return { by_id: byId };
}

export function normalizePage(value: unknown, ensureParagraph = true): NotePage | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string") return null;
  const blockTree = normalizeBlockTree(candidate.block_tree);
  if (ensureParagraph && !Object.keys(blockTree.by_id).length) {
    const block = createBlock(`block_${candidate.id}_root`);
    blockTree.by_id[block.id] = block;
  }
  const kind = candidate.kind === "database" ? "database" : "document";
  return { ...candidate, kind, block_tree: blockTree } as unknown as NotePage;
}
