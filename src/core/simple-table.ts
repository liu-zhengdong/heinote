/* A simple table — Notion's: a grid of cells holding words, standing in a
   page like any paragraph (a `table` block, its grid in `Block.table`), not
   a database.

   Rows are kept by id (`rows[rowId] = { order, cells }`), so a row is written
   on its own — `pages/<page>/block_tree/by_id/<table>/table/rows/<row>`, a path
   the log takes — and two people typing in two rows both keep their words,
   as with two paragraphs. The columns are one list (ids and widths, in
   order); a cell is kept under its column's id, so moving or deleting a
   column writes the list alone and touches no row.

   Every way reading one can go wrong — a table was written by whichever
   member's client wrote it last, so none of it is trusted:
   1. Not an object, or no usable column: one empty column and one empty row
      — a table is never drawn with nothing to click into.
   2. A column id that is not a plain key (letters, digits, _ and -, at most
      64, and not an object's own machinery: __proto__, prototype,
      constructor) or is repeated: dropped. Two columns sharing an id would
      share every cell; a cell kept under __proto__ would rewrite the row.
   3. A width that is not a finite number is unset; one outside 48–1200 px is
      held inside it.
   4. A row id that is not a plain key (as 2): dropped. A row whose order is
      not a finite number goes after the rest.
   5. Rows at the same order — two people adding one at the same place —
      stand in id order, the same for everyone.
   6. A cell reads as words: marks and http(s) or #page links, never a
      mention; a cell that is not a list of runs is empty. A cell kept for a
      column the table no longer has is not drawn (a row written while
      someone else deleted that column).
   7. More than MAX_TABLE_COLUMNS columns or MAX_TABLE_ROWS rows: the first
      that many are read.
   8. header_row and header_column are on only when stored as true.
   And writing:
   9. A change that would take the table past TABLE_BYTE_BUDGET is refused,
      the reader told: a record too large to save would fail at saving.
   10. Deleting a column writes the column list alone, so ⌘Z brings it back
       with its cells; a row written later keeps only the columns it has. */

import { inlinePlainText, inlineToHtml, normalizeInlineContent } from "./inline-content";
import type { InlineContent, SimpleTable, TableColumn, TableRow } from "./types";

export const MAX_TABLE_COLUMNS = 20;
export const MAX_TABLE_ROWS = 200;
/** Well inside the platform's 128 KiB per record, with room for its stamps. */
export const TABLE_BYTE_BUDGET = 96 * 1024;
export const TABLE_COLUMN_WIDTH = { min: 48, max: 1200, fallback: 120 } as const;
export const ROW_ORDER_STEP = 1024;

const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MACHINERY = new Set(["__proto__", "prototype", "constructor"]);

/** A key a column or a row may be kept under (2, 4). */
function plainKey(value: unknown): value is string {
  return typeof value === "string" && KEY_PATTERN.test(value) && !MACHINERY.has(value);
}

/** A table's rows in order, each with its id. */
export interface GridRow {
  id: string;
  order: number;
  cells: Record<string, InlineContent>;
}

/** A table as it is drawn: its columns in order, its rows in order, and its
 *  headers. */
export interface TableGrid {
  columns: TableColumn[];
  rows: GridRow[];
  header_row: boolean;
  header_column: boolean;
}

/** A cell's words: marks and safe links, never a mention (6). */
export function normalizeCell(value: unknown): InlineContent {
  return normalizeInlineContent(value).filter((run) => !run.mention);
}

function normalizeWidth(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.round(Math.min(TABLE_COLUMN_WIDTH.max, Math.max(TABLE_COLUMN_WIDTH.min, value)));
}

function normalizeColumns(value: unknown): TableColumn[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const columns: TableColumn[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const { id, width } = candidate as Record<string, unknown>;
    if (!plainKey(id) || seen.has(id)) continue;
    seen.add(id);
    const kept = normalizeWidth(width);
    columns.push({ id, ...(kept === undefined ? {} : { width: kept }) });
    if (columns.length === MAX_TABLE_COLUMNS) break;
  }
  return columns;
}

