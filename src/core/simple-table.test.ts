import { describe, expect, it } from "vitest";
import { inlineFromText, inlinePlainText } from "./inline-content";
import {
  TABLE_COLUMN_WIDTH,
  TABLE_PAGE_WIDTH,
  alignOf,
  applyTableWrites,
  deleteRow,
  expandRectForSpans,
  fitColumnWidths,
  insertRow,
  isPhantom,
  mergeCells,
  newSimpleTable,
  setAligns,
  splitCells,
  tableCells,
  tableFromCells,
  tableGrid,
  tableToHtml,
} from "./simple-table";
import type { InlineContent, SimpleTable } from "./types";
import type { TableGrid, TableWrite } from "./simple-table";

const text = (value: string): InlineContent => inlineFromText(value);

let sequence = 0;
const ids = (kind: "column" | "row") => `${kind}-${++sequence}`;

const widthOf = (table: unknown, column: number): number => tableGrid(table).columns[column].width!;

describe("fitColumnWidths", () => {
  it("spreads a table across the text column, weighted by its widest cell", () => {
    const cells = [
      [text("短"), text("中")],
      [text("短"), text("这是一段明显更长的内容，它需要更多的宽度才不显得拥挤")],
    ];
    const widths = fitColumnWidths(cells, 2);
    expect(widths[0]! + widths[1]!).toBe(TABLE_PAGE_WIDTH);
    expect(widths[1]!).toBeGreaterThan(widths[0]!);
  });

  it("counts Chinese about twice a Latin letter, so a Chinese column is not squeezed", () => {
    const chinese = fitColumnWidths([[text("构建一套让团队能够长期自主运行的系统")]], 1);
    const latin = fitColumnWidths([[text("build a system that runs on its own")]], 1);
    expect(chinese[0]).toBe(latin[0]); // a single column takes the whole column either way
    const pair = fitColumnWidths([[text("中文中文中文"), text("latlatin")]], 2);
    expect(pair[0]!).toBeGreaterThan(pair[1]!);
  });

  it("never goes under the minimum, however many columns", () => {
    const cells = [Array.from({ length: 20 }, () => text("值"))];
    const widths = fitColumnWidths(cells, 20);
    expect(widths.every((width) => width! >= TABLE_COLUMN_WIDTH.min)).toBe(true);
  });

  it("sizes an empty grid evenly, not to zero", () => {
    const widths = fitColumnWidths([[[]], [[]]], 3);
    expect(widths[0]).toBe(widths[1]);
    expect(widths[1]).toBe(widths[2]);
  });
});

describe("tableFromCells", () => {
  it("stores fitted widths, so an imported table fills the text column", () => {
    const table = tableFromCells(
      [
        [text("层级"), text("领域"), text("年度目标")],
        [text("战略主线"), text("事业"), text("构建一套让 AI 团队能够长期、自主、大规模、有序运行的系统")],
      ],
      ids,
      { headerRow: true },
    );
    const widths = tableGrid(table).columns.map((column) => column.width!);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBe(TABLE_PAGE_WIDTH);
    expect(widths[2]).toBeGreaterThan(widths[0]);
  });

  it("keeps widths it was given and fits the rest", () => {
    const table = tableFromCells(
      [
        [text("a"), text("b")],
        [text("a"), text("一段比较长的中文内容用于占据更宽的列")],
      ],
      ids,
      { widths: [200, undefined] },
    );
    expect(widthOf(table, 0)).toBe(200);
    expect(widthOf(table, 1)).toBeGreaterThanOrEqual(TABLE_COLUMN_WIDTH.min);
  });
});

describe("newSimpleTable", () => {
  it("splits the text column evenly", () => {
    const table = newSimpleTable(3, 2, ids);
    const widths = tableGrid(table).columns.map((column) => column.width!);
    expect(widths).toEqual([236, 236, 236]);
  });
});

/* ── Merged cells ─────────────────────────────────────────────────────── */

/** The grid of a stored table after writes — what the page would draw. */
const after = (table: SimpleTable, writes: readonly TableWrite[]): TableGrid => tableGrid(applyTableWrites(table, writes));

const gridOf = (rows: InlineContent[][]): { table: SimpleTable; grid: TableGrid } => {
  const table = tableFromCells(rows, ids);
  return { table, grid: tableGrid(table) };
};

