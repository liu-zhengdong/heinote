/* Lists and tables become databases, and a database whose pages are empty
   becomes a table or a list again (Winston, round 57: "I want a way to turn
   list and tables to database, and vice versa").

   Every way it can go wrong, written down before the code:
   1. Nothing is lost silently. A list turns into a database only when its
      lines hold no page (a block or a sub-page under a line would lose its
      place); a table always can. A database turns back only when its pages
      are empty — no words, no page under them, no picture (in an Image
      property or as a cover) — and into a list only when no property but
      one Status holds a value (a list has nowhere to keep one). Otherwise the
      option says why and changes nothing.
   2. A list keeps what it held: each top line is a page, named by the line's
      words (links kept — a name holds words and links — a mention as the
      words it reads as), and the lines under it are that page's body.
   3. To-dos keep whether they are done: a Status, Done for a checked one and
      Not started for the rest; turned back, the rows in its Complete group
      are checked.
   4. A table keeps every cell: its first column the names, every other
      column a Text property named by the header row (or "Column N" without
      one), each cell's words the row's value in it, the widths the view's.
   5. Turned back, a database keeps its rows in the order its view shows them
      — sorts kept, a filter or a search ignored (a filtered row is still a
      row) — and every value as the view shows it; a row's icon stands before
      its name.
   6. It stands where the list or table stood — drawn in place in the page
      that held them. Turned back, the table or list stands where the database
      was drawn (its name, if it had one, a heading above it), or — a
      database that is a page of its own — becomes that page's body.
   7. One step of undo each way, and every other member sees one change.
   8. Someone who may only read the page changes nothing. */

import { BLOCK_ORDER_STEP, linesFor, lineLink, createBlock, descendantsOf, newPage, orderedBlocks } from "../../core/block-tree";
import { inlineFromText, inlinePlainText, inlineReadable, type DescribeMention } from "../../core/inline-content";
import { tableCells, tableFromCells, tableGrid } from "../../core/simple-table";
import { pageTitleContent, titleFields } from "../../core/title";
import type { Block, BlockKind, BlockTree, DatabaseConfig, DatabaseProperty, DatabaseView, InlineContent, NotePage } from "../../core/types";
import type { WorkspaceMutation } from "../../platform/workspace-document";
import {
  columnWidth,
  createDatabaseProperty,
  databaseRows,
  newDatabaseConfig,
  propertyName,
  propertyValue,
  rowImages,
  statusOf,
  TITLE_COLUMN,
  titleName,
  viewRows,
} from "./database-model";
import { formatDay } from "./properties";

export interface ConversionIds {
  page(kind: "database" | "page"): string;
  block(): string;
  property(): string;
  view(): string;
  column(): string;
  row(): string;
}

export interface Stamp {
  now: string;
  author: string;
}

const LIST_KINDS: ReadonlySet<BlockKind> = new Set(["bullet", "numbered", "todo"]);

/** Whether blocks are a list: every one a bulleted, numbered or to-do line. */
export function isList(blocks: readonly Block[]): boolean {
  return blocks.length > 0 && blocks.every((block) => LIST_KINDS.has(block.kind));
}

/** Why a list cannot become a database, or null when it can (1). */
export function listRefusal(tree: BlockTree, tops: readonly Block[]): string | null {
  const holds = tops.flatMap((top) => descendantsOf(tree, top.id));
  if (holds.some((block) => block.kind === "page")) {
    return "Lines holding pages can't become a database: those pages would lose their place.";
  }
  return null;
}

function blankBody(ids: ConversionIds): BlockTree {
  const id = ids.block();
  return { by_id: { [id]: createBlock(id) } };
}

function convertedPage(id: string, kind: NotePage["kind"], parentId: string, stamp: Stamp, fields: Partial<NotePage>, ids: ConversionIds): NotePage {
  return { ...newPage(id, kind, parentId, stamp, ids.block()), ...fields };
}

function tableConfig(ids: ConversionIds): DatabaseConfig {
  return newDatabaseConfig("table", ids.view(), () => ids.property());
}

/** The database a list makes (2, 3): the database page, then its rows. */
export function databaseFromList(
  tree: BlockTree,
  tops: readonly Block[],
  holder: string,
  ids: ConversionIds,
  stamp: Stamp,
  describe: DescribeMention,
): NotePage[] {
  const config = tableConfig(ids);
  const todo = tops.some((top) => top.kind === "todo");
  const status: DatabaseProperty | undefined = todo ? createDatabaseProperty(ids.property(), "status", []) : undefined;
  if (status) config.properties = [status];
  const database = convertedPage(ids.page("database"), "database", holder, stamp, { database: config }, ids);
  const base = Date.parse(stamp.now) || Date.now();
  const rows = tops.map((top, index) => {
    const held = descendantsOf(tree, top.id);
    const body: BlockTree = held.length
      ? { by_id: Object.fromEntries(held.map((block) => [block.id, { ...structuredClone(block), parent_id: block.parent_id === top.id ? null : block.parent_id }])) }
      : blankBody(ids);
    return convertedPage(ids.page("page"), "document", database.id, stamp, {
      ...titleFields(inlineReadable(top.content, describe)),
      block_tree: body,
      row_order: base + index,
      ...(status && top.kind === "todo" ? { properties: { [status.id]: top.checked ? "Done" : "Not started" } } : {}),
    }, ids);
  });
  return [database, ...rows];
}