/* A row read once is the same object until it is written again — a write
   replaces only the row it touches — so the cells of every row but the one
   being typed in keep their identity from one keystroke to the next, and
   their fields are not drawn again. */
const rowsRead = new WeakMap<object, TableRow>();

/** One row as stored, or null when it is none (4, 6). */
export function normalizeRow(value: unknown): TableRow | null {
  if (!value || typeof value !== "object") return null;
  const cached = rowsRead.get(value);
  if (cached) return cached;
  const read = readRow(value);
  rowsRead.set(value, read);
  return read;
}

function readRow(value: object): TableRow {
  const { order, cells } = value as Record<string, unknown>;
  const kept: Record<string, InlineContent> = {};
  if (cells && typeof cells === "object" && !Array.isArray(cells)) {
    for (const [columnId, cell] of Object.entries(cells as Record<string, unknown>)) {
      if (!plainKey(columnId)) continue;
      const content = normalizeCell(cell);
      if (content.length) kept[columnId] = content;
    }
  }
  return { order: typeof order === "number" && Number.isFinite(order) ? order : Number.POSITIVE_INFINITY, cells: kept };
}

const byOrder = (left: GridRow, right: GridRow) => (
  left.order - right.order || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
);

/** A table as drawn, from whatever is stored (1–8). */
export function tableGrid(value: unknown): TableGrid {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  let columns = normalizeColumns(candidate.columns);
  const rows: GridRow[] = [];
  const stored = candidate.rows && typeof candidate.rows === "object" && !Array.isArray(candidate.rows)
    ? candidate.rows as Record<string, unknown>
    : {};
  for (const [id, raw] of Object.entries(stored)) {
    if (!plainKey(id)) continue;
    const row = normalizeRow(raw);
    if (row) rows.push({ id, ...row });
  }
  rows.sort(byOrder);
  // Orders that are not numbers were put last; they read as the next ones.
  let last = 0;
  for (const row of rows) {
    if (row.order === Number.POSITIVE_INFINITY) row.order = last + ROW_ORDER_STEP;
    last = row.order;
  }
  if (!columns.length) columns = [{ id: "column" }];
  const kept = rows.slice(0, MAX_TABLE_ROWS);
  return {
    columns,
    rows: kept.length ? kept : [{ id: "row", order: ROW_ORDER_STEP, cells: {} }],
    header_row: candidate.header_row === true,
    header_column: candidate.header_column === true,
  };
}

/** The grid as it is stored — a table normalised for a block's record. */
export function storedTable(grid: TableGrid): SimpleTable {
  return {
    columns: grid.columns.map((column) => ({ ...column })),
    rows: Object.fromEntries(grid.rows.map((row) => [row.id, { order: row.order, cells: structuredClone(row.cells) }])),
    ...(grid.header_row ? { header_row: true } : {}),
    ...(grid.header_column ? { header_column: true } : {}),
  };
}

/** What a `table` block keeps: its grid, read through the same checks. */
export function normalizeSimpleTable(value: unknown): SimpleTable {
  return storedTable(tableGrid(value));
}

/** A new table: `columns` wide, `rows` long, every cell empty. */
export function newSimpleTable(columns: number, rows: number, id: (kind: "column" | "row") => string): SimpleTable {
  return storedTable({
    columns: Array.from({ length: Math.max(1, Math.min(MAX_TABLE_COLUMNS, columns)) }, () => ({ id: id("column") })),
    rows: Array.from({ length: Math.max(1, Math.min(MAX_TABLE_ROWS, rows)) }, (_, index) => ({
      id: id("row"),
      order: (index + 1) * ROW_ORDER_STEP,
      cells: {},
    })),
    header_row: false,
    header_column: false,
  });
}

/** A table of these words — a paste, Markdown, a database turned into a
 *  table. Rows are made as wide as the widest. */