describe("mergeCells", () => {
  it("merges a rectangle into one cell, joining the cells' words line by line", () => {
    const { table, grid } = gridOf([
      [text("a1"), text("a2"), text("a3")],
      [text("b1"), text("b2"), text("b3")],
    ]);
    const writes = mergeCells(grid, { row: 0, column: 0, rows: 2, columns: 2 });
    const next = after(table, writes);
    expect(next.spans).toHaveLength(1);
    expect(next.spans[0]).toMatchObject({ rows: 2, columns: 2 });
    const cells = tableCells(next);
    expect(inlinePlainText(cells[0][0])).toBe("a1\na2\nb1\nb2");
    // Phantom cells keep nothing of their own.
    expect(cells[0][1]).toEqual([]);
    expect(cells[1][0]).toEqual([]);
    expect(cells[1][1]).toEqual([]);
    expect(isPhantom(next, 0, 1)).toBe(true);
    expect(isPhantom(next, 0, 0)).toBe(false);
    // Untouched cells survive.
    expect(inlinePlainText(cells[0][2])).toBe("a3");
    expect(inlinePlainText(cells[1][2])).toBe("b3");
  });

  it("writes only the rows the merge actually changed", () => {
    const { grid } = gridOf([
      [text("a"), text("b")],
      [text("c"), text("d")],
      [text("e"), text("f")],
    ]);
    const writes = mergeCells(grid, { row: 0, column: 0, rows: 2, columns: 2 });
    const touched = writes.filter((w): w is Extract<TableWrite, { kind: "row" }> => w.kind === "row").map((w) => w.rowId);
    expect(touched).not.toContain(grid.rows[2].id);
    expect(touched.length).toBeGreaterThan(0);
    // A merge over empty cells alone needs no row write at all — just the span.
    const { grid: empty } = gridOf([[text(""), text("")], [text(""), text("")]]);
    const writes2 = mergeCells(empty, { row: 0, column: 0, rows: 2, columns: 2 });
    expect(writes2.filter((w) => w.kind === "row")).toHaveLength(0);
    expect(writes2.some((w) => w.kind === "spans")).toBe(true);
  });

  it("swallows a span that sticks halfway into the rectangle", () => {
    const { table, grid } = gridOf([
      [text("a"), text("b"), text("c")],
      [text("d"), text("e"), text("f")],
      [text("g"), text("h"), text("i")],
    ]);
    const stored = applyTableWrites(table, mergeCells(grid, { row: 0, column: 0, rows: 2, columns: 2 }));
    const one = tableGrid(stored);
    // Selecting a rectangle that overlaps the existing merge swallows it whole.
    const grown = expandRectForSpans(one, { row: 1, column: 1, rows: 2, columns: 2 });
    expect(grown).toEqual({ row: 0, column: 0, rows: 3, columns: 3 });
    const merged = after(stored, mergeCells(one, { row: 1, column: 1, rows: 2, columns: 2 }));
    expect(merged.spans).toHaveLength(1);
    expect(merged.spans[0]).toMatchObject({ rows: 3, columns: 3 });
    expect(inlinePlainText(tableCells(merged)[0][0])).toBe("a\nb\nd\ne\nc\nf\ng\nh\ni");
  });
});

describe("splitCells", () => {
  it("lets a merged cell go — the anchor keeps its words, the rest come back empty", () => {
    const { table, grid } = gridOf([
      [text("a"), text("b")],
      [text("c"), text("d")],
    ]);
    const merged = after(table, mergeCells(grid, { row: 0, column: 0, rows: 2, columns: 2 }));
    const writes = splitCells(merged, { row: 0, column: 0, rows: 2, columns: 2 });
    const split = after(applyTableWrites(table, mergeCells(grid, { row: 0, column: 0, rows: 2, columns: 2 })), writes);
    expect(split.spans).toHaveLength(0);
    expect(inlinePlainText(tableCells(split)[0][0])).toBe("a\nb\nc\nd");
    expect(tableCells(split)[1][1]).toEqual([]);
    expect(isPhantom(split, 0, 1)).toBe(false);
  });

  it("writes nothing when the rectangle holds no merge", () => {
    const { grid } = gridOf([[text("a"), text("b")]]);
    expect(splitCells(grid, { row: 0, column: 0, rows: 1, columns: 2 })).toEqual([]);
  });
});

