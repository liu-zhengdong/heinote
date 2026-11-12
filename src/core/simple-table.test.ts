import { describe, expect, it } from "vitest";
import { inlineFromText } from "./inline-content";
import {
  TABLE_COLUMN_WIDTH,
  TABLE_PAGE_WIDTH,
  fitColumnWidths,
  newSimpleTable,
  tableFromCells,
  tableGrid,
} from "./simple-table";
import type { InlineContent } from "./types";

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