export function tableFromCells(
  cells: readonly (readonly InlineContent[])[],
  id: (kind: "column" | "row") => string,
  options: { headerRow?: boolean; headerColumn?: boolean; widths?: readonly (number | undefined)[] } = {},
): SimpleTable {
  const width = Math.max(1, Math.min(MAX_TABLE_COLUMNS, ...cells.map((row) => row.length)));
  const columns: TableColumn[] = Array.from({ length: width }, (_, index) => {
    const kept = normalizeWidth(options.widths?.[index]);
    return { id: id("column"), ...(kept === undefined ? {} : { width: kept }) };
  });
  const rows = cells.slice(0, MAX_TABLE_ROWS).map((row, index) => ({
    id: id("row"),
    order: (index + 1) * ROW_ORDER_STEP,
    cells: Object.fromEntries(columns
      .map((column, at) => [column.id, normalizeCell(row[at] ?? [])] as const)
      .filter(([, content]) => content.length)),
  }));
  return storedTable({
    columns,
    rows: rows.length ? rows : [{ id: id("row"), order: ROW_ORDER_STEP, cells: {} }],
    header_row: options.headerRow === true,
    header_column: options.headerColumn === true,
  });
}

/** The words of every cell, row by row, column by column. */
export function tableCells(grid: TableGrid): InlineContent[][] {
  return grid.rows.map((row) => grid.columns.map((column) => row.cells[column.id] ?? []));
}

/** How many bytes the table takes in its record, as JSON. */
export function tableBytes(table: SimpleTable): number {
  return new TextEncoder().encode(JSON.stringify(table)).byteLength;
}

/* ── Changes, as the writes that make them ────────────────────────────── */

/** One write to a table: a row set or taken out, the column list, or a
 *  header switched. Each has a path of its own, so each merges on its own. */
export type TableWrite =
  | { kind: "row"; rowId: string; row: TableRow | null }
  | { kind: "columns"; columns: TableColumn[] }
  | { kind: "header"; which: "header_row" | "header_column"; on: boolean };

/** The table after `writes` — to measure it, or to draw it at once. */
export function applyTableWrites(table: SimpleTable, writes: readonly TableWrite[]): SimpleTable {
  const next: SimpleTable = { ...table, columns: [...table.columns], rows: { ...table.rows } };
  for (const write of writes) {
    if (write.kind === "columns") next.columns = write.columns;
    else if (write.kind === "header") {
      if (write.on) next[write.which] = true;
      else delete next[write.which];
    } else if (write.row) next.rows[write.rowId] = write.row;
    else delete next.rows[write.rowId];
  }
  return next;
}

/** A row as written: only the cells of columns the table has (10), and no
 *  empty ones. */
function rowValue(grid: TableGrid, row: GridRow, cells: Record<string, InlineContent> = row.cells): TableRow {
  const kept: Record<string, InlineContent> = {};
  for (const column of grid.columns) {
    const content = cells[column.id];
    if (content?.length) kept[column.id] = content;
  }
  return { order: row.order, cells: kept };
}

export function writeCell(grid: TableGrid, rowId: string, columnId: string, content: InlineContent): TableWrite | null {
  const row = grid.rows.find((item) => item.id === rowId);
  if (!row) return null;
  return { kind: "row", rowId, row: rowValue(grid, row, { ...row.cells, [columnId]: normalizeCell(content) }) };
}

/** Where a row goes to stand before the row at `index` (or last). */
function orderAt(grid: TableGrid, index: number): number {
  const before = grid.rows[index - 1];
  const after = grid.rows[index];
  if (before && after) return before.order + (after.order - before.order) / 2;
  if (after) return after.order - ROW_ORDER_STEP;
  return (before?.order ?? 0) + ROW_ORDER_STEP;
}

export function insertRow(grid: TableGrid, index: number, rowId: string, cells: Record<string, InlineContent> = {}): TableWrite | null {
  if (grid.rows.length >= MAX_TABLE_ROWS) return null;
  const at = Math.max(0, Math.min(grid.rows.length, index));
  return { kind: "row", rowId, row: rowValue(grid, { id: rowId, order: orderAt(grid, at), cells }) };
}

export function deleteRow(grid: TableGrid, rowId: string): TableWrite | null {
  // A table always has a row to click into.
  if (grid.rows.length <= 1 || !grid.rows.some((row) => row.id === rowId)) return null;
  return { kind: "row", rowId, row: null };
}

/** The row with `rowId` moved to stand before the row at `index` of the rows
 *  as they are (the moved one counted), or last. */
