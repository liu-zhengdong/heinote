import { caretPointNear, editableWithin, rowNear, rowsWithin } from "./selection";

/* Where something carried lands, as Google Docs places a picture: among a
   line's words, at the gap between two of them nearest the pointer; or, on
   the edge between two lines, on a line of its own there (`inside`: one step
   in, under the line before). Where it would land is marked, and nothing on
   the page moves until it is let go: a cursor among the words, or a line
   between lines, that glides from place to place as the pointer moves. */

export type Spot =
  | { kind: "words"; blockId: string; offset: number }
  | { kind: "line"; blockId: string; edge: "before" | "after"; inside?: boolean };

/** How near a line's top or bottom the pointer means the edge between lines. */
const EDGE = 8;

/** A place words break: a space, a picture or mention, or a CJK character,
 *  each of which is a word of its own. */
const BREAK = /[\s\u2063\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/;

/** The gap between words nearest `offset` in `text`. */
function wordGap(text: string, offset: number): number {
  const isGap = (at: number) => at <= 0 || at >= text.length || BREAK.test(text[at - 1]) || BREAK.test(text[at]);
  for (let step = 0; step <= text.length; step += 1) {
    if (isGap(offset - step)) return Math.max(0, offset - step);
    if (isGap(offset + step)) return Math.min(text.length, offset + step);
  }
  return offset;
}

/** A line being carried, which nothing lands beside. */
const carried = (row: HTMLElement) => "carried" in row.dataset;

/** Where the pointer at `x`, `y` lands among `root`'s own lines. `words`:
 *  whether what is carried may stand among words (pictures may; a file or a
 *  line is a line of its own). */
export function landingAt(root: HTMLElement, x: number, y: number, words: boolean): Spot | null {
  const row = rowNear(root, y, carried);
  const blockId = row?.dataset.blockId;
  const box = row?.querySelector(":scope > :is(.block__content, .mount, .db-frame)")?.getBoundingClientRect();
  if (!row || !blockId || !box) return null;
  const editable = editableWithin(root, blockId);
  // A file's caption is words, but its line is the file.
  const wordy = words && editable && !row.querySelector(":scope > .block__content > .block__media");
  if (!wordy || y < box.top + EDGE || y > box.bottom - EDGE) {
    return betweenLines(root, row, y < box.top + box.height / 2 ? "before" : "after", x);
  }
  const point = caretPointNear(root, x, y);
  if (!point || point.blockId !== blockId) return { kind: "line", blockId, edge: "after" };
  const range = document.createRange();
  range.setStart(editable, 0);
  range.setEnd(point.node, point.offset);
  return { kind: "words", blockId, offset: wordGap(editable.textContent ?? "", range.toString().length) };
}

/** A list's item: what lands just under it, in line with its words, is its. */
const LIST_ITEM = ".block:is(.block--bullet, .block--numbered, .block--todo)";

/** Where the edge `edge` of `row` lands, the pointer at `x`: under the line
 *  above the edge — the item of a list, when it is one and the pointer is
 *  in line with its words, as Google Docs and Notion keep a picture in a
 *  list item; out past its bullet, outside it. Any other line above, in
 *  line with the pointer, is joined where it stands — among an item's
 *  lines, when it is one of them. */
function betweenLines(root: HTMLElement, row: HTMLElement, edge: "before" | "after", x: number): Spot {
  const rows = rowsWithin(root).filter((candidate) => !carried(candidate));
  const above = edge === "after" ? row : rows[rows.indexOf(row) - 1];
  const words = above ? editableWithin(root, above.dataset.blockId ?? "") : null;
  if (above?.matches(LIST_ITEM) && words && x >= words.getBoundingClientRect().left - 4) {
    return { kind: "line", blockId: above.dataset.blockId ?? "", edge: "after", inside: true };
  }
  const start = above?.querySelector(":scope > :is(.block__content, .mount, .db-frame)")?.getBoundingClientRect().left;
  if (above && edge === "before" && start !== undefined && x >= start - 4) {
    return { kind: "line", blockId: above.dataset.blockId ?? "", edge: "after" };
  }
  return { kind: "line", blockId: row.dataset.blockId ?? "", edge };
}

export function sameSpot(left: Spot | null, right: Spot | null): boolean {
  if (!left || !right) return left === right;
  if (left.kind === "words" || right.kind === "words") {
    return left.kind === "words" && right.kind === "words" && left.blockId === right.blockId && left.offset === right.offset;
  }
  return left.blockId === right.blockId && left.edge === right.edge && Boolean(left.inside) === Boolean(right.inside);
}

/** Where the caret `offset` characters into `editable` is drawn: before a
 *  picture or mention, its height; among words, the line's. */
function caretAt(editable: HTMLElement, offset: number): { left: number; top: number; height: number } {
  let left = offset;
  const range = editable.ownerDocument.createRange();
  let before: HTMLElement | null = null;
  const walk = (node: Node): boolean => {
    for (const child of node.childNodes) {
      if (child instanceof HTMLElement && child.classList.contains("mention")) {
        if (left === 0) {
          before = child;
          return true;
        }
        left -= 1;
      } else if (child.nodeType === Node.TEXT_NODE) {
        const length = (child as Text).length;
        if (left <= length) {
          range.setStart(child, left);
          return true;
        }
        left -= length;
      } else if (walk(child)) {
        return true;
      }
    }
    return false;
  };
  const line = parseFloat(getComputedStyle(editable).lineHeight) || 24;
  if (walk(editable) && !before) {
    range.collapse(true);
    const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    if (rect.height) return { left: rect.left, top: rect.top, height: rect.height };
  }
  const token = before as HTMLElement | null;
  if (token) {
    const box = token.getBoundingClientRect();
    return { left: box.left - 3, top: box.top, height: box.height };
  }
  // An empty line, or the end of one: where its words would start or end.
  const box = editable.getBoundingClientRect();
  return { left: offset ? box.right : box.left, top: box.top, height: Math.min(line, box.height || line) };
}

const rowOf = (root: HTMLElement, blockId: string) => root.querySelector<HTMLElement>(`.block[data-block-id="${CSS.escape(blockId)}"]`);

/** The one mark of where things land, made once per window. */
function marker(root: HTMLElement): HTMLElement {
  const document = root.ownerDocument;
  let mark = document.querySelector<HTMLElement>(".drop-marker");
  if (!mark) {
    mark = document.createElement("div");
    mark.className = "drop-marker";
    document.body.append(mark);
  }
  return mark;
}

/** Marks where `spot` is under `root` — gliding there from where it was —
 *  or hides the mark for none. */
export function showMarker(root: HTMLElement, spot: Spot | null): void {
  const mark = marker(root);
  const place = spot ? markOf(root, spot) : null;
  if (!place) {
    hideMarker(root);
    return;
  }
  const appearing = !mark.classList.contains("is-shown");
  mark.classList.toggle("is-line", place.line);
  // Appearing, it is put in place before it is shown: it glides only between
  // places, never in from wherever it last was.
  if (appearing) mark.style.transition = "none";
  mark.style.transform = `translate(${place.left}px, ${place.top}px)`;
  mark.style.width = `${place.width}px`;
  mark.style.height = `${place.height}px`;
  if (appearing) {
    void mark.offsetWidth;
    mark.style.removeProperty("transition");
  }
  mark.classList.add("is-shown");
}

export function hideMarker(root: HTMLElement): void {
  root.ownerDocument.querySelector(".drop-marker")?.classList.remove("is-shown");
}

/** Where the mark for `spot` stands: a cursor's place among the words, or a
 *  line's across the column. */
function markOf(root: HTMLElement, spot: Spot): { left: number; top: number; width: number; height: number; line: boolean } | null {
  const row = rowOf(root, spot.blockId);
  if (!row) return null;
  if (spot.kind === "words") {
    const editable = editableWithin(root, spot.blockId);
    if (!editable) return null;
    const caret = caretAt(editable, spot.offset);
    return { left: caret.left - 1, top: caret.top, width: 3, height: caret.height, line: false };
  }
  const box = row.querySelector(":scope > :is(.block__content, .mount, .db-frame)")?.getBoundingClientRect() ?? row.getBoundingClientRect();
  // Nested under a list item, it starts where the item's own lines do: one
  // step in, past its bullet.
  const indent = spot.inside ? parseFloat(getComputedStyle(row).getPropertyValue("--indent")) || 26 : 0;
  const left = box.left + indent + (spot.inside ? 2 : 0);
  const top = spot.edge === "before" ? box.top - 2 : box.bottom;
  return { left, top, width: Math.max(24, box.right - left), height: 2, line: true };
}

/** Where the mark stands now, for what is let go to settle into. */
export function markerRect(root: HTMLElement): DOMRect | null {
  const mark = root.ownerDocument.querySelector<HTMLElement>(".drop-marker.is-shown");
  return mark ? mark.getBoundingClientRect() : null;
}