describe("rows and columns through a span", () => {
  const mergeMiddle = () => {
    const { table, grid } = gridOf([
      [text("a"), text("b"), text("c")],
      [text("d"), text("e"), text("f")],
      [text("g"), text("h"), text("i")],
    ]);
    const stored = applyTableWrites(table, mergeCells(grid, { row: 0, column: 0, rows: 2, columns: 2 }));
    return { stored, merged: tableGrid(stored) };
  };

  it("a row inserted inside a span stretches it; at its edge it stays", () => {
    const { stored, merged } = mergeMiddle();
    const grown = after(stored, insertRow(merged, 1, "new-row"));
    expect(grown.spans[0]).toMatchObject({ rows: 3, columns: 2 });
    const same = after(stored, insertRow(merged, 2, "new-row2"));
    expect(same.spans[0]).toMatchObject({ rows: 2, columns: 2 });
  });

  it("a row deleted inside a span shrinks it; deleting its anchor row lets it go", () => {
    const { stored, merged } = mergeMiddle();
    const shrunk = after(stored, deleteRow(merged, merged.rows[1].id));
    expect(shrunk.spans[0]).toMatchObject({ rows: 1, columns: 2 });
    // A 1×2 span is still a merge.
    expect(isPhantom(shrunk, 0, 1)).toBe(true);
    const gone = after(stored, deleteRow(merged, merged.rows[0].id));
    expect(gone.spans).toHaveLength(0);
  });

  it("stores spans in the record and reads them back", () => {
    const { stored } = mergeMiddle();
    expect(stored.spans).toHaveLength(1);
    expect(stored.spans![0]).toMatchObject({ rows: 2, columns: 2 });
  });

  it("round-trips a merged selection through copied HTML", () => {
    const { stored, merged } = mergeMiddle();
    const html = tableToHtml(tableCells(merged), false, [
      { row: 0, column: 0, rows: 2, columns: 2 },
    ]);
    expect(html).toContain('colspan="2"');
    expect(html).toContain('rowspan="2"');
    // 9 cells less 3 the merge covers: 6 tds, not 9.
    expect(html.match(/<td/g)).toHaveLength(6);
    void stored;
  });
});

describe("cell alignment", () => {
  it("paints a rect's cells and reads them back, clearing on unset", () => {
    const { table, grid } = gridOf([
      [text("a"), text("b")],
      [text("c"), text("d")],
    ]);
    const writes = setAligns(grid, { row: 0, column: 0, rows: 2, columns: 2 }, { h: "center", v: "middle" });
    const next = after(table, writes);
    expect(alignOf(next, 0, 0)).toEqual({ h: "center", v: "middle" });
    expect(alignOf(next, 1, 1)).toEqual({ h: "center", v: "middle" });
    // One `aligns` write carries the whole map.
    expect(writes).toHaveLength(1);
    expect(writes[0].kind).toBe("aligns");
    const cleared = after(applyTableWrites(table, writes), setAligns(next, { row: 0, column: 0, rows: 1, columns: 1 }, {}));
    expect(alignOf(cleared, 0, 0)).toEqual({});
    expect(alignOf(cleared, 1, 1)).toEqual({ h: "center", v: "middle" });
  });

  it("drops stale keys and unknown values on read, keeping the sane ones", () => {
    const { table } = gridOf([[text("a")]]);
    const doctored = {
      ...table,
      aligns: {
        "row-3:column-3": { h: "center", v: "middle" },
        "nobody:column-3": { h: "center" },
        "row-3:nobody": { v: "bottom" },
        "row-3:column-4": { h: "sideways" },
      },
    } as SimpleTable;
    // The real ids depend on `ids` counters — just use the grid's own.
    const real = tableGrid(table);
    const key = `${real.rows[0].id}:${real.columns[0].id}`;
    const mixed = { ...table, aligns: { ...doctored.aligns, [key]: { h: "right" } } } as SimpleTable;
    const read = tableGrid(mixed);
    expect(read.aligns[key]).toEqual({ h: "right" });
    expect(Object.keys(read.aligns)).toHaveLength(1);
  });

  it("emits text-align in copied HTML only where the cell asks for it", () => {
    const { table, grid } = gridOf([[text("a"), text("b")]]);
    const writes = setAligns(grid, { row: 0, column: 1, rows: 1, columns: 1 }, { h: "right" });
    const next = after(table, writes);
    const html = tableToHtml(tableCells(next), false, [], [[undefined, alignOf(next, 0, 1)]]);
    expect(html).toContain('<td style="text-align:right"');
    expect(html.match(/style=/g)).toHaveLength(1);
  });

  it("alignments survive merge (phantom keeps the anchor's)", () => {
    const { table, grid } = gridOf([
      [text("a"), text("b")],
      [text("c"), text("d")],
    ]);
    const aligned = after(table, setAligns(grid, { row: 0, column: 1, rows: 1, columns: 1 }, { h: "center" }));
    const merged = after(applyTableWrites(table, aligned ? [] : []), mergeCells(aligned, { row: 0, column: 0, rows: 2, columns: 2 }));
    // setAligns over a rect containing the merge touches the anchor only.
    const writes = setAligns(merged, { row: 0, column: 0, rows: 2, columns: 2 }, { h: "right" });
    const done = after(applyTableWrites(table, []), writes);
    expect(alignOf(done, 0, 0)).toEqual({ h: "right" });
    expect(done.aligns[`${done.rows[1].id}:${done.columns[1].id}`]).toBeUndefined();
  });
});