export function moveRow(grid: TableGrid, rowId: string, index: number): TableWrite | null {
  const from = grid.rows.findIndex((row) => row.id === rowId);
  if (from < 0 || index === from || index === from + 1) return null;
  const rest = { ...grid, rows: grid.rows.filter((row) => row.id !== rowId) };
  const at = index > from ? index - 1 : index;
  return { kind: "row", rowId, row: rowValue(grid, { ...grid.rows[from], order: orderAt(rest, at) }) };
}

export function duplicateRow(grid: TableGrid, rowId: string, copyId: string): TableWrite | null {
  const from = grid.rows.findIndex((row) => row.id === rowId);
  if (from < 0) return null;
  return insertRow(grid, from + 1, copyId, structuredClone(grid.rows[from].cells));
}

export function clearRows(grid: TableGrid, rowIds: readonly string[], columnIds?: readonly string[]): TableWrite[] {
  const clearing = new Set(columnIds ?? grid.columns.map((column) => column.id));
  return grid.rows
    .filter((row) => rowIds.includes(row.id) && Object.keys(row.cells).some((id) => clearing.has(id)))
    .map((row) => ({
      kind: "row" as const,
      rowId: row.id,
      row: rowValue(grid, row, Object.fromEntries(Object.entries(row.cells).filter(([id]) => !clearing.has(id)))),
    }));
}

export function insertColumn(grid: TableGrid, index: number, columnId: string): TableWrite | null {
  if (grid.columns.length >= MAX_TABLE_COLUMNS) return null;
  const columns = [...grid.columns];
  columns.splice(Math.max(0, Math.min(columns.length, index)), 0, { id: columnId });
  return { kind: "columns", columns };
}

export function deleteColumn(grid: TableGrid, columnId: string): TableWrite | null {
  if (grid.columns.length <= 1 || !grid.columns.some((column) => column.id === columnId)) return null;
  return { kind: "columns", columns: grid.columns.filter((column) => column.id !== columnId) };
}

/** The column with `columnId` moved to stand before the column at `index`
 *  (the moved one counted), or last. */
export function moveColumn(grid: TableGrid, columnId: string, index: number): TableWrite | null {
  const from = grid.columns.findIndex((column) => column.id === columnId);
  if (from < 0 || index === from || index === from + 1) return null;
  const columns = [...grid.columns];
  const [moving] = columns.splice(from, 1);
  columns.splice(index > from ? index - 1 : index, 0, moving);
  return { kind: "columns", columns };
}

/** A copy of a column beside it: the list, and every row holding words in
 *  it. */
export function duplicateColumn(grid: TableGrid, columnId: string, copyId: string): TableWrite[] {
  const from = grid.columns.findIndex((column) => column.id === columnId);
  if (from < 0 || grid.columns.length >= MAX_TABLE_COLUMNS) return [];
  const columns = [...grid.columns];
  columns.splice(from + 1, 0, { ...grid.columns[from], id: copyId });
  const wider = { ...grid, columns };
  return [
    { kind: "columns", columns },
    ...grid.rows
      .filter((row) => row.cells[columnId]?.length)
      .map((row) => ({ kind: "row" as const, rowId: row.id, row: rowValue(wider, row, { ...row.cells, [copyId]: structuredClone(row.cells[columnId]) }) })),
  ];
}

export function setColumnWidth(grid: TableGrid, columnId: string, width: number | undefined): TableWrite | null {
  const kept = width === undefined ? undefined : normalizeWidth(width);
  if (!grid.columns.some((column) => column.id === columnId)) return null;
  return {
    kind: "columns",
    columns: grid.columns.map((column) => {
      if (column.id !== columnId) return column;
      const { width: _old, ...rest } = column;
      return kept === undefined ? rest : { ...rest, width: kept };
    }),
  };
}

/** Words pasted into the table from a cell: a grid of them laid over the
 *  cells from `rowIndex`, `columnIndex` on, the table growing rows and
 *  columns for what does not fit — as far as it may. */
