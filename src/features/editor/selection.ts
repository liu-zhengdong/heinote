/** Caret and selection helpers.
 *
 * Every block is its own `contenteditable`, so the editor constantly has to
 * translate between DOM ranges and plain-text offsets into a block's inline
 * content. Native browser dragging stops at an editing-host boundary; the
 * cross-block helpers below bridge those hosts while keeping each block's DOM
 * ownership isolated. */

import type { TextPoint } from "../../core/types";

export interface BlockTextRange {
  blockId: string;
  start: number;
  end: number;
}

/** Text to select again once a change is drawn — across blocks, as it was.
 *  `forceIds` are the blocks to redraw even though they hold the caret. */
export type PendingTextSelection = { ranges: BlockTextRange[]; forceIds: string[] };

export interface DomCaretPoint {
  node: Node;
  offset: number;
  blockId: string;
}

/** Whether an editable belongs to this editor, and not to a block shown in it
 *  from another page (which has an editor, and its own `.blocks`, of its own). */
function ownedBy(root: HTMLElement, editable: Element): boolean {
  return editable.closest(".blocks") === root;
}

/** A block's editable within one editor. The same block can be on screen
 *  twice — on its page and shown in place in another — so an editor only
 *  ever looks among its own. */
export function editableWithin(root: HTMLElement | null, blockId: string): HTMLElement | null {
  if (!root) return null;
  for (const editable of root.querySelectorAll<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"] .block__editable`)) {
    if (ownedBy(root, editable)) return editable;
  }
  return null;
}

/** Selects text in blocks again — a caret, or a selection across blocks —
 *  among `root`'s own blocks, or anywhere on the page when the place's editor
 *  is not known (`null`). Answers the first block's editable, or null when a
 *  block is not on screen. */
export function selectRanges(root: HTMLElement | null, ranges: readonly BlockTextRange[]): HTMLElement | null {
  const editable = (blockId: string) => (root
    ? editableWithin(root, blockId)
    : document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"] .block__editable`));
  const first = ranges[0];
  const last = ranges.at(-1);
  const start = first ? editable(first.blockId) : null;
  const end = last ? editable(last.blockId) : null;
  if (!first || !last || !start || !end) return null;
  if (start === end) focusRange(start, first.start, last.end);
  else focusBlockRange(start, first.start, end, last.end);
  return start;
}

/** An editor's own rows, in reading order. */
export function rowsWithin(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>(".block[data-block-id]")].filter((row) => ownedBy(root, row));
}

/** The line of `root`'s own under a height on screen: the one drawn there,
 *  or the nearest above or below it — leaving out any `skip` says to (lines
 *  being carried). */
export function rowNear(root: HTMLElement, y: number, skip?: (row: HTMLElement) => boolean): HTMLElement | null {
  let nearest: HTMLElement | null = null;
  let distance = Infinity;
  for (const row of rowsWithin(root)) {
    if (skip?.(row)) continue;
    const box = row.querySelector(":scope > :is(.block__content, .mount, .db-frame)")?.getBoundingClientRect();
    if (!box) continue;
    const gap = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
    if (gap < distance) {
      nearest = row;
      distance = gap;
      if (!gap) break;
    }
  }
  return nearest;
}

function textLength(element: HTMLElement): number {
  return element.textContent?.length ?? 0;
}

/** The mention a text node is the one character of, if it is one. A caret is
 *  never put inside one: the token is stepped over whole. */
function mentionOf(node: Node): HTMLElement | null {
  return node.parentElement?.closest<HTMLElement>(".mention") ?? null;
}

function rangeToOffset(element: HTMLElement, container: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.setEnd(container, offset);
  return range.toString().length;
}

function editableFromNode(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>(".block__editable") ?? null;
}

function blockIdForEditable(element: HTMLElement | null): string | null {
  return element?.closest<HTMLElement>("[data-block-id]")?.dataset.blockId ?? null;
}

export function caretOffset(element: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !element.contains(selection.anchorNode)) return textLength(element);
  const range = selection.getRangeAt(0);
  return rangeToOffset(element, range.endContainer, range.endOffset);
}

export function selectionOffsets(element: HTMLElement): { start: number; end: number } | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
  return {
    start: rangeToOffset(element, range.startContainer, range.startOffset),
    end: rangeToOffset(element, range.endContainer, range.endOffset),
  };
}

/** Returns every editable block touched by the current DOM selection, in
 * document order. This is the model-facing equivalent of Notion's continuous
 * blue selection across paragraphs and list items. */
export function selectedBlockRanges(root: HTMLElement): BlockTextRange[] {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return [];
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return [];
  const ranges: BlockTextRange[] = [];
  for (const editable of root.querySelectorAll<HTMLElement>(".block__editable")) {
    if (!ownedBy(root, editable)) continue;
    let intersects = false;
    try {
      intersects = range.intersectsNode(editable);
    } catch {
      intersects = false;
    }
    if (!intersects) continue;
    const blockId = blockIdForEditable(editable);
    if (!blockId) continue;
    const start = editable.contains(range.startContainer)
      ? rangeToOffset(editable, range.startContainer, range.startOffset)
      : 0;
    const end = editable.contains(range.endContainer)
      ? rangeToOffset(editable, range.endContainer, range.endOffset)
      : textLength(editable);
    if (start !== end) ranges.push({ blockId, start: Math.min(start, end), end: Math.max(start, end) });
  }
  return ranges;
}