/** The database a table makes (4): the database page, then its rows. */
export function databaseFromTable(block: Block, holder: string, ids: ConversionIds, stamp: Stamp): NotePage[] {
  const grid = tableGrid(block.table);
  const cells = tableCells(grid);
  const head = grid.header_row ? cells[0] : undefined;
  const body = grid.header_row ? cells.slice(1) : cells;
  const config = tableConfig(ids);
  const taken = new Set<string>();
  const nameOf = (index: number) => {
    const written = head ? inlinePlainText(head[index] ?? []).replace(/\s+/g, " ").trim() : "";
    let name = written || `Column ${index + 1}`;
    for (let count = 2; taken.has(name.toLowerCase()); count += 1) name = `${written || `Column ${index + 1}`} ${count}`;
    taken.add(name.toLowerCase());
    return name;
  };
  const firstName = nameOf(0);
  const properties: DatabaseProperty[] = grid.columns.slice(1).map((_, index) => ({ id: ids.property(), name: nameOf(index + 1), type: "text" }));
  const view: DatabaseView = { ...config.views[0] };
  const widths: Record<string, number> = {};
  grid.columns.forEach((column, index) => {
    if (column.width === undefined) return;
    widths[index === 0 ? TITLE_COLUMN : properties[index - 1].id] = column.width;
  });
  if (Object.keys(widths).length) view.widths = widths;
  const database = convertedPage(ids.page("database"), "database", holder, stamp, {
    database: { ...config, properties, views: [view], ...(head && firstName !== "Column 1" ? { title_name: firstName } : {}) },
  }, ids);
  const base = Date.parse(stamp.now) || Date.now();
  const rows = body.map((row, index) => convertedPage(ids.page("page"), "document", database.id, stamp, {
    ...titleFields(row[0] ?? []),
    row_order: base + index,
    properties: Object.fromEntries(properties
      .map((property, at) => [property.id, inlinePlainText(row[at + 1] ?? []).trim()] as const)
      .filter(([, value]) => value)),
  }, ids));
  return [database, ...rows];
}

/* ── A database turned back ─────────────────────────────────────────────── */

/** A body with nothing in it: every line an empty line of words. */
function emptyBody(tree: BlockTree): boolean {
  return Object.values(tree.by_id).every((block) => block.kind === "text" && !inlinePlainText(block.content));
}

export interface Convertible {
  /** Null when it can become a table; else why not. */
  table: string | null;
  list: string | null;
}

/** Whether a database can turn back into a table, a list, or neither — and
 *  why not (1). */
export function databaseConvertible(pages: Record<string, NotePage>, databaseId: string): Convertible {
  const database = pages[databaseId];
  const config = database?.database;
  if (!database || !config) return { table: "This is not a database.", list: "This is not a database." };
  const rows = databaseRows(pages, databaseId);
  const children = new Set(Object.values(pages).map((page) => page.parent_id));
  const full = rows.filter((row) => !emptyBody(row.block_tree) || children.has(row.id));
  const pictured = rows.some((row) => row.cover_image || row.cover
    || config.properties.some((property) => property.type === "image" && rowImages(row, property.id).length));
  const table = full.length
    ? `${full.length === 1 ? "A page" : `${full.length} pages`} in it ${full.length === 1 ? "has" : "have"} content — only a database of empty pages can turn back.`
    : pictured ? "Its pictures have nowhere to go in a table or a list." : null;
  if (table) return { table, list: table };
  const statuses = config.properties.filter((property) => property.type === "status");
  const valued = config.properties.filter((property) => property.type !== "image" && !(property.type === "status" && statuses.length === 1)
    && rows.some((row) => (row.properties?.[property.id] ?? "").trim()));
  return {
    table: null,
    list: valued.length ? `Its properties hold values a list has nowhere to keep — a table keeps them.` : null,
  };
}

/** A property's value as its view shows it (5). */
function shownValue(row: NotePage, property: DatabaseProperty): string {
  const value = propertyValue(row, property);
  return property.type === "date" ? (value ? formatDay(value) : "") : value;
}

/** A row's name as a cell or a line holds it: its words and links, its icon
 *  before them (5). */
function rowName(row: NotePage): InlineContent {
  const name = pageTitleContent(row);
  return row.icon ? [{ text: `${row.icon} ` }, ...name] : name;
}

/** The blocks a database turns back into (4, 5): a table — the names, then
 *  each property, a header row naming them — or a list of the names, to-dos
 *  when a Status says which are done. */