export function pasteCells(
  grid: TableGrid,
  rowIndex: number,
  columnIndex: number,
  cells: readonly (readonly InlineContent[])[],
  id: (kind: "column" | "row") => string,
): { writes: TableWrite[]; clipped: boolean } {
  const writes: TableWrite[] = [];
  let clipped = false;
  const wanted = columnIndex + Math.max(0, ...cells.map((row) => row.length));
  const columns = [...grid.columns];
  while (columns.length < wanted && columns.length < MAX_TABLE_COLUMNS) columns.push({ id: id("column") });
  if (columns.length < wanted) clipped = true;
  if (columns.length !== grid.columns.length) writes.push({ kind: "columns", columns });
  const wide: TableGrid = { ...grid, columns };
  const rows = [...grid.rows];
  cells.forEach((line, offset) => {
    const at = rowIndex + offset;
    let row = rows[at];
    if (!row) {
      if (rows.length >= MAX_TABLE_ROWS) {
        clipped = true;
        return;
      }
      row = { id: id("row"), order: (rows.at(-1)?.order ?? 0) + ROW_ORDER_STEP, cells: {} };
      rows.push(row);
    }
    const next = { ...row.cells };
    line.forEach((content, index) => {
      const column = columns[columnIndex + index];
      if (column) next[column.id] = normalizeCell(content);
    });
    writes.push({ kind: "row", rowId: row.id, row: rowValue(wide, row, next) });
  });
  return { writes, clipped };
}

/* ── Outside Notes: Markdown, tab-separated text, HTML ────────────────── */

/** A cell as Markdown's table cell holds it: one line, its pipes escaped. */
function markdownCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>").trim();
}

/** The table as a GitHub-flavoured Markdown table. Markdown has no table
 *  without a header, so a table without one gets an empty header row. */
export function tableToMarkdown(grid: TableGrid, cellText: (content: InlineContent) => string): string {
  const lines = tableCells(grid).map((row) => `| ${row.map((cell) => markdownCell(cellText(cell))).join(" | ")} |`);
  const rule = `| ${grid.columns.map(() => "---").join(" | ")} |`;
  if (grid.header_row) return [lines[0], rule, ...lines.slice(1)].join("\n");
  return [`| ${grid.columns.map(() => " ").join(" | ")} |`, rule, ...lines].join("\n");
}

/** The table as tab-separated text — what a spreadsheet pastes. */
export function tableToTabs(cells: readonly (readonly InlineContent[])[]): string {
  return cells.map((row) => row.map((cell) => inlinePlainText(cell).replace(/[\t\r\n]+/g, " ")).join("\t")).join("\n");
}

/** The table as HTML, marks and links kept. */
export function tableToHtml(cells: readonly (readonly InlineContent[])[], headerRow = false): string {
  const body = cells.map((row, index) => {
    const tag = headerRow && index === 0 ? "th" : "td";
    return `<tr>${row.map((cell) => `<${tag}>${inlineToHtml(cell)}</${tag}>`).join("")}</tr>`;
  }).join("");
  return `<table>${body}</table>`;
}

/** A Markdown table's cells split out of a line: its outer pipes dropped,
 *  an escaped pipe kept as words. */
function markdownRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (character === "\\" && trimmed[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

const MARKDOWN_RULE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Whether a line starts a Markdown table: it and the rule under it. */
export function isMarkdownTableStart(line: string, next: string | undefined): boolean {
  return /\|/.test(line) && next !== undefined && MARKDOWN_RULE.test(next) && markdownRow(line).length === markdownRow(next).length;
}

/** A Markdown table's lines — header, rule, rows — as rows of words; the
 *  header first. Stops at the first line that is not a row of it. */
export function markdownTableLines(lines: readonly string[], start: number): { rows: string[][]; end: number } {
  const rows = [markdownRow(lines[start])];
  let index = start + 2;
  while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
    rows.push(markdownRow(lines[index]));
    index += 1;
  }
  return { rows, end: index };
}

/** Text that is a grid — tab-separated lines, as a spreadsheet copies them —
 *  as its rows, or null for text that is not one (at least two cells). */
export function tabbedRows(text: string): string[][] | null {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  if (!lines.some((line) => line.includes("\t"))) return null;
  const rows = lines.map((line) => line.split("\t"));
  return rows.length * Math.max(...rows.map((row) => row.length)) >= 2 ? rows : null;
}