function nearestCaretInEditable(element: HTMLElement, x: number, y: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node = walker.nextNode();
  let best: { node: Node; offset: number; distance: number } | null = null;
  while (node) {
    if (mentionOf(node)) {
      node = walker.nextNode();
      continue;
    }
    const length = node.textContent?.length ?? 0;
    for (let offset = 0; offset < length; offset += 1) {
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      const caretOffset = x < rect.left + rect.width / 2 ? offset : offset + 1;
      const horizontal = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
      const vertical = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
      const distance = horizontal * horizontal + vertical * vertical;
      if (!best || distance < best.distance) best = { node, offset: caretOffset, distance };
      if (!distance) return { node, offset: caretOffset };
    }
    node = walker.nextNode();
  }
  return best ? { node: best.node, offset: best.offset } : { node: element, offset: 0 };
}

/** Finds a text caret under the pointer, restricted to this editor. */
export function caretPointFromViewport(root: HTMLElement, x: number, y: number): DomCaretPoint | null {
  let node: Node | null = null;
  let offset = 0;
  const position = document.caretPositionFromPoint?.(x, y);
  if (position) {
    node = position.offsetNode;
    offset = position.offset;
  } else {
    const legacy = (document as Document & {
      caretRangeFromPoint?(left: number, top: number): Range | null;
    }).caretRangeFromPoint?.(x, y);
    if (legacy) {
      node = legacy.startContainer;
      offset = legacy.startOffset;
    }
  }
  let editable = editableFromNode(node);
  // Chromium-based embedded browsers do not consistently expose either caret
  // hit-test API. Element hit-testing plus character rects gives the same
  // result without depending on those optional APIs.
  if (!editable) {
    editable = document.elementFromPoint(x, y)?.closest<HTMLElement>(".block__editable") ?? null;
    if (editable) {
      const nearest = nearestCaretInEditable(editable, x, y);
      node = nearest.node;
      offset = nearest.offset;
    }
  }
  const blockId = blockIdForEditable(editable);
  if (!node || !editable || !blockId || !ownedBy(root, editable)) return null;
  return { node, offset, blockId };
}

/** The caret a drag-selection should reach for, wherever the pointer is. Over
 *  text it is the text under it; between blocks, beside a short line, above
 *  the first block or below the last, it is the nearest block's line at the
 *  pointer's height — so the selection keeps up with the pointer instead of
 *  freezing whenever it crosses a gap. */
export function caretPointNear(root: HTMLElement, x: number, y: number): DomCaretPoint | null {
  const direct = caretPointFromViewport(root, x, y);
  if (direct) return direct;
  let nearest: HTMLElement | null = null;
  let distance = Infinity;
  for (const editable of root.querySelectorAll<HTMLElement>(".block__editable")) {
    if (!ownedBy(root, editable)) continue;
    const bounds = editable.getBoundingClientRect();
    const gap = y < bounds.top ? bounds.top - y : y > bounds.bottom ? y - bounds.bottom : 0;
    if (gap < distance) {
      nearest = editable;
      distance = gap;
      if (!gap) break;
    }
  }
  const blockId = blockIdForEditable(nearest);
  if (!nearest || !blockId) return null;
  const bounds = nearest.getBoundingClientRect();
  const inside = caretPointFromViewport(
    root,
    Math.min(Math.max(x, bounds.left + 1), bounds.right - 1),
    Math.min(Math.max(y, bounds.top + 2), bounds.bottom - 2),
  );
  if (inside) return inside;
  const edge = positionAt(nearest, y < bounds.top ? 0 : textLength(nearest));
  return { node: edge.node, offset: edge.offset, blockId };
}

/** Extends a DOM selection across independent editing hosts. */
export function selectBetweenPoints(start: DomCaretPoint, end: DomCaretPoint): void {
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.collapse(start.node, start.offset);
  selection.extend(end.node, end.offset);
}

/** Walks the text nodes to find the DOM position for a plain-text offset. */
function positionAt(element: HTMLElement, offset: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let node = walker.nextNode();
  let last: Node | null = null;
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      const mention = mentionOf(node);
      if (!mention?.parentNode) return { node, offset: remaining };
      // Before the token when nothing comes before it, after it otherwise.
      const index = [...mention.parentNode.childNodes].indexOf(mention);
      return { node: mention.parentNode, offset: remaining === 0 ? index : index + 1 };
    }
    remaining -= length;
    last = node;
    node = walker.nextNode();
  }
  if (last) {
    const mention = mentionOf(last);
    if (mention?.parentNode) return { node: mention.parentNode, offset: [...mention.parentNode.childNodes].indexOf(mention) + 1 };
    return { node: last, offset: last.textContent?.length ?? 0 };
  }
  return { node: element, offset: 0 };
}

