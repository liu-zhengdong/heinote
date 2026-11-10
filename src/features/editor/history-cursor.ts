/* Where the caret is, in terms undo can keep — and putting it back there.

   A caret is read from the DOM at the moment something happens (a key, a
   press, a paste) and kept with the step that follows, so undo can return the
   person to the exact place a change was made: the offset in a block, a
   selection across blocks, a block selected as a whole, or a position in a
   field that writes the page as you type — a title, a row's name, a property.

   Such a field says what it is with `data-history-field`; the page it belongs
   to is the nearest `data-page-id`, on the field itself or around it (a table
   row, a card, the document). Those fields take ⌘Z from the history. Every
   other text field — a search box, a link being typed, a rename that has not
   been saved yet — keeps the browser's own undo, because its text is not in
   the document until it is committed. */

import type { HistoryCursor, HistoryFocus } from "../../core/workspace-history";
import { focusRange, selectedBlockRanges, selectionOffsets, selectRanges } from "./selection";

/** Dispatched on a block row, with block ids as its detail, to have the
 *  editor select those blocks as blocks. */
export const SELECT_BLOCK_EVENT = "notes:select-block";
/** Dispatched on the window after undo or redo has rewritten the document:
 *  a menu opened on the text as it was — the slash menu, a block's menu —
 *  would act on text that is no longer there. */
export const HISTORY_REPLAY_EVENT = "notes:history-replay";

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "url", "email", "tel", "password", "number"]);

function pageIdOf(element: Element): string | null {
  return element.closest<HTMLElement>("[data-page-id]")?.dataset.pageId ?? null;
}

/** A field of plain words with a caret of its own: a one-line text field, or
 *  a textarea (a Text property, whose words wrap). */
function isTextInput(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  return element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(element.type));
}

/** A field whose text is its own until it is committed keeps the browser's
 *  undo; the document's fields and blocks take the history's. */
export function keepsNativeUndo(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.closest(".block__editable, [data-history-field]")) return false;
  return isTextInput(element) || element.isContentEditable;
}

function readFocus(): HistoryFocus | null {
  const active = document.activeElement;

  if (active instanceof HTMLElement && active.dataset.historyField) {
    const pageId = pageIdOf(active);
    if (!pageId) return null;
    // A text field's caret, or a name's — a line of words that can carry links.
    const input = isTextInput(active) ? active : null;
    const words = !input && active.isContentEditable ? selectionOffsets(active) : null;
    return {
      kind: "field",
      pageId,
      field: active.dataset.historyField,
      start: input?.selectionStart ?? (words ? Math.min(words.start, words.end) : 0),
      end: input?.selectionEnd ?? (words ? Math.max(words.start, words.end) : 0),
      peek: Boolean(active.closest(".side-peek")),
    };
  }

  const selection = window.getSelection();
  const anchor = selection?.rangeCount ? selection.anchorNode : null;
  const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement;
  const blocks = anchorElement?.closest<HTMLElement>(".blocks");
  if (selection && blocks && active && blocks.contains(active)) {
    const pageId = pageIdOf(blocks);
    const editable = anchorElement?.closest<HTMLElement>(".block__editable");
    const blockId = editable?.closest<HTMLElement>("[data-block-id]")?.dataset.blockId;
    if (pageId && editable && blockId) {
      const within = editable.contains(selection.focusNode);
      if (!within) {
        const ranges = selectedBlockRanges(blocks);
        if (ranges.length) return { kind: "text", pageId, ranges };
      }
      const offsets = selectionOffsets(editable);
      if (offsets) {
        const start = Math.min(offsets.start, offsets.end);
        const end = Math.max(offsets.start, offsets.end);
        return { kind: "text", pageId, ranges: [{ blockId, start, end }] };
      }
    }
  }

  const selected = [...document.querySelectorAll<HTMLElement>(".block.is-selected[data-block-id]")];
  const selectedPage = selected[0] ? pageIdOf(selected[0]) : null;
  if (selected.length && selectedPage) {
    return { kind: "blocks", pageId: selectedPage, blockIds: selected.map((row) => row.dataset.blockId ?? "").filter(Boolean) };
  }
  return null;
}

export function readHistoryCursor(view: string): HistoryCursor {
  return { view, focus: readFocus() };
}

function reveal(element: Element): void {
  element.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Puts the caret back where a cursor says. False when the place is not on
 *  screen — a block folded onto its row, a closed peek — or the cursor had
 *  none. */
export function restoreHistoryCursor(cursor: HistoryCursor | null): boolean {
  const focus = cursor?.focus;
  if (!focus) return false;

  if (focus.kind === "text") {
    const start = selectRanges(null, focus.ranges);
    if (!start) return false;
    reveal(start);
    return true;
  }

  if (focus.kind === "field") {
    const fields = [...document.querySelectorAll<HTMLElement>(`[data-history-field="${CSS.escape(focus.field)}"]`)]
      .filter((field) => pageIdOf(field) === focus.pageId);
    const field = fields.find((item) => Boolean(item.closest(".side-peek")) === focus.peek) ?? fields[0];
    if (!field) return false;
    field.focus({ preventScroll: true });
    if (isTextInput(field) && field.type !== "number") {
      const length = field.value.length;
      field.setSelectionRange(Math.min(focus.start, length), Math.min(focus.end, length));
    } else if (field.isContentEditable) {
      const length = field.textContent?.length ?? 0;
      focusRange(field, Math.min(focus.start, length), Math.min(focus.end, length));
    }
    reveal(field);
    return true;
  }

  const row = focus.blockIds[0]
    ? document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(focus.blockIds[0])}"]`)
    : null;
  if (!row) return false;
  row.dispatchEvent(new CustomEvent(SELECT_BLOCK_EVENT, { bubbles: true, detail: focus.blockIds }));
  reveal(row);
  return true;
}

/** Brings the topmost changed block that is on screen into view — what undo
 *  does when the change was made without a caret, from a menu or a handle. */
export function revealBlocks(blockIds: readonly string[]): void {
  const rows = blockIds
    .map((id) => document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`))
    .filter((row): row is HTMLElement => Boolean(row));
  const top = rows.reduce<HTMLElement | null>((first, row) => (
    !first || first.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_PRECEDING ? row : first
  ), null);
  if (top) reveal(top);
}
