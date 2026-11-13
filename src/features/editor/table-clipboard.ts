import { inlineFromText, inlinePlainText, sliceInlineContent } from "../../core/inline-content";
import { isMarkdownTableStart, markdownTableLines, normalizeCell, tabbedRows, type CellRect } from "../../core/simple-table";
import type { InlineContent } from "../../core/types";
import { markdownInlineToContent } from "../../core/inline-markdown";
import { inlineFromNodes } from "./rich-text";

/* Grids on the clipboard — what a spreadsheet, a web page's table, a
   Markdown table or another simple table copies — as rows of cells. What is
   read is untrusted (it may come from any page on the web): every cell goes
   through a cell's own checks (`normalizeCell`), and HTML is read as a
   paragraph's words are: its marks and its words, nothing else. */

/** A grid read off the clipboard: its rows, whether its first row is a
 *  header (a Markdown table's always is; an HTML table's when its cells are
 *  <th>; tab-separated lines never say), and the merged cells it carries —
 *  an HTML table's colspan/rowspan as cell rects. */
export interface ReadGrid {
  rows: InlineContent[][];
  header: boolean;
  spans: CellRect[];
  /** Alignments the source claims: `row:col` indexes → h/v, read from
   *  `align`/`valign` attributes or inline styles. */
  aligns: Record<string, { h?: "left" | "center" | "right"; v?: "top" | "middle" | "bottom" }>;
}

/** A pasted cell's words, without the spaces its markup's indents leave at
 *  either end. */
function cellWords(cell: Element): InlineContent {
  const words = normalizeCell(inlineFromNodes(cell, { collapse: true }));
  const text = inlinePlainText(words);
  return sliceInlineContent(words, text.length - text.trimStart().length, text.trimEnd().length);
}

/** The first table in some HTML, as rows of cells — when the table is what
 *  the HTML holds. Words around it (a document with a table in it) make it no
 *  grid: pasting that as a table would drop them. */
export function gridFromHtml(html: string): ReadGrid | null {
  if (!/<table[\s>]/i.test(html) || typeof DOMParser === "undefined") return null;
  const document = new DOMParser().parseFromString(html, "text/html");
  const table = document.querySelector("table");
  if (!table) return null;
  const outside = (document.body.textContent ?? "").replace(table.textContent ?? "", "").trim();
  if (outside) return null;
  const lines = [...table.querySelectorAll("tr")].filter((row) => row.closest("table") === table);
  const cellsOf = (row: Element) => [...row.children].filter((cell) => cell.tagName === "TD" || cell.tagName === "TH");
  /* colspan/rowspan open the matrix up: every <td> claims the next free
     slot in its row — the ones a rowspan parked there get skipped. */
  const spans: CellRect[] = [];
  const parked = new Set<string>();
  const aligns: ReadGrid["aligns"] = {};
  const rows: InlineContent[][] = [];
  lines.forEach((line, r) => {
    const out: InlineContent[] = [];
    let c = 0;
    for (const cell of cellsOf(line)) {
      while (parked.has(`${r}:${c}`)) c++;
      const colspan = Math.max(1, Math.min(20, parseInt(cell.getAttribute("colspan") ?? "1", 10) || 1));
      const rowspan = Math.max(1, Math.min(200, parseInt(cell.getAttribute("rowspan") ?? "1", 10) || 1));
      if (colspan * rowspan > 1) {
        spans.push({ row: r, column: c, rows: rowspan, columns: colspan });
        for (let i = r; i < r + rowspan; i++)
          for (let j = c; j < c + colspan; j++)
            if (i !== r || j !== c) parked.add(`${i}:${j}`);
      }
      const el = cell as HTMLElement;
      const style = `${cell.getAttribute("align") ?? ""} ${el.style?.textAlign ?? ""} ${cell.getAttribute("style") ?? ""}`.toLowerCase();
      const vstyle = `${cell.getAttribute("valign") ?? ""} ${el.style?.verticalAlign ?? ""}`.toLowerCase();
      const align: { h?: "left" | "center" | "right"; v?: "top" | "middle" | "bottom" } = {};
      if (/text-align:\s*center|align="center"|^center$|\scenter\b/.test(style)) align.h = "center";
      else if (/text-align:\s*right|align="right"|^right$|\sright\b/.test(style)) align.h = "right";
      if (/middle/.test(vstyle)) align.v = "middle";
      else if (/bottom/.test(vstyle)) align.v = "bottom";
      if (align.h || align.v) aligns[`${r}:${c}`] = align;
      out[c] = cellWords(cell);
      c += colspan;
    }
    if (out.length) rows[r] = out;
  });
  const matrix = rows.filter(Boolean).map((row) => row.map((cell) => cell ?? []));
  if (!matrix.length) return null;
  const first = lines.find((row) => cellsOf(row).length);
  return { rows: matrix, header: Boolean(first) && cellsOf(first as Element).every((cell) => cell.tagName === "TH"), spans, aligns };
}

/** A Markdown table written out, as rows of cells, or null for other text. */
export function gridFromMarkdown(text: string): InlineContent[][] | null {
  const lines = text.replace(/\r\n?/g, "\n").trim().split("\n");
  if (lines.length < 2 || !isMarkdownTableStart(lines[0], lines[1])) return null;
  const { rows, end } = markdownTableLines(lines, 0);
  if (end < lines.length) return null;
  return rows.map((row) => row.map((cell) => normalizeCell(markdownInlineToContent(cell))));
}

/** What the clipboard holds as a grid: an HTML table, a Markdown table, or
 *  tab-separated lines — more than one cell of them. `anyText`: text that is
 *  none of these is a grid too — one cell a line — as it is when pasted over
 *  cells selected as cells. */
export function readGrid(data: DataTransfer, anyText: boolean): ReadGrid | null {
  const html = data.getData("text/html");
  const fromHtml = html ? gridFromHtml(html) : null;
  if (fromHtml && (fromHtml.rows.length > 1 || fromHtml.rows[0].length > 1 || anyText)) return fromHtml;
  const text = data.getData("text/plain");
  if (!text) return anyText ? fromHtml : null;
  const fromMarkdown = gridFromMarkdown(text);
  if (fromMarkdown) return { rows: fromMarkdown, header: true, spans: [], aligns: {} };
  const tabbed = tabbedRows(text);
  if (tabbed) return { rows: tabbed.map((row) => row.map((cell) => normalizeCell(inlineFromText(cell)))), header: false, spans: [], aligns: {} };
  if (!anyText) return null;
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  return { rows: lines.map((line) => [normalizeCell(inlineFromText(line))]), header: false, spans: [], aligns: {} };
}

/** The grid's rows and merges — what a paste over cells lays down. */
export function gridFromClipboard(data: DataTransfer, anyText: boolean): ReadGrid | null {
  return readGrid(data, anyText);
}