export function focusRange(element: HTMLElement, start: number, end = start): void {
  element.focus({ preventScroll: true });
  const selection = window.getSelection();
  if (!selection) return;
  const from = positionAt(element, start);
  const to = positionAt(element, end);
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Restores a model range after React has rendered formatting changes in more
 * than one block. */
export function focusBlockRange(
  startElement: HTMLElement,
  start: number,
  endElement: HTMLElement,
  end: number,
): void {
  startElement.focus({ preventScroll: true });
  const selection = window.getSelection();
  if (!selection) return;
  const from = positionAt(startElement, start);
  const to = positionAt(endElement, end);
  selection.removeAllRanges();
  selection.collapse(from.node, from.offset);
  selection.extend(to.node, to.offset);
}

export function focusAtEnd(element: HTMLElement): void {
  focusRange(element, textLength(element));
}

function collapsedRect(element: HTMLElement, offset: number): DOMRect | null {
  const position = positionAt(element, offset);
  const range = document.createRange();
  range.setStart(position.node, position.offset);
  range.collapse(true);
  const rect = range.getBoundingClientRect();
  if (rect.width || rect.height || rect.top) return rect;
  // A collapsed range inside an empty element reports nothing useful.
  return element.getBoundingClientRect();
}

/** The page's selection as places in blocks' text, in whichever editor it
 *  is, or null when either end is outside a block's text. */
export function selectionPoints(): { anchor: TextPoint; focus: TextPoint } | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.anchorNode || !selection.focusNode) return null;
  const point = (node: Node, offset: number): TextPoint | null => {
    const editable = editableFromNode(node);
    const blockId = blockIdForEditable(editable);
    return editable && blockId ? { blockId, offset: rangeToOffset(editable, node, offset) } : null;
  };
  const anchor = point(selection.anchorNode, selection.anchorOffset);
  const focus = point(selection.focusNode, selection.focusOffset);
  return anchor && focus ? { anchor, focus } : null;
}

/** Where a place in `root`'s own blocks is drawn, as a caret's rect, or null
 *  when its block is not drawn there. */
export function pointRect(root: HTMLElement, point: TextPoint): DOMRect | null {
  const editable = editableWithin(root, point.blockId);
  return editable ? collapsedRect(editable, point.offset) : null;
}

/** The rects of the text between two places in `root`'s own blocks, whichever
 *  comes first: none when either block is not drawn there. */
export function rangeRects(root: HTMLElement, a: TextPoint, b: TextPoint): DOMRect[] {
  const from = editableWithin(root, a.blockId);
  const to = editableWithin(root, b.blockId);
  if (!from || !to) return [];
  const start = positionAt(from, a.offset);
  const end = positionAt(to, b.offset);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  // An end before the start collapses the range onto it: the other way round.
  if (range.collapsed) {
    range.setStart(end.node, end.offset);
    range.setEnd(start.node, start.offset);
  }
  return [...range.getClientRects()];
}

export function caretRect(element: HTMLElement): DOMRect | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !element.contains(selection.anchorNode)) return null;
  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(false);
  const rect = range.getBoundingClientRect();
  if (rect.width || rect.height || rect.top) return rect;
  return collapsedRect(element, caretOffset(element));
}

const LINE_TOLERANCE = 4;

/** Arrow keys only leave a block from its first or last visual line, so a
 *  wrapped paragraph still navigates line by line inside itself. */
export function caretOnFirstLine(element: HTMLElement): boolean {
  const caret = caretRect(element);
  const first = collapsedRect(element, 0);
  if (!caret || !first) return true;
  return caret.top - first.top < LINE_TOLERANCE;
}

export function caretOnLastLine(element: HTMLElement): boolean {
  const caret = caretRect(element);
  const last = collapsedRect(element, textLength(element));
  if (!caret || !last) return true;
  return last.bottom - caret.bottom < LINE_TOLERANCE;
}

/** Enters a block from above or below at the horizontal position the caret was
 *  already holding, so moving down a column of paragraphs keeps a straight
 *  line instead of snapping to the start of each one. */
export function placeCaretNear(element: HTMLElement, x: number, edge: "top" | "bottom"): void {
  element.focus({ preventScroll: true });
  const bounds = element.getBoundingClientRect();
  const y = edge === "top" ? bounds.top + 4 : bounds.bottom - 4;
  const clampedX = Math.min(Math.max(x, bounds.left + 1), bounds.right - 1);
  const caret = document.caretPositionFromPoint?.(clampedX, y);
  const selection = window.getSelection();
  if (!selection) return;
  if (caret && element.contains(caret.offsetNode)) {
    const range = document.createRange();
    range.setStart(caret.offsetNode, caret.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
  focusRange(element, edge === "top" ? 0 : textLength(element));
}

export function selectionRect(): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  return rect.width || rect.height ? rect : null;
}
