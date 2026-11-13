import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Baseline, ChevronDown, Combine, Copy, Eraser, GripHorizontal, GripVertical, Plus, Rows3, Columns3, Trash2, Ungroup } from "lucide-react";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { MenuDivider, MenuItem, MenuList } from "../../components/Menu";
import { Popover } from "../../components/Popover";
import { Tooltip } from "../../components/Tooltip";
import { createId } from "../../core/ids";
import { applyMarkToRange, inlinePlainText, rangeHasMark, type ToggleableMark } from "../../core/inline-content";
import { imeComposing } from "../../core/keyboard";
import {
  clearRows,
  deleteColumn,
  deleteRow,
  duplicateColumn,
  duplicateRow,
  expandRectForSpans,
  insertColumn,
  insertRow,
  isPhantom,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  mergeCells,
  moveColumn,
  moveRow,
  pasteCells,
  setColumnWidth,
  spanAnchorAt,
  spansInRect,
  splitCells,
  TABLE_COLUMN_WIDTH,
  tableCells,
  tableGrid,
  tableToHtml,
  tableToTabs,
  writeCell,
  type CellRect,
  type TableWrite,
} from "../../core/simple-table";
import type { Block, InlineContent } from "../../core/types";
import { cellField } from "../../collaboration/protocol";
import { blockRecordId } from "../../platform/record-ids";
import { pointRect, rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import { CELL_GRAMMAR, RichField } from "./RichField";
import { focusRange, caretOnFirstLine, caretOnLastLine, caretOffset, placeCaretNear, selectionOffsets } from "./selection";
import { gridFromClipboard, type ReadGrid } from "./table-clipboard";
import { markForKey, MARKS } from "./marks";
import { ColorMenu } from "./ColorMenu";
import { rangeColor } from "../../core/inline-content";
import type { ContentColor } from "../../core/types";

/* A simple table — Notion's: a grid of cells in a page, drawn and edited in
   place (the model, and every way reading one can go wrong, head
   core/simple-table.ts).

   Typing: each cell is a line of words of its own (`RichField`, the cell
   grammar: marks, links, Shift+Enter lines). Tab and Shift+Tab walk the
   cells; Enter goes down a row (past the last, a new row); the arrows cross
   into the next cell at a cell's edge and out of the table at its own, where
   the page's lines take the caret back. Escape selects the cell; with cells
   selected, the arrows move the selection (Shift grows it), Delete clears
   it, ⌘C and ⌘X copy it as a spreadsheet's rows, typing replaces the cell,
   and a second Escape selects the table itself, as a block. A drag across
   cells selects them too.

   Shape, as Notion's (Winston, round 59: "I want to drag and change rows"):
   the row under the pointer shows a grip on its left edge and the column a
   grip on its top. Pressed, a grip selects its row or column — one blue
   outline around it — and opens its menu (insert either side, duplicate,
   clear, delete; the first row's and column's switch the header too).
   Dragged, the row lifts: a copy of it, outlined in blue with its grip blue,
   follows the pointer, a blue line shows where it will land, and letting go
   moves it there (Escape puts it back). The drag is the pointer's own,
   captured by the grip — never the browser's drag and drop, whose picture of
   the row is the browser's and which a page in a frame can lose. "+" under
   the table adds a row, "+" beside it a column; a column's right edge drags
   its width. The cell being typed in wears Notion's blue ring. The table's
   own switches (Header row and column, Turn into database) are in its
   paragraph menu — from its ⋮⋮ handle before it (BlockRow), or ⌘/ once it is
   selected (Escape twice). Every change is one step of undo, and each row is
   written on its own. */

export interface TableActions {
  /** Writes to the table; false when refused (it would grow too large). */
  writeTable(block: Block, writes: readonly TableWrite[]): boolean;
  /** The caret leaves the table — up (-1) out of its first row, down (1) out
   *  of its last — near `x`. */
  leaveTable(block: Block, direction: -1 | 1, x: number): void;
  /** The table selected as a block (Escape from a selected cell). */
  selectTable(block: Block): void;
}

interface CellAt {
  row: number;
  column: number;
}

/** Cells selected as cells: the one the selection began at, and the one it
 *  reaches. */
interface CellRange {
  anchor: CellAt;
  focus: CellAt;
}

type TableMenu =
  | { kind: "row"; rowId: string; anchor: AnchorRect }
  | { kind: "column"; columnId: string; anchor: AnchorRect }
  | { kind: "cells"; anchor: AnchorRect };

/** A cell range as a rectangle of indexes. */
const rectOfRange = (range: CellRange): CellRect => ({
  row: Math.min(range.anchor.row, range.focus.row),
  column: Math.min(range.anchor.column, range.focus.column),
  rows: Math.abs(range.focus.row - range.anchor.row) + 1,
  columns: Math.abs(range.focus.column - range.anchor.column) + 1,
});

/** A row or a column being moved by its grip: where the pointer was pressed
 *  (clientY for a row, clientX for a column), how far it has gone, and where
 *  the row would land — an index between rows, in the order before the move;
 *  null over its own place. `middles`: where each row's (or column's) middle
 *  stood when it was pressed, from the table's edge — where it lands is read
 *  against those, not against rows already making way for it. `lifted` once
 *  it has gone far enough to be a drag rather than a press. */
interface Moving {
  kind: "row" | "column";
  id: string;
  from: number;
  origin: number;
  offset: number;
  to: number | null;
  middles: number[];
  lifted: boolean;
}

/** A list with one item taken from `from` and put in before `to` (an index
 *  in the list as it was). */
function reordered<T>(items: readonly T[], from: number, to: number | null): readonly T[] {
  if (to === null || to === from || to === from + 1) return items;
  const rest = items.filter((_, index) => index !== from);
  rest.splice(to > from ? to - 1 : to, 0, items[from]);
  return rest;
}

/** How far the pointer goes before a press on a grip is a drag. */
const LIFT_DISTANCE = 4;

const EMPTY: InlineContent = [];

/* A table just made takes the caret in its first cell. */
const fresh = new Set<string>();
export function markFreshTable(blockId: string): void {
  fresh.add(blockId);
}

/** Where the caret goes into a table from the line above (1) or below (-1):
 *  a cell of its first or last row, the one under `x`. */
export function tableEntryCell(row: Element, direction: -1 | 1, x: number): HTMLElement | null {
  const rows = [...row.querySelectorAll<HTMLTableRowElement>(":scope .stbl__table > tbody > tr")];
  const line = direction === 1 ? rows[0] : rows.at(-1);
  if (!line) return null;
  const cells = [...line.querySelectorAll<HTMLElement>(":scope > td")];
  const under = cells.find((cell) => {
    const box = cell.getBoundingClientRect();
    return x >= box.left && x <= box.right;
  }) ?? (x < (cells[0]?.getBoundingClientRect().left ?? 0) ? cells[0] : cells.at(-1));
  return under?.querySelector<HTMLElement>(".stbl__text") ?? null;
}

const widthOf = (width: number | undefined) => width ?? TABLE_COLUMN_WIDTH.fallback;

const newId = (kind: "column" | "row") => createId(kind === "column" ? "col" : "row");

export const SimpleTable = memo(function SimpleTable({
  block,
  owningPageId,
  readOnly,
  actions,
}: {
  block: Block;
  owningPageId?: string;
  readOnly: boolean;
  actions: TableActions;
}) {
  const grid = useMemo(() => tableGrid(block.table), [block.table]);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const cells = useRef(new Map<string, HTMLElement>());
  const [range, setRange] = useState<CellRange | null>(null);
  const [menu, setMenu] = useState<TableMenu | null>(null);
  const [hover, setHover] = useState<{ row: number; column: number } | null>(null);
  const [moving, setMovingState] = useState<Moving | null>(null);
  const movingRef = useRef<Moving | null>(null);
  // The click a grip hears after a drag ends on it is not a press.
  const dragged = useRef(false);
  const setMoving = (next: Moving | null) => {
    movingRef.current = next;
    setMovingState(next);
  };
  const [sizing, setSizing] = useState<{ columnId: string; width: number } | null>(null);
  // A cell to take the caret once the change that makes it is drawn.
  const pending = useRef<{ row: string; column: string; at: "start" | "end" } | null>(null);
  const pointer = useRef<{ start: CellAt; moved: boolean } | null>(null);
  const lastPress = useRef<{ x: number; y: number; when: number } | null>(null);
  // The colour picker hanging off the cell toolbar.
  const [colorOpen, setColorOpen] = useState(false);
  const colorBtnRef = useRef<HTMLButtonElement | null>(null);
  // Where the table itself sits — the toolbar anchors over the selection box.
  const [tableBox, setTableBox] = useState({ top: 0, left: 0 });
  const tableAbsTop = tableBox.top;
  const tableAbsLeft = tableBox.left;

  const cellKey = (rowId: string, columnId: string) => `${rowId}:${columnId}`;
  const cellElement = (at: CellAt) => {
    const row = grid.rows[at.row];
    const column = grid.columns[at.column];
    return row && column ? cells.current.get(cellKey(row.id, column.id)) ?? null : null;
  };
  const focusCell = (at: CellAt, where: "start" | "end" | "all" = "end") => {
    const element = cellElement(at);
    if (!element) return;
    const length = element.textContent?.length ?? 0;
    setRange(null);
    focusRange(element, where === "end" ? length : 0, where === "start" ? 0 : length);
  };
  const write = (writes: ReadonlyArray<TableWrite | null>): boolean => {
    const kept = writes.filter((item): item is TableWrite => Boolean(item));
    return kept.length ? actions.writeTable(block, kept) : false;
  };

  /* A table just made takes the caret in its first cell; a row or column
     just made, in its cell. */
  useLayoutEffect(() => {
    if (fresh.delete(block.id)) {
      focusCell({ row: 0, column: 0 }, "start");
      return;
    }
    const wanted = pending.current;
    if (!wanted) return;
    const element = cells.current.get(cellKey(wanted.row, wanted.column));
    if (!element) return;
    pending.current = null;
    const length = element.textContent?.length ?? 0;
    focusRange(element, wanted.at === "end" ? length : 0);
    // Once, as the grid it waits for is drawn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid]);

  /* ── Cells: the caret between them ─────────────────────────────────── */

  const lastRow = grid.rows.length - 1;
  const lastColumn = grid.columns.length - 1;

  /** A new row, `at` — its cell in `column` takes the caret. */
  const addRow = (at: number, column = 0, cellsOf: Record<string, InlineContent> = {}) => {
    const rowId = newId("row");
    if (grid.rows.length >= MAX_TABLE_ROWS) return false;
    const made = write(insertRow(grid, at, rowId, cellsOf));
    if (made) pending.current = { row: rowId, column: grid.columns[Math.min(column, lastColumn)].id, at: "start" };
    return made;
  };

  const onCellKey = (event: KeyboardEvent<HTMLElement>, at: CellAt) => {
    if (imeComposing(event)) return;
    const element = event.currentTarget;
    const x = element.getBoundingClientRect().left + 4;
    const caretX = () => {
      const selection = window.getSelection();
      return (selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect().left : 0) || x;
    };
    const offsets = selectionOffsets(element);
    const collapsed = !offsets || offsets.start === offsets.end;
    const length = element.textContent?.length ?? 0;
    switch (event.key) {
      case "Tab": {
        event.preventDefault();
        const index = at.row * grid.columns.length + at.column + (event.shiftKey ? -1 : 1);
        if (index < 0) return;
        if (index > lastRow * grid.columns.length + lastColumn) {
          if (!readOnly) addRow(grid.rows.length, 0);
          return;
        }
        focusCell({ row: Math.floor(index / grid.columns.length), column: index % grid.columns.length }, event.shiftKey ? "end" : "all");
        return;
      }
      case "Enter": {
        if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault();
        if (at.row < lastRow) focusCell({ row: at.row + 1, column: at.column });
        else if (!readOnly) addRow(grid.rows.length, at.column);
        return;
      }
      case "ArrowUp": {
        if (event.shiftKey || !caretOnFirstLine(element)) return;
        event.preventDefault();
        if (at.row > 0) {
          const above = cellElement({ row: at.row - 1, column: at.column });
          if (above) placeCaretNear(above, caretX(), "bottom");
        } else actions.leaveTable(block, -1, caretX());
        return;
      }
      case "ArrowDown": {
        if (event.shiftKey || !caretOnLastLine(element)) return;
        event.preventDefault();
        if (at.row < lastRow) {
          const below = cellElement({ row: at.row + 1, column: at.column });
          if (below) placeCaretNear(below, caretX(), "top");
        } else actions.leaveTable(block, 1, caretX());
        return;
      }
      case "ArrowLeft": {
        if (event.shiftKey || !collapsed || caretOffset(element) !== 0) return;
        event.preventDefault();
        if (at.column > 0) focusCell({ row: at.row, column: at.column - 1 }, "end");
        else if (at.row > 0) focusCell({ row: at.row - 1, column: lastColumn }, "end");
        else actions.leaveTable(block, -1, x);
        return;
      }
      case "ArrowRight": {
        if (event.shiftKey || !collapsed || caretOffset(element) !== length) return;
        event.preventDefault();
        if (at.column < lastColumn) focusCell({ row: at.row, column: at.column + 1 }, "start");
        else if (at.row < lastRow) focusCell({ row: at.row + 1, column: 0 }, "start");
        else actions.leaveTable(block, 1, x);
        return;
      }
      case "Escape": {
        event.preventDefault();
        selectCells({ anchor: at, focus: at });
        return;
      }
      case "Backspace": {
        // A cell's start is the table's own edge: Backspace never merges it
        // into anything.
        if (collapsed && caretOffset(element) === 0) event.preventDefault();
        return;
      }
      default:
    }
  };

  /* ── Cells selected as cells ────────────────────────────────────────── */

  const selectCells = (next: CellRange | null) => {
    setRange(next);
    if (!next) return;
    // The caret lets go; the keyboard is the table's.
    const active = document.activeElement;
    if (active instanceof HTMLElement && frameRef.current?.contains(active)) active.blur();
    window.getSelection()?.removeAllRanges();
    frameRef.current?.focus({ preventScroll: true });
  };

  /* The selection always swallows whole spans — a merged cell is one cell. */
  const expandedRect = (): CellRect | null => range ? expandRectForSpans(grid, rectOfRange(range)) : null;

  const selectedCells = (): { rows: number[]; columns: number[] } => {
    const rect = expandedRect();
    if (!rect) return { rows: [], columns: [] };
    const span = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
    return { rows: span(rect.row, rect.row + rect.rows - 1), columns: span(rect.column, rect.column + rect.columns - 1) };
  };

  const clearSelected = () => {
    const { rows, columns } = selectedCells();
    write(clearRows(grid, rows.map((index) => grid.rows[index].id), columns.map((index) => grid.columns[index].id)));
  };

  const selectedGrid = (): InlineContent[][] => {
    const { rows, columns } = selectedCells();
    const all = tableCells(grid);
    return rows.map((row) => columns.map((column) => all[row]?.[column] ?? []));
  };

  const toggleSelectedMark = (mark: ToggleableMark) => {
    const { rows, columns } = selectedCells();
    const all = tableCells(grid);
    const chosen = rows.flatMap((row) => columns.map((column) => all[row][column])).filter((cell) => inlinePlainText(cell).length);
    const on = !chosen.every((cell) => rangeHasMark(cell, 0, inlinePlainText(cell).length, mark));
    const writes = rows.map((row) => {
      let next = { ...grid.rows[row].cells };
      for (const column of columns) {
        const cell = all[row][column];
        const id = grid.columns[column].id;
        if (inlinePlainText(cell)) next = { ...next, [id]: applyMarkToRange(cell, 0, inlinePlainText(cell).length, mark, on || undefined) };
      }
      return { kind: "row" as const, rowId: grid.rows[row].id, row: { order: grid.rows[row].order, cells: next } };
    });
    write(writes);
  };

  /** Every visible (non-phantom) cell the expanded selection covers, with
   *  its row — for marks and colours, which write whole rows. */
  const selectedVisibleCells = (): Array<{ row: number; column: number; content: InlineContent }> => {
    const rect = expandedRect();
    if (!rect) return [];
    const all = tableCells(grid);
    const out: Array<{ row: number; column: number; content: InlineContent }> = [];
    for (let r = rect.row; r < rect.row + rect.rows; r++)
      for (let c = rect.column; c < rect.column + rect.columns; c++) {
        if (isPhantom(grid, r, c)) continue;
        out.push({ row: r, column: c, content: all[r]?.[c] ?? [] });
      }
    return out;
  };

  /** A colour over the visible cells' words — same mark the format bar
   *  paints on a text selection. */
  const applyColorToSelected = (color: ContentColor | undefined) => {
    const touched = selectedVisibleCells();
    const byRow = new Map<number, Record<string, InlineContent>>();
    for (const cell of touched) {
      if (!inlinePlainText(cell.content)) continue;
      const columnId = grid.columns[cell.column].id;
      const rowCells = byRow.get(cell.row) ?? { ...grid.rows[cell.row].cells };
      rowCells[columnId] = applyMarkToRange(cell.content, 0, inlinePlainText(cell.content).length, "color", color);
      byRow.set(cell.row, rowCells);
    }
    write([...byRow.entries()].map(([r, cells]) => ({
      kind: "row" as const, rowId: grid.rows[r].id, row: { order: grid.rows[r].order, cells },
    })));
  };

  /** Every selected cell's words wear the mark (so the button shows on). */
  const markShared = (mark: ToggleableMark): boolean => {
    const touched = selectedVisibleCells().filter((cell) => inlinePlainText(cell.content));
    return touched.length > 0 && touched.every((cell) => rangeHasMark(cell.content, 0, inlinePlainText(cell.content).length, mark));
  };

  /** The colour every selected cell shares, if they share one. */
  const selectedColor = (): ContentColor | undefined => {
    const touched = selectedVisibleCells().filter((cell) => inlinePlainText(cell.content));
    if (!touched.length) return undefined;
    const shared = rangeColor(touched[0].content, 0, inlinePlainText(touched[0].content).length);
    return touched.every((cell) => rangeColor(cell.content, 0, inlinePlainText(cell.content).length) === shared) ? shared : undefined;
  };

  /** The whole selection becomes one cell — top-left keeps every word. */
  const mergeSelected = () => {
    const rect = expandedRect();
    if (!rect) return;
    const writes = mergeCells(grid, rect);
    if (!writes.length || !write(writes)) return;
    setRange({ anchor: { row: rect.row, column: rect.column }, focus: { row: rect.row + rect.rows - 1, column: rect.column + rect.columns - 1 } });
  };

  /** Merged cells in the selection let go and come back plain. */
  const splitSelected = () => {
    const rect = expandedRect();
    if (!rect) return;
    write(splitCells(grid, rect));
  };

  /** What the selection can do: a 2+ cell rectangle can Merge, a rectangle
   *  holding a merged cell can Split. */
  const selectionOps = () => {
    const rect = expandedRect();
    if (!rect) return { mergeable: false, splittable: false };
    const touched = grid.spans.some((span) => {
      const anchor = grid.rows.findIndex((row) => row.id === span.row);
      const column = grid.columns.findIndex((item) => item.id === span.column);
      if (anchor < 0 || column < 0) return false;
      return anchor < rect.row + rect.rows && rect.row < anchor + span.rows
        && column < rect.column + rect.columns && rect.column < column + span.columns;
    });
    return { mergeable: rect.rows * rect.columns > 1, splittable: touched };
  };

  const onFrameKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!range || event.target !== frameRef.current || imeComposing(event)) return;
    const meta = event.metaKey || event.ctrlKey;
    const move = (row: number, column: number) => {
      const focus = { row: Math.max(0, Math.min(lastRow, row)), column: Math.max(0, Math.min(lastColumn, column)) };
      setRange(event.shiftKey ? { anchor: range.anchor, focus } : { anchor: focus, focus });
    };
    switch (event.key) {
      case "ArrowUp": event.preventDefault(); move(range.focus.row - 1, range.focus.column); return;
      case "ArrowDown": event.preventDefault(); move(range.focus.row + 1, range.focus.column); return;
      case "ArrowLeft": event.preventDefault(); move(range.focus.row, range.focus.column - 1); return;
      case "ArrowRight": event.preventDefault(); move(range.focus.row, range.focus.column + 1); return;
      case "Tab": event.preventDefault(); move(range.focus.row, range.focus.column + (event.shiftKey ? -1 : 1)); return;
      case "Enter": event.preventDefault(); focusCell(range.focus); return;
      case "Escape":
        // Claimed: selecting the table mounts the selected blocks' own keys
        // on the window while this very Escape is on its way there — let
        // through, it would let go of the table at once.
        event.preventDefault();
        event.stopPropagation();
        setRange(null);
        actions.selectTable(block);
        return;
      case "Backspace":
      case "Delete":
        event.preventDefault();
        if (!readOnly) clearSelected();
        return;
      default:
    }
    if (meta && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setRange({ anchor: { row: 0, column: 0 }, focus: { row: lastRow, column: lastColumn } });
      return;
    }
    if (meta && !readOnly) {
      const mark = markForKey(event);
      if (mark) {
        event.preventDefault();
        toggleSelectedMark(mark);
      }
      return;
    }
    // Typing over a selected cell replaces it, as in a spreadsheet: the
    // cell takes the caret, its words selected, and the key lands there.
    if (!readOnly && event.key.length === 1 && !event.altKey) focusCell(range.focus, "all");
  };

  const onFrameCopy = (event: ClipboardEvent<HTMLDivElement>, cut: boolean) => {
    if (!range || event.target !== frameRef.current) return;
    event.preventDefault();
    const copied = selectedGrid();
    const rect = expandRectForSpans(grid, rectOfRange(range));
    event.clipboardData.setData("text/plain", tableToTabs(copied));
    event.clipboardData.setData("text/html", `<meta charset="utf-8">${tableToHtml(copied, false, spansInRect(grid, rect))}`);
    if (cut && !readOnly) clearSelected();
  };

  /** A grid pasted at a cell: laid over the cells from there, the table
   *  growing for what does not fit — its merges coming along. */
  const pasteAt = (at: CellAt, pasted: ReadGrid) => {
    const laid = pasteCells(grid, at.row, at.column, pasted.rows, newId, pasted.spans);
    write(laid.writes);
    setRange({ anchor: at, focus: {
      row: Math.min(at.row + pasted.rows.length - 1, MAX_TABLE_ROWS - 1),
      column: Math.min(at.column + Math.max(...pasted.rows.map((row) => row.length)) - 1, MAX_TABLE_COLUMNS - 1),
    } });
    frameRef.current?.focus({ preventScroll: true });
  };

  const onFramePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (!range || event.target !== frameRef.current || readOnly) return;
    event.preventDefault();
    const pasted = gridFromClipboard(event.clipboardData, true);
    if (pasted) pasteAt({ row: Math.min(range.anchor.row, range.focus.row), column: Math.min(range.anchor.column, range.focus.column) }, pasted);
  };

  /* A drag from one cell across others selects them as cells. */
  const onPointerDown = (event: ReactPointerEvent<HTMLTableElement>) => {
    /* A press of another button (right, middle) takes no caret either: its
       preventDefault keeps the cell from focusing, so a right-press on the
       cell selection does not dissolve it before its menu opens — the
       contextmenu event itself still arrives. */
    if (event.button !== 0) {
      event.preventDefault();
      return;
    }
    const cell = (event.target as Element).closest<HTMLElement>("td[data-row-index]");
    if (!cell || cell.closest(".stbl__table") !== event.currentTarget) return;
    const at = { row: Number(cell.dataset.rowIndex), column: Number(cell.dataset.columnIndex) };
    if (event.shiftKey) {
      const from = range?.anchor ?? currentCell();
      if (from) {
        event.preventDefault();
        selectCells({ anchor: from, focus: at });
        return;
      }
    }
    /* A second press of a double click keeps its own word selection: it is
       the press that stays out of this table's. pointerdown carries no
       click count, so the pair is recognized by time and place. */
    const previous = lastPress.current;
    lastPress.current = { x: event.clientX, y: event.clientY, when: event.timeStamp };
    if (previous && event.timeStamp - previous.when < 500 && Math.abs(event.clientX - previous.x) <= 6 && Math.abs(event.clientY - previous.y) <= 6) return;
    pointer.current = { start: at, moved: false };
    if (range) setRange(null);
    /* The press is taken over whole: preventing its pointerdown keeps the
       browser's text drag from starting at all (the drag paints the cells'
       own selection instead — nothing else reached it: a mousemove's
       preventDefault is too late, and user-select set mid-gesture does not
       call a running selection back). The caret the press would have placed
       is set here instead. */
    event.preventDefault();
    const text = cell.querySelector<HTMLElement>(".stbl__text");
    if (text && !readOnly) {
      text.focus({ preventScroll: true });
      const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY)
        ?? (document as Document & { caretRangeFromPoint?(x: number, y: number): Range | null }).caretRangeFromPoint?.(event.clientX, event.clientY);
      const node = caret && "offsetNode" in caret ? caret.offsetNode : caret?.startContainer;
      const offset = caret && "offsetNode" in caret ? caret.offset : caret?.startOffset;
      const selection = window.getSelection();
      if (node && offset !== undefined && text.contains(node) && selection) {
        const caretRange = document.createRange();
        caretRange.setStart(node, offset);
        caretRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(caretRange);
      } else {
        const words = tableCells(grid)[at.row]?.[at.column] ?? [];
        focusRange(text, inlinePlainText(words).length);
      }
    }
  };

  const currentCell = (): CellAt | null => {
    const active = document.activeElement as HTMLElement | null;
    const cell = active?.closest<HTMLElement>("td[data-row-index]");
    return cell && frameRef.current?.contains(cell) ? { row: Number(cell.dataset.rowIndex), column: Number(cell.dataset.columnIndex) } : null;
  };

  /* The drag runs on pointermoves, not mousemoves: onPointerDown prevents
     each cell press's pointerdown, and a prevented pointerdown stops the
     WHOLE compatibility-mouse-event stream — mousedown, mousemove, all of
     it — so a mousemove listener would never hear the drag at all. */
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = pointer.current;
      if (!drag || !(event.buttons & 1)) return;
      const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("td[data-row-index]");
      if (!cell || !frameRef.current?.contains(cell)) return;
      const at = { row: Number(cell.dataset.rowIndex), column: Number(cell.dataset.columnIndex) };
      if (!drag.moved && at.row === drag.start.row && at.column === drag.start.column) return;
      drag.moved = true;
      event.preventDefault();
      selectCells({ anchor: drag.start, focus: at });
    };
    const onUp = () => { pointer.current = null; };
    document.addEventListener("pointermove", onMove, { passive: false });
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
    // The handlers read the table through refs and the latest render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid]);

  /* A selection lets go when the page is pressed anywhere else. */
  useEffect(() => {
    if (!range) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target && (frameRef.current?.contains(target) || target.closest(".pop"))) return;
      setRange(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [range]);

  /* ── Rows and columns: grips, menus, moves ──────────────────────────── */

  const openRowMenu = (index: number, anchor: AnchorRect) => {
    setRange({ anchor: { row: index, column: 0 }, focus: { row: index, column: lastColumn } });
    frameRef.current?.focus({ preventScroll: true });
    setMenu({ kind: "row", rowId: grid.rows[index].id, anchor });
  };
  const openColumnMenu = (index: number, anchor: AnchorRect) => {
    setRange({ anchor: { row: 0, column: index }, focus: { row: lastRow, column: index } });
    frameRef.current?.focus({ preventScroll: true });
    setMenu({ kind: "column", columnId: grid.columns[index].id, anchor });
  };

  /* A grip pressed: the pointer is its own until let go, wherever it goes
     (so nothing it passes over can take the drag). */
  const gripDown = (event: ReactPointerEvent<HTMLButtonElement>, kind: "row" | "column", index: number) => {
    if (readOnly || event.button !== 0) return;
    dragged.current = false;
    if ((kind === "row" ? grid.rows.length : grid.columns.length) < 2) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setMoving({
      kind,
      id: kind === "row" ? grid.rows[index].id : grid.columns[index].id,
      from: index,
      origin: kind === "row" ? event.clientY : event.clientX,
      offset: 0,
      to: null,
      middles: kind === "row"
        ? rowBoxes.map((box) => box.top + box.height / 2)
        : widths.map((width, at) => lefts[at] + width / 2),
      lifted: false,
    });
  };

  /** Where a row (or column) would land with the pointer at `along` px from
   *  the table's top (or left): before the first row whose middle stood
   *  below it. Its own place — just before or after itself — is no move. */
  const landingAt = (current: Moving, along: number): number | null => {
    const to = current.middles.filter((middle) => middle < along).length;
    return to === current.from || to === current.from + 1 ? null : to;
  };

  const gripMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = movingRef.current;
    if (!current) return;
    const offset = (current.kind === "row" ? event.clientY : event.clientX) - current.origin;
    if (!current.lifted && Math.abs(offset) < LIFT_DISTANCE) return;
    const box = frameRef.current?.querySelector(".stbl__table")?.getBoundingClientRect();
    if (!box) return;
    if (!current.lifted) {
      dragged.current = true;
      setMenu(null);
      setRange(null);
    }
    const along = current.kind === "row" ? event.clientY - box.top : event.clientX - box.left;
    setMoving({ ...current, offset, to: landingAt(current, along), lifted: true });
  };

  /* Let go: a drag moves the row there, and it stays selected where it
     landed; a press (no drag) is the grip's click, which opens its menu. */
  const gripUp = () => {
    const current = movingRef.current;
    if (!current) return;
    setMoving(null);
    if (!current.lifted || current.to === null) return;
    const moved = write([current.kind === "row" ? moveRow(grid, current.id, current.to) : moveColumn(grid, current.id, current.to)]);
    if (!moved) return;
    const landed = current.to > current.from ? current.to - 1 : current.to;
    setRange(current.kind === "row"
      ? { anchor: { row: landed, column: 0 }, focus: { row: landed, column: lastColumn } }
      : { anchor: { row: 0, column: landed }, focus: { row: lastRow, column: landed } });
    frameRef.current?.focus({ preventScroll: true });
  };

  /* Escape puts a row being moved back where it was. */
  useEffect(() => {
    if (!moving) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMoving(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // Only whether a move is under way matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(moving)]);

  /* ── A column's width, dragged by its right edge ────────────────────── */

  const startResize = (event: ReactPointerEvent<HTMLDivElement>, columnId: string, from: number) => {
    if (readOnly || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    let width = from;
    setSizing({ columnId, width });
    const move = (next: PointerEvent) => {
      width = Math.round(Math.max(TABLE_COLUMN_WIDTH.min, Math.min(TABLE_COLUMN_WIDTH.max, from + next.clientX - startX)));
      setSizing({ columnId, width });
    };
    const end = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key, true);
      setSizing(null);
      if (commit && width !== from) write([setColumnWidth(grid, columnId, width)]);
    };
    const up = () => end(true);
    const key = (next: globalThis.KeyboardEvent) => {
      if (next.key !== "Escape") return;
      next.stopPropagation();
      end(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key, true);
  };

  const widths = grid.columns.map((column) => (sizing?.columnId === column.id ? sizing.width : widthOf(column.width)));
  const lefts = widths.reduce<number[]>((edges, width, index) => [...edges, (edges[index] ?? 0) + width], [0]);
  const total = lefts.at(-1) ?? 0;

  /* Where the hovered row is, for its grip: measured from the drawn rows. */
  const [rowBoxes, setRowBoxes] = useState<Array<{ top: number; height: number }>>([]);
  useLayoutEffect(() => {
    const table = frameRef.current?.querySelector(".stbl__table");
    if (!table) return;
    const measure = () => {
      const box0 = table.getBoundingClientRect();
      setTableBox({ top: box0.top, left: box0.left });
      const top = box0.top;
      setRowBoxes([...table.querySelectorAll(":scope > tbody > tr")].map((tr) => {
        const box = tr.getBoundingClientRect();
        return { top: box.top - top, height: box.height };
      }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(table);
    return () => observer.disconnect();
  }, [grid, widths.join(",")]);

  const menuRowIndex = menu?.kind === "row" ? grid.rows.findIndex((row) => row.id === menu.rowId) : -1;
  const menuColumnIndex = menu?.kind === "column" ? grid.columns.findIndex((column) => column.id === menu.columnId) : -1;
  const closeMenu = () => {
    setMenu(null);
    setRange(null);
  };

  const rowMenuItems = (index: number) => {
    const row = grid.rows[index];
    const run = (writes: ReadonlyArray<TableWrite | null>) => {
      setMenu(null);
      setRange(null);
      write(writes);
    };
    return (
      <MenuList label="Row" autoFocus>
        {index === 0 ? (
          <>
            <MenuItem
              icon={<Rows3 size={16} />}
              label="Header row"
              selected={grid.header_row}
              onSelect={() => run([{ kind: "header", which: "header_row", on: !grid.header_row }])}
            />
            <MenuDivider />
          </>
        ) : null}
        <MenuItem icon={<ArrowUp size={16} />} label="Insert above" disabled={grid.rows.length >= MAX_TABLE_ROWS} onSelect={() => { closeMenu(); addRow(index, 0); }} />
        <MenuItem icon={<ArrowDown size={16} />} label="Insert below" disabled={grid.rows.length >= MAX_TABLE_ROWS} onSelect={() => { closeMenu(); addRow(index + 1, 0); }} />
        <MenuItem icon={<Copy size={16} />} label="Duplicate" disabled={grid.rows.length >= MAX_TABLE_ROWS} onSelect={() => run(duplicateRow(grid, row.id, newId("row")))} />
        <MenuItem icon={<Eraser size={16} />} label="Clear contents" onSelect={() => run(clearRows(grid, [row.id]))} />
        <MenuDivider />
        <MenuItem icon={<Trash2 size={16} />} label="Delete" tone="danger" disabled={grid.rows.length <= 1} onSelect={() => run(deleteRow(grid, row.id))} />
      </MenuList>
    );
  };

  const columnMenuItems = (index: number) => {
    const column = grid.columns[index];
    const run = (writes: ReadonlyArray<TableWrite | null>) => {
      setMenu(null);
      setRange(null);
      write(writes);
    };
    const full = grid.columns.length >= MAX_TABLE_COLUMNS;
    return (
      <MenuList label="Column" autoFocus>
        {index === 0 ? (
          <>
            <MenuItem
              icon={<Columns3 size={16} />}
              label="Header column"
              selected={grid.header_column}
              onSelect={() => run([{ kind: "header", which: "header_column", on: !grid.header_column }])}
            />
            <MenuDivider />
          </>
        ) : null}
        <MenuItem icon={<ArrowLeft size={16} />} label="Insert left" disabled={full} onSelect={() => run(insertColumn(grid, index, newId("column")))} />
        <MenuItem icon={<ArrowRight size={16} />} label="Insert right" disabled={full} onSelect={() => run(insertColumn(grid, index + 1, newId("column")))} />
        <MenuItem icon={<Copy size={16} />} label="Duplicate" disabled={full} onSelect={() => run(duplicateColumn(grid, column.id, newId("column")))} />
        <MenuItem icon={<Eraser size={16} />} label="Clear contents" onSelect={() => run(clearRows(grid, grid.rows.map((row) => row.id), [column.id]))} />
        <MenuDivider />
        <MenuItem icon={<Trash2 size={16} />} label="Delete" tone="danger" disabled={grid.columns.length <= 1} onSelect={() => run(deleteColumn(grid, column.id))} />
      </MenuList>
    );
  };

  const hoverRow = hover?.row ?? -1;
  const hoverColumn = hover?.column ?? -1;
  const head = (row: number, column: number) => (grid.header_row && row === 0) || (grid.header_column && column === 0);

  /* What a move draws. The grip pressed stays on its own row, whatever the
     pointer passes over: it holds the pointer. */
  const lifted = moving?.lifted ? moving : null;
  const gripRow = moving ? (moving.kind === "row" ? moving.from : -1) : menu?.kind === "column" ? -1 : hoverRow;
  const gripColumn = moving ? (moving.kind === "column" ? moving.from : -1) : menu?.kind === "row" ? -1 : hoverColumn;
  const tableHeight = rowBoxes.length ? rowBoxes[rowBoxes.length - 1].top + rowBoxes[rowBoxes.length - 1].height : 0;
  const within = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
  const ghostBox = !lifted ? undefined : lifted.kind === "row"
    ? (() => {
      const box = rowBoxes[lifted.from] ?? { top: 0, height: 0 };
      return { top: within(box.top + lifted.offset, -box.height / 2, tableHeight - box.height / 2), left: 0, width: total, height: box.height };
    })()
    : { top: 0, left: within(lefts[lifted.from] + lifted.offset, -widths[lifted.from] / 2, total - widths[lifted.from] / 2), width: widths[lifted.from], height: tableHeight };
  // While a row is moved, the table draws it where it would land.
  const shownRows = lifted?.kind === "row" ? reordered(grid.rows, lifted.from, lifted.to) : grid.rows;
  const shownColumns = lifted?.kind === "column" ? reordered(grid.columns, lifted.from, lifted.to) : grid.columns;
  /* The selection always swallows whole merged cells — paint and maths
     both read the expanded rectangle. */
  const selRect = expandedRect();
  const inSelected = (r: number, c: number) => Boolean(selRect)
    && r >= selRect!.row && r < selRect!.row + selRect!.rows
    && c >= selRect!.column && c < selRect!.column + selRect!.columns;
  const rangeBox = (() => {
    if (!selRect || lifted) return null;
    const first = rowBoxes[selRect.row];
    const last = rowBoxes[selRect.row + selRect.rows - 1];
    if (!first || !last) return null;
    return { top: first.top, left: lefts[selRect.column], width: lefts[selRect.column + selRect.columns] - lefts[selRect.column], height: last.top + last.height - first.top };
  })();

  return (
    <div
      className={`stbl ${readOnly ? "is-readonly" : ""}`}
      contentEditable={false}
      onMouseLeave={() => { if (!menu && !movingRef.current) setHover(null); }}
    >
      <div className="stbl__scroll">
        <div
          ref={frameRef}
          className="stbl__frame"
          tabIndex={-1}
          role="grid"
          aria-label="Table"
          aria-rowcount={grid.rows.length}
          aria-colcount={grid.columns.length}
          onKeyDown={onFrameKey}
          onCopy={(event) => onFrameCopy(event, false)}
          onCut={(event) => onFrameCopy(event, true)}
          onPaste={onFramePaste}
          onMouseMove={(event) => {
            const cell = (event.target as Element).closest<HTMLElement>("td[data-row-index]");
            // A drag selecting cells keeps no grips: following the pointer's
            // row, they would strobe along its edges as it went.
            if (!cell || menu || movingRef.current || pointer.current) return;
            const next = { row: Number(cell.dataset.rowIndex), column: Number(cell.dataset.columnIndex) };
            if (next.row !== hover?.row || next.column !== hover?.column) setHover(next);
          }}
        >
          <table
            className="stbl__table"
            style={{ width: total }}
            onPointerDown={onPointerDown}
            onContextMenu={(event) => {
              const cell = (event.target as Element).closest<HTMLElement>("td[data-row-index]");
              if (!cell || cell.closest(".stbl__table") !== event.currentTarget) return;
              event.preventDefault();
              const at = { row: Number(cell.dataset.rowIndex), column: Number(cell.dataset.columnIndex) };
              // Right-press on an unselected cell selects it; on the
              // selection it keeps it and just opens the menu.
              if (!inSelected(at.row, at.column)) selectCells({ anchor: at, focus: at });
              else frameRef.current?.focus({ preventScroll: true });
              setMenu({ kind: "cells", anchor: pointRect(event.clientX, event.clientY) });
            }}
          >
            <colgroup>
              {shownColumns.map((column) => <col key={column.id} style={{ width: widthOf(sizing?.columnId === column.id ? sizing.width : column.width) }} />)}
            </colgroup>
            <tbody>
              {shownRows.map((row, rowIndex) => (
                <tr
                  key={row.id}
                  className={lifted?.kind === "row" && lifted.id === row.id ? "is-moving" : undefined}
                >
                  {shownColumns.map((column, columnIndex) => {
                    // A cell a span swallowed draws nothing — its anchor
                    // grows over it instead (HTML's own colspan/rowspan).
                    if (isPhantom(grid, rowIndex, columnIndex)) return null;
                    const anchored = spanAnchorAt(grid, rowIndex, columnIndex);
                    return (
                    <td
                      key={column.id}
                      data-row-index={rowIndex}
                      data-column-index={columnIndex}
                      colSpan={anchored && anchored.span.columns > 1 ? anchored.span.columns : undefined}
                      rowSpan={anchored && anchored.span.rows > 1 ? anchored.span.rows : undefined}
                      className={[
                        "stbl__cell",
                        head(rowIndex, columnIndex) ? "is-head" : "",
                        anchored ? "is-merged" : "",
                        inSelected(rowIndex, columnIndex) ? "is-selected" : "",
                        lifted?.kind === "column" && lifted.id === column.id ? "is-moving" : "",
                      ].filter(Boolean).join(" ")}
                    >
                      <RichField
                        grammar={CELL_GRAMMAR}
                        content={row.cells[column.id] ?? EMPTY}
                        className="stbl__text"
                        label={`Row ${rowIndex + 1}, column ${columnIndex + 1}`}
                        placeholder=""
                        readOnly={readOnly}
                        historyField={`cell:${block.id}:${row.id}:${column.id}`}
                        collaboration={owningPageId ? { pageId: owningPageId, key: cellField(blockRecordId(owningPageId, block.id), row.id, column.id) } : undefined}
                        elementRef={(element) => {
                          const key = cellKey(row.id, column.id);
                          if (element) cells.current.set(key, element);
                          else cells.current.delete(key);
                        }}
                        onChange={(next) => write([writeCell(grid, row.id, column.id, next)])}
                        onKeyDown={(event) => onCellKey(event, { row: rowIndex, column: columnIndex })}
                        onPasteFirst={(event) => {
                          if (readOnly) return false;
                          const pasted = gridFromClipboard(event.clipboardData, false);
                          if (!pasted) return false;
                          event.preventDefault();
                          pasteAt({ row: rowIndex, column: columnIndex }, pasted);
                          return true;
                        }}
                        onFocus={() => { if (range) setRange(null); }}
                      />
                    </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>

          {/* Cells selected as cells: one blue outline around them all, as
              Notion draws it (each cell only tinted). */}
          {rangeBox ? <div className="stbl__range" style={rangeBox} aria-hidden="true" /> : null}

          {readOnly ? null : (
            <>
              {gripRow >= 0 && rowBoxes[gripRow] ? (
                <button
                  type="button"
                  className={`stbl__grip stbl__grip--row ${menuRowIndex === gripRow ? "is-active" : ""} ${lifted ? "is-held" : ""}`}
                  style={{ top: rowBoxes[gripRow].top + rowBoxes[gripRow].height / 2 }}
                  aria-label={`Row ${gripRow + 1} options`}
                  aria-haspopup="menu"
                  onPointerDown={(event) => gripDown(event, "row", gripRow)}
                  onPointerMove={gripMove}
                  onPointerUp={gripUp}
                  onPointerCancel={() => setMoving(null)}
                  onClick={(event) => {
                    if (dragged.current) {
                      dragged.current = false;
                      return;
                    }
                    openRowMenu(gripRow, rectOf(event.currentTarget));
                  }}
                >
                  <GripVertical size={12} />
                </button>
              ) : null}

              {gripColumn >= 0 ? (
                <button
                  type="button"
                  className={`stbl__grip stbl__grip--column ${menuColumnIndex === gripColumn ? "is-active" : ""} ${lifted ? "is-held" : ""}`}
                  style={{ left: lefts[gripColumn] + widths[gripColumn] / 2 }}
                  aria-label={`Column ${gripColumn + 1} options`}
                  aria-haspopup="menu"
                  onPointerDown={(event) => gripDown(event, "column", gripColumn)}
                  onPointerMove={gripMove}
                  onPointerUp={gripUp}
                  onPointerCancel={() => setMoving(null)}
                  onClick={(event) => {
                    if (dragged.current) {
                      dragged.current = false;
                      return;
                    }
                    openColumnMenu(gripColumn, rectOf(event.currentTarget));
                  }}
                >
                  <GripHorizontal size={12} />
                </button>
              ) : null}

              {/* The row (or column) lifted: a copy of it, outlined in blue,
                  following the pointer, over the place it would land — the
                  table makes way for it as it goes, as Notion's does. */}
              {lifted ? (
                <div className="stbl__ghost" style={ghostBox} aria-hidden="true">
                  <table className="stbl__table" style={{ width: lifted.kind === "row" ? total : widths[lifted.from] }}>
                    <colgroup>
                      {(lifted.kind === "row" ? widths : [widths[lifted.from]]).map((width, index) => <col key={index} style={{ width }} />)}
                    </colgroup>
                    <tbody>
                      {(lifted.kind === "row" ? [grid.rows[lifted.from]] : grid.rows).map((row, index) => {
                        const rowIndex = lifted.kind === "row" ? lifted.from : index;
                        return (
                          <tr key={row.id} style={{ height: rowBoxes[rowIndex]?.height }}>
                            {(lifted.kind === "row" ? grid.columns : [grid.columns[lifted.from]]).map((column, columnIndex) => (
                              <td key={column.id} className={`stbl__cell ${head(rowIndex, lifted.kind === "row" ? columnIndex : lifted.from) ? "is-head" : ""}`}>
                                <div className="title-field stbl__text" dangerouslySetInnerHTML={{ __html: CELL_GRAMMAR.html(row.cells[column.id] ?? EMPTY) }} />
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <span className={`stbl__grip stbl__grip--${lifted.kind} is-active`}>
                    {lifted.kind === "row" ? <GripVertical size={12} /> : <GripHorizontal size={12} />}
                  </span>
                </div>
              ) : null}

              {grid.columns.map((column, index) => (
                <div
                  key={column.id}
                  className={`stbl__resize ${sizing?.columnId === column.id ? "is-active" : ""}`}
                  style={{ left: lefts[index + 1] - 3 }}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize column ${index + 1}`}
                  onPointerDown={(event) => startResize(event, column.id, widths[index])}
                />
              ))}

              <Tooltip label="Add a row">
                <button
                  type="button"
                  className="stbl__add stbl__add--row"
                  style={{ width: total }}
                  aria-label="Add a row"
                  disabled={grid.rows.length >= MAX_TABLE_ROWS}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => addRow(grid.rows.length, 0)}
                >
                  <Plus size={14} />
                </button>
              </Tooltip>
              <Tooltip label="Add a column">
                <button
                  type="button"
                  className="stbl__add stbl__add--column"
                  style={{ left: total }}
                  aria-label="Add a column"
                  disabled={grid.columns.length >= MAX_TABLE_COLUMNS}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    const columnId = newId("column");
                    if (write(insertColumn(grid, grid.columns.length, columnId))) {
                      pending.current = { row: grid.rows[0].id, column: columnId, at: "start" };
                    }
                  }}
                >
                  <Plus size={14} />
                </button>
              </Tooltip>
            </>
          )}
        </div>
      </div>

      <Popover
        open={menu?.kind === "row" && menuRowIndex >= 0}
        anchor={menu?.kind === "row" ? menu.anchor : null}
        placement="right-start"
        label="Row"
        onDismiss={closeMenu}
      >
        {menuRowIndex >= 0 ? rowMenuItems(menuRowIndex) : <div />}
      </Popover>
      <Popover
        open={menu?.kind === "column" && menuColumnIndex >= 0}
        anchor={menu?.kind === "column" ? menu.anchor : null}
        placement="bottom-start"
        label="Column"
        onDismiss={closeMenu}
      >
        {menuColumnIndex >= 0 ? columnMenuItems(menuColumnIndex) : <div />}
      </Popover>

      {/* The cell menu — a right-press on cells selected as cells. */}
      <Popover
        open={menu?.kind === "cells"}
        anchor={menu?.kind === "cells" ? menu.anchor : null}
        placement="right-start"
        label="Cells"
        group="cells"
        onDismiss={closeMenu}
      >
        {menu?.kind === "cells" ? (
          <MenuList label="Cells" autoFocus>
            <MenuItem
              icon={<Combine size={16} />}
              label={selRect && selRect.rows * selRect.columns > 1 ? `Merge ${selRect.columns}×${selRect.rows} cells` : "Merge cells"}
              disabled={!selectionOps().mergeable}
              onSelect={() => { closeMenu(); mergeSelected(); }}
            />
            <MenuItem
              icon={<Ungroup size={16} />}
              label="Split cells"
              disabled={!selectionOps().splittable}
              onSelect={() => { closeMenu(); splitSelected(); }}
            />
            <MenuDivider />
            <MenuItem
              icon={<Eraser size={16} />}
              label="Clear contents"
              onSelect={() => { closeMenu(); clearSelected(); }}
            />
          </MenuList>
        ) : <div />}
      </Popover>

      {/* Cells selected as cells get their own little format bar — the same
          marks a text selection gets, plus colour, plus merge/split. It
          floats over the selection's top edge and never takes focus, so the
          blue range stays the selection. */}
      <Popover
        open={Boolean(range) && !readOnly && !menu && !lifted}
        anchor={rangeBox ? { top: tableAbsTop + rangeBox.top, left: tableAbsLeft + rangeBox.left, bottom: tableAbsTop + rangeBox.top + rangeBox.height, right: tableAbsLeft + rangeBox.left + rangeBox.width, width: rangeBox.width, height: rangeBox.height } : null}
        placement="top-start"
        role="toolbar"
        label="Cell format"
        group="cells"
        closeOnScroll={false}
        onDismiss={(reason) => { if (reason === "escape") setColorOpen(false); }}
      >
        <div className="format-bar" onPointerDown={(event) => event.preventDefault()}>
          <div className="format-bar__group">
            <Tooltip label="Merge cells">
              <button type="button" className="icon-btn" aria-label="Merge cells" disabled={!selectionOps().mergeable} onClick={mergeSelected}>
                <Combine size={16} />
              </button>
            </Tooltip>
            <Tooltip label="Split cells">
              <button type="button" className="icon-btn" aria-label="Split cells" disabled={!selectionOps().splittable} onClick={splitSelected}>
                <Ungroup size={16} />
              </button>
            </Tooltip>
          </div>
          <div className="format-bar__group">
            {MARKS.map((item) => (
              <Tooltip key={item.mark} label={item.label} hint={`⌘${item.shift ? "⇧" : ""}${item.key.toUpperCase()}`}>
                <button
                  type="button"
                  className={`icon-btn ${markShared(item.mark) ? "is-on" : ""}`}
                  aria-label={item.label}
                  onClick={() => toggleSelectedMark(item.mark)}
                >
                  <item.icon size={16} />
                </button>
              </Tooltip>
            ))}
          </div>
          <div className="format-bar__group">
            <Tooltip label="Color">
              <button
                type="button"
                ref={colorBtnRef}
                className="format-bar__turn format-bar__color"
                data-color={selectedColor()}
                aria-label="Text color"
                onClick={() => setColorOpen((open) => !open)}
              >
                <Baseline size={16} />
                <ChevronDown size={12} />
              </button>
            </Tooltip>
          </div>
        </div>
      </Popover>
      <Popover
        open={colorOpen && Boolean(range)}
        anchor={colorBtnRef.current ? rectOf(colorBtnRef.current) : null}
        placement="bottom-start"
        label="Color"
        group="cells"
        closeOnScroll={false}
        onDismiss={() => setColorOpen(false)}
      >
        <ColorMenu current={selectedColor()} autoFocus={false} onPick={(color) => { applyColorToSelected(color); setColorOpen(false); }} />
      </Popover>
    </div>
  );
});