function blocksFromDatabase(
  pages: Record<string, NotePage>,
  database: NotePage,
  as: "table" | "list",
  view: DatabaseView | undefined,
  ids: ConversionIds,
): Block[] {
  const config = database.database as DatabaseConfig;
  const shown = view ?? config.views[0];
  const all = databaseRows(pages, database.id);
  const rows = shown ? viewRows(all, { ...shown, filter: undefined }, config.properties, "") : [...all];
  const properties = config.properties.filter((property) => property.type !== "image");
  if (as === "table") {
    const header: InlineContent[] = [inlineFromText(titleName(config)), ...properties.map((property) => inlineFromText(propertyName(property)))];
    const cells = rows.map((row) => [rowName(row), ...properties.map((property) => inlineFromText(shownValue(row, property)))]);
    const widths = shown ? [columnWidth(shown, TITLE_COLUMN), ...properties.map((property) => columnWidth(shown, property.id))] : [];
    return [createBlock(ids.block(), "table", {
      table: tableFromCells([header, ...cells], (kind) => (kind === "column" ? ids.column() : ids.row()), { headerRow: true, widths }),
    })];
  }
  const status = properties.find((property) => property.type === "status");
  return rows.map((row) => createBlock(ids.block(), status ? "todo" : "bullet", {
    content: rowName(row),
    ...(status ? { checked: statusOf(status, row.properties?.[status.id]).group === "complete" } : {}),
  }));
}

/** Everything that turning a database back writes (6, 7): the table or list
 *  where it was drawn — or, a page of its own, as its body — and the
 *  database's rows (and, drawn in a page, the database) deleted for good. A
 *  refusal (1) writes nothing. */
export function databaseToBlocks(
  pages: Record<string, NotePage>,
  databaseId: string,
  as: "table" | "list",
  view: DatabaseView | undefined,
  ids: ConversionIds,
  stamp: Stamp,
  orderBetween: (left: number | undefined, right: number | undefined, count: number) => number[],
): { mutations: WorkspaceMutation[] } | { refusal: string } {
  const database = pages[databaseId];
  const reason = databaseConvertible(pages, databaseId)[as];
  if (!database?.database || reason) return { refusal: reason ?? "This is not a database." };
  const made = blocksFromDatabase(pages, database, as, view, ids);
  const rows = databaseRows(pages, databaseId);
  const gone: WorkspaceMutation[] = rows.flatMap((row) => [
    { type: "delete" as const, path: ["pages", row.id] },
    { type: "delete" as const, path: ["versions", row.id] },
  ]);
  const stamped = (pageId: string): WorkspaceMutation[] => [
    { type: "set", path: ["pages", pageId, "updated_at"], value: stamp.now },
    { type: "set", path: ["pages", pageId, "updated_by"], value: stamp.author },
  ];

  // Drawn in the page holding it: the blocks stand where it was drawn.
  const holder = database.parent_id ? pages[database.parent_id] : undefined;
  const drawn = holder?.kind === "document" ? linesFor(holder.block_tree, databaseId) : [];
  const shownAt = drawn.find((block) => lineLink(block)?.expanded) ?? drawn[0];
  if (holder && shownAt && lineLink(shownAt)?.expanded) {
    const siblings = orderedBlocks(holder.block_tree, shownAt.parent_id);
    const next = siblings[siblings.findIndex((block) => block.id === shownAt.id) + 1];
    const heading = database.title.trim()
      ? [createBlock(ids.block(), "heading3", { content: pageTitleContent(database) })]
      : [];
    const placed = [...heading, ...made];
    const orders = orderBetween(shownAt.order, next?.order, placed.length);
    const blocks = placed.map((block, index) => ({ ...block, parent_id: shownAt.parent_id, order: index === 0 ? shownAt.order : orders[index - 1] }));
    return {
      mutations: [
        ...blocks.map((block): WorkspaceMutation => ({ type: "set", path: ["pages", holder.id, "block_tree", "by_id", block.id], value: block })),
        ...drawn.map((block): WorkspaceMutation => ({ type: "delete", path: ["pages", holder.id, "block_tree", "by_id", block.id] })),
        ...stamped(holder.id),
        ...gone,
        { type: "delete", path: ["pages", databaseId] },
        { type: "delete", path: ["versions", databaseId] },
      ],
    };
  }

  // A page of its own: it becomes a page whose body is the table or list.
  const blocks = made.map((block, index) => ({ ...block, parent_id: null, order: (index + 1) * BLOCK_ORDER_STEP }));
  return {
    mutations: [
      ...Object.keys(database.block_tree.by_id).map((blockId): WorkspaceMutation => ({ type: "delete", path: ["pages", databaseId, "block_tree", "by_id", blockId] })),
      ...blocks.map((block): WorkspaceMutation => ({ type: "set", path: ["pages", databaseId, "block_tree", "by_id", block.id], value: block })),
      { type: "set", path: ["pages", databaseId, "kind"], value: "document" },
      { type: "delete", path: ["pages", databaseId, "database"] },
      ...stamped(databaseId),
      ...gone,
    ],
  };
}
