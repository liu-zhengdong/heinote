import { useEffect } from "react";
import { createId } from "../../core/ids";
import { imeComposing } from "../../core/keyboard";
import { createBlock, orderedBlocks } from "../../core/block-tree";
import { inlineFromText } from "../../core/inline-content";
import { writeBlocks, type CopiedBlocks } from "./block-clipboard";
import {
  checkLines,
  extractFragment,
  indentBlocks,
  insertFragmentAfter,
  outdentBlocks,
  shiftBlocks,
  topLevelBlocks,
} from "./editor-commands";
import { editableWithin, focusAtEnd } from "./selection";
import type { Editor } from "./editor-state";

/** Keys pressed while blocks are selected as blocks, as in Notion: the
 *  arrows move or grow the selection, Enter edits, Delete and Backspace
 *  delete, ⌘C/⌘X/⌘V copy, cut and paste them whole, ⌘D duplicates, Tab
 *  and Shift+Tab indent, ⌘⇧↑/↓ move them, Escape lets go. */
export function useSelectedBlockKeys(editor: Editor): void {
  const {
    page, readOnly, tree, rows, blocksRef, blockSelection, setBlockSelection, selectedIds, setBlockMenu,
    executeOnBlocks, titleOf, deleteSelected, duplicateSelected, openMoveTo, anchorFor, pastedBlocks, adoptCutPages,
  } = editor;
  useEffect(() => {
    if (!blockSelection || readOnly || !selectedIds.length) return;
    const typing = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      return Boolean(element?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element?.tagName ?? ""));
    };
    const reveal = (blockId: string) => {
      blocksRef.current?.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`)?.scrollIntoView({ block: "nearest" });
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      // Selected blocks own the keyboard only while nothing else is taking
      // typing or menu keys — Backspace in the title must not delete blocks.
      if (imeComposing(event) || typing(event.target) || (event.target as Element | null)?.closest?.(".pop")) return;
      const meta = event.metaKey || event.ctrlKey;
      const key = event.key;
      const first = rows.findIndex((row) => row.block.id === selectedIds[0]);
      const last = rows.findIndex((row) => row.block.id === selectedIds.at(-1));
      if (key === "Escape") {
        // Not claimed: in the side peek, the same Escape also closes the
        // page, as SidePeek promises — the selection goes with it.
        setBlockSelection(null);
        return;
      }
      if (key === "ArrowUp" || key === "ArrowDown") {
        event.preventDefault();
        const down = key === "ArrowDown";
        if (meta && event.shiftKey) {
          executeOnBlocks(shiftBlocks(tree, selectedIds, down ? 1 : -1));
          return;
        }
        if (event.shiftKey) {
          const at = rows.findIndex((row) => row.block.id === blockSelection.focus);
          const next = rows[at + (down ? 1 : -1)];
          if (next) {
            setBlockSelection({ anchor: blockSelection.anchor, focus: next.block.id });
            reveal(next.block.id);
          }
          return;
        }
        const next = down ? rows[last + 1] ?? rows[last] : rows[first - 1] ?? rows[first];
        if (next) {
          setBlockSelection({ anchor: next.block.id, focus: next.block.id });
          reveal(next.block.id);
        }
        return;
      }
      // ⌘Enter: bulleted lines become to-dos, to-dos are ticked (checkLines).
      if (key === "Enter" && meta && !event.shiftKey) {
        const checked = checkLines(tree, selectedIds);
        if (checked) {
          event.preventDefault();
          executeOnBlocks(checked);
        }
        return;
      }
      if (key === "Enter" && !meta) {
        event.preventDefault();
        const element = editableWithin(blocksRef.current, blockSelection.focus);
        setBlockSelection(null);
        if (element) focusAtEnd(element);
        return;
      }
      if (key === "Backspace" || key === "Delete") {
        event.preventDefault();
        deleteSelected(selectedIds);
        return;
      }
      if (key === "Tab") {
        event.preventDefault();
        executeOnBlocks(event.shiftKey ? outdentBlocks(tree, selectedIds) : indentBlocks(tree, selectedIds));
        return;
      }
      if (!meta) return;
      const shortcut = key.toLowerCase();
      if (shortcut === "d") {
        event.preventDefault();
        duplicateSelected(selectedIds);
      } else if (shortcut === "a") {
        event.preventDefault();
        const lastRow = rows.at(-1);
        if (lastRow) setBlockSelection({ anchor: rows[0].block.id, focus: lastRow.block.id });
      } else if (shortcut === "p" && event.shiftKey) {
        event.preventDefault();
        openMoveTo(selectedIds);
      } else if (key === "/") {
        // ⌘/ opens the block menu for the selection, as in Notion.
        event.preventDefault();
        const anchor = anchorFor(selectedIds[0]);
        if (anchor) setBlockMenu({ ids: [...selectedIds], anchor });
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      // A menu acting on the selection and a Shift+click growing it keep it;
      // anything else lets it go.
      const target = event.target as Element | null;
      if (event.shiftKey || target?.closest(".pop")) return;
      /* A press on a selected block keeps the selection until it is known
         what it is: one that moves carries the blocks away (the editor's
         block move), one let go where it began is a click into the block,
         and lets them go. */
      const row = target?.closest<HTMLElement>("[data-block-id]");
      if (row && blocksRef.current?.contains(row) && selectedIds.includes(row.dataset.blockId ?? "")) {
        const { clientX: x, clientY: y } = event;
        const settle = (up: PointerEvent) => {
          window.removeEventListener("pointerup", settle, true);
          if (Math.hypot(up.clientX - x, up.clientY - y) < 4) setBlockSelection(null);
        };
        window.addEventListener("pointerup", settle, true);
        return;
      }
      setBlockSelection(null);
    };
    const copied = (cut: boolean): CopiedBlocks => ({ tree: extractFragment(tree, selectedIds), cut, source: page.id });
    const onCopy = (event: globalThis.ClipboardEvent) => {
      if (typing(event.target) || !event.clipboardData) return;
      event.preventDefault();
      writeBlocks(event.clipboardData, copied(false), titleOf);
    };
    const onCut = (event: globalThis.ClipboardEvent) => {
      if (typing(event.target) || !event.clipboardData) return;
      event.preventDefault();
      writeBlocks(event.clipboardData, copied(true), titleOf);
      deleteSelected(selectedIds, { cut: true });
    };
    // Pasted with blocks selected, blocks land after them and are selected.
    const onPaste = (event: globalThis.ClipboardEvent) => {
      if (typing(event.target) || !event.clipboardData) return;
      const text = event.clipboardData.getData("text/plain").trim();
      const lineId = createId("block");
      const pasted = pastedBlocks(event.clipboardData)
        ?? (text ? { incoming: null, fragment: { by_id: { [lineId]: createBlock(lineId, "text", { content: inlineFromText(text) }) } } } : null);
      const after = topLevelBlocks(tree, selectedIds).at(-1);
      if (!pasted || !after) return;
      event.preventDefault();
      adoptCutPages(pasted.incoming, pasted.fragment, after.id);
      executeOnBlocks(insertFragmentAfter(tree, after.id, pasted.fragment));
      const roots = orderedBlocks(pasted.fragment);
      const lastRoot = roots.at(-1);
      if (roots[0] && lastRoot) setBlockSelection({ anchor: roots[0].id, focus: lastRoot.id });
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
    };
  }, [
    adoptCutPages, anchorFor, blockSelection, blocksRef, deleteSelected, duplicateSelected, executeOnBlocks,
    openMoveTo, page.id, pastedBlocks, readOnly, rows, selectedIds, setBlockMenu, setBlockSelection,
    titleOf, tree,
  ]);
}
