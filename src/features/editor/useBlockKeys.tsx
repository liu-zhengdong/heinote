import type { KeyboardEvent } from "react";
import { createId } from "../../core/ids";
import { imeComposing } from "../../core/keyboard";
import { orderedBlocks } from "../../core/block-tree";
import {
  inlineFromText,
  inlinePlainText,
  mountedLink,
  rangeHasMark,
  replaceRange,
  splitInlineContent,
} from "../../core/inline-content";
import type { Block } from "../../core/types";
import { blockDefinition } from "./block-registry";
import { codeIndent, codeNewline } from "./code-editing";
import {
  applyEditorTransaction,
  checkLines,
  convertBlock,
  deleteBlock,
  duplicateBlocks,
  indentBlocks,
  insertBlockAfter,
  isLastInPage,
  leavePage,
  mergeBlockBackward,
  outdentBlocks,
  shiftBlocks,
  splitBlock,
  updateBlockContent,
} from "./editor-commands";
import { linkAddressBefore } from "../../core/autolink";
import {
  caretOffset,
  caretOnFirstLine,
  caretOnLastLine,
  focusAtEnd,
  focusRange,
  selectedBlockRanges,
  selectionOffsets,
} from "./selection";
import { CARET_KEYS, type Editor } from "./editor-state";
import type { BlockTyping } from "./useBlockTyping";
import { markForKey } from "./marks";

/** A key pressed in a block: the slash and mention menus' keys while one is
 *  open, then Notion's — Enter and Backspace at a line's edges, Tab and
 *  Shift+Tab, the arrows across lines and into pages shown here, Escape to
 *  select the block, the shortcuts for marks and moves. */
export function blockKeys(editor: Editor & BlockTyping) {
  const {
    page, tree, rows, embed, blocksRef, slash, setSlash, slashIndex, setSlashIndex, slashDismissed, commands,
    mention, setMention, mentionIndex, setMentionIndex, mentionDismissed, mentionOptions, setFormat, resume,
    pendingTextSelection, checkpointHistory, execute, selectBlocks, runReplace, replaceSelection, nextEditable,
    moveCaret, applyBlockShortcut, runCommand, openMoveTo, closeMenus, chooseMention, applyMarkToBlocks, openLink,
  } = editor;
  const onBlockKeyDown = (block: Block, event: KeyboardEvent<HTMLElement>) => {
    // Keys the input method owns are the input method's: the Enter that picks
    // a candidate must not split the block, nor its Backspace delete it.
    if (imeComposing(event)) return;
    if (CARET_KEYS.has(event.key)) resume.current = null;
    const element = event.currentTarget;
    const definition = blockDefinition(block.kind);
    const meta = event.metaKey || event.ctrlKey;

    /* A selection across blocks: Delete and Backspace take all of it, a typed
       character replaces all of it, Enter replaces it with a new line. Marks
       (⌘B and the rest) and plain arrow keys fall through as usual. */
    if (!meta && !event.altKey) {
      const printable = event.key.length === 1;
      if (event.key === "Backspace" || event.key === "Delete" || event.key === "Enter" || printable) {
        const across = replaceSelection(printable ? inlineFromText(event.key) : []);
        if (across?.focus) {
          event.preventDefault();
          if (event.key !== "Enter") {
            runReplace(across);
            return;
          }
          const merged = applyEditorTransaction(tree, across);
          const first = merged.by_id[across.focus.id];
          const split = first
            ? splitBlock(merged, first.id, across.focus.offset, createId("block"), blockDefinition(first.kind).continueAs)
            : null;
          if (!split) {
            runReplace(across);
            return;
          }
          setFormat(null);
          execute({ mutations: [...across.mutations, ...split.mutations], focus: split.focus });
          return;
        }
      }
    }

    if (slash) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setSlashIndex((index) => (index + delta + commands.length) % Math.max(1, commands.length));
        return;
      }
      if (event.key === "Enter" && commands.length) {
        event.preventDefault();
        runCommand(block, commands[Math.min(slashIndex, commands.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        slashDismissed.current = { blockId: slash.blockId, from: slash.from };
        setSlash(null);
        return;
      }
    }

    /* A code block keeps Enter and Tab for itself, as an editor does: a new
       line at the same indent, and indenting the lines selected. ⌘Enter leaves
       it for a new line below. Marks mean nothing in code. */
    if (block.kind === "code" && !event.altKey) {
      const caret = caretOffset(element);
      const range = selectionOffsets(element) ?? { start: caret, end: caret };
      const code = inlinePlainText(block.content);
      const write = (edit: { text: string; start: number; end: number }) => {
        if (edit.text === code) return;
        execute(updateBlockContent(tree, block.id, inlineFromText(edit.text)), {
          id: block.id, start: edit.start, end: edit.end, force: true,
        });
      };
      if (event.key === "Enter") {
        event.preventDefault();
        if (meta) execute(insertBlockAfter(tree, block.id, createId("block")));
        else write(codeNewline(code, range.start, range.end));
        return;
      }
      if (event.key === "Tab" && !meta) {
        event.preventDefault();
        write(codeIndent(code, range.start, range.end, event.shiftKey));
        return;
      }
      const key = event.key.toLowerCase();
      if (meta && (event.shiftKey ? key === "s" : ["b", "i", "u", "e"].includes(key))) {
        event.preventDefault();
        return;
      }
    }

    /* An image or file block's text is its caption. Enter leaves it for a new
       line below; Backspace at its start selects the block, as Notion's media
       blocks do — one more Backspace deletes it, deliberately. */
    if (block.kind === "file" && !meta && !event.altKey && !mention) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        execute(insertBlockAfter(tree, block.id, createId("block")));
        return;
      }
      if (event.key === "Backspace" && caretOffset(element) === 0) {
        const range = selectionOffsets(element);
        if (!range || range.start === range.end) {
          event.preventDefault();
          selectBlocks(block.id);
          return;
        }
      }
    }

    if (mention) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setMentionIndex((index) => (index + delta + mentionOptions.length) % Math.max(1, mentionOptions.length));
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && mentionOptions.length) {
        event.preventDefault();
        chooseMention(block, mentionOptions[Math.min(mentionIndex, mentionOptions.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        mentionDismissed.current = { blockId: mention.blockId, from: mention.from };
        setMention(null);
        return;
      }
    }

    if (meta) {
      const shortcut = event.key.toLowerCase();
      // ⌘A selects the block's text; once it is all selected, every block.
      if (shortcut === "a" && !event.shiftKey) {
        const range = selectionOffsets(element);
        const length = element.textContent?.length ?? 0;
        if (!length || (range && range.start === 0 && range.end >= length)) {
          event.preventDefault();
          const last = rows.at(-1);
          if (last) selectBlocks(rows[0].block.id, last.block.id);
          return;
        }
      }
      // ⌘K on selected words links them, as in Notion: the toolbar's Link
      // box, the caret in it. With nothing selected it is Quick Find's.
      if (shortcut === "k" && !event.shiftKey) {
        const selected = blocksRef.current ? selectedBlockRanges(blocksRef.current) : [];
        if (selected.some((range) => range.start !== range.end) && selected.every((range) => tree.by_id[range.blockId]?.kind !== "code")) {
          event.preventDefault();
          openLink();
          return;
        }
      }
      // ⌘⇧P: Notion's "Move to", for the block with the caret.
      if (shortcut === "p" && event.shiftKey) {
        event.preventDefault();
        openMoveTo([block.id]);
        return;
      }
      const mark = markForKey(event);
      if (mark) {
        // Words selected across blocks, or in this one: the mark on all of
        // them, or off all of them when every one has it.
        const selected = blocksRef.current ? selectedBlockRanges(blocksRef.current) : [];
        const range = selectionOffsets(element);
        const ranges = selected.length > 1 ? selected : range && range.start !== range.end ? [{ blockId: block.id, ...range }] : [];
        if (!ranges.length) return;
        event.preventDefault();
        const enabled = ranges.every((each) => rangeHasMark(tree.by_id[each.blockId].content, each.start, each.end, mark));
        applyMarkToBlocks(ranges, mark, !enabled);
        return;
      }
      if (shortcut === "d") {
        event.preventDefault();
        const duplicated = duplicateBlocks(tree, [block.id], () => createId("block"));
        if (duplicated) execute(duplicated.transaction, { id: duplicated.copies[0], start: inlinePlainText(block.content).length });
        return;
      }
      if (event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        execute(shiftBlocks(tree, [block.id], event.key === "ArrowUp" ? -1 : 1), {
          id: block.id,
          start: caretOffset(element),
        });
        return;
      }
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeMenus();
      selectBlocks(block.id);
      return;
    }

    /* Shift+↑/↓ grows a text selection to the edge of its block, as usual; one
       more press, and the selection becomes blocks — this one and the next. */
    if (event.shiftKey && !meta && !event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      const up = event.key === "ArrowUp";
      const range = selectionOffsets(element) ?? { start: caretOffset(element), end: caretOffset(element) };
      const length = element.textContent?.length ?? 0;
      if (up ? range.start === 0 : range.end >= length) {
        event.preventDefault();
        const position = rows.findIndex((row) => row.block.id === block.id);
        const neighbour = rows[position + (up ? -1 : 1)];
        selectBlocks(block.id, neighbour?.block.id ?? block.id);
        return;
      }
    }

    if (event.key === " " && !event.shiftKey && !meta && !event.altKey) {
      if (applyBlockShortcut(block, element)) {
        event.preventDefault();
        return;
      }
    }

    if (event.key === "Tab") {
      event.preventDefault();
      execute(event.shiftKey ? outdentBlocks(tree, [block.id]) : indentBlocks(tree, [block.id]), {
        id: block.id,
        start: caretOffset(element),
      });
      return;
    }

    /* ⌘Enter, as Notion's: a bulleted line becomes a to-do and a to-do is
       ticked or unticked — every line the selected words reach, the caret
       or the words staying where they are (checkLines). Any other line
       takes ⌘Enter as Enter. */
    if (event.key === "Enter" && meta && !event.shiftKey && !event.altKey) {
      const reached = blocksRef.current ? selectedBlockRanges(blocksRef.current) : [];
      const several = reached.length > 1;
      const checked = checkLines(tree, several ? reached.map((range) => range.blockId) : [block.id]);
      if (checked) {
        event.preventDefault();
        if (several) {
          pendingTextSelection.current = { ranges: reached, forceIds: reached.map((range) => range.blockId) };
          execute(checked);
        } else {
          const range = selectionOffsets(element) ?? { start: caretOffset(element), end: caretOffset(element) };
          execute(checked, { id: block.id, start: range.start, end: range.end, force: true });
        }
        return;
      }
    }

    if (event.key === "Enter") {
      event.preventDefault();
      // A fence (```, ```python) closed by Enter is a code block, as in any
      // Markdown editor — not a line holding the fence.
      if (!event.shiftKey && /^```[^\s`]*$/.test(element.textContent ?? "") && applyBlockShortcut(block, element)) return;
      if (event.shiftKey) {
        const caret = caretOffset(element);
        execute(updateBlockContent(tree, block.id, replaceRange(block.content, caret, caret, "\n")), {
          id: block.id,
          start: caret + 1,
          force: true,
        });
        return;
      }
      if (!inlinePlainText(block.content) && block.kind !== "text") {
        execute(convertBlock(tree, block.id, "text"));
        return;
      }
      // A quote holds together what is written in it, as a code block does:
      // Enter is a new line inside it, and Enter on the empty line that
      // leaves at its end — the second Enter — steps out into a paragraph.
      if (block.kind === "quote") {
        const text = inlinePlainText(block.content);
        const caret = caretOffset(element);
        if (caret === text.length && text.endsWith("\n")) {
          const trimmed = updateBlockContent(tree, block.id, replaceRange(block.content, text.length - 1, text.length, ""));
          const after = trimmed ? insertBlockAfter(applyEditorTransaction(tree, trimmed), block.id, createId("block")) : null;
          if (trimmed && after) execute({ mutations: [...trimmed.mutations, ...after.mutations], focus: after.focus });
          return;
        }
        execute(updateBlockContent(tree, block.id, replaceRange(block.content, caret, caret, "\n")), { id: block.id, start: caret + 1, force: true });
        return;
      }
      // A page shown in another by a link: its empty last line steps out into
      // THAT page — never below the page where it lives. It only goes when
      // the page keeps a line without it.
      if (!inlinePlainText(block.content) && embed?.mount && !block.parent_id && orderedBlocks(tree).at(-1)?.id === block.id) {
        if (orderedBlocks(tree).length > 1) execute({ ...deleteBlock(tree, block.id)!, focus: undefined });
        embed.mount.stepOut();
        return;
      }
      // An empty last line of a block steps out of it, as an empty item
      // leaves a list.
      if (!inlinePlainText(block.content) && isLastInPage(tree, block.id)) {
        execute(leavePage(tree, block.id));
        return;
      }
      const caret = caretOffset(element);
      const newId = createId("block");
      const split = splitBlock(tree, block.id, caret, newId, definition.continueAs);
      // A web address the line ends in is linked as Enter finishes it, as a
      // space after it would — a step of its own, so ⌘Z gives back the words
      // and keeps the new line.
      const linked = split ? linkAddressBefore(splitInlineContent(block.content, caret)[0], caret) : null;
      if (!split || !linked) {
        execute(split);
        return;
      }
      // Only marks change on the line left behind: it is redrawn, with the
      // new one, before the caret goes to the new line.
      pendingTextSelection.current = { ranges: [{ blockId: newId, start: 0, end: 0 }], forceIds: [block.id, newId] };
      execute({ mutations: split.mutations });
      checkpointHistory({ kind: "text", pageId: page.id, ranges: [{ blockId: newId, start: 0, end: 0 }] });
      execute(updateBlockContent(tree, block.id, linked));
      return;
    }

    if (event.key === "Backspace" && caretOffset(element) === 0) {
      const range = selectionOffsets(element);
      if (range && range.start !== range.end) return;
      event.preventDefault();
      // Code with anything in it stays code: its lines would make a strange
      // paragraph. An empty one turns back into text, like any block.
      if (block.kind === "code" && inlinePlainText(block.content)) return;
      if (block.kind !== "text") {
        execute(convertBlock(tree, block.id, "text"));
        return;
      }
      // Nested under a paragraph, it comes out a level first. At the top of
      // the page or of a block, an empty line goes; words join the line
      // above — unless nothing comes before them there, the start of a page
      // or of a block, which Backspace never crosses.
      if (block.parent_id && tree.by_id[block.parent_id]?.kind !== "page") {
        execute(outdentBlocks(tree, [block.id]), { id: block.id, start: 0 });
        return;
      }
      const siblings = orderedBlocks(tree, block.parent_id);
      if (!inlinePlainText(block.content)) {
        execute(deleteBlock(tree, block.id));
        return;
      }
      if (siblings[0]?.id === block.id) return;
      // Right after a block shown here from another page, whose words are that
      // page's too — or a table, whose words are its cells': the block is
      // selected, as a picture would be.
      const previous = siblings[siblings.findIndex((item) => item.id === block.id) - 1];
      if (previous && (mountedLink(previous.content) || previous.kind === "table")) {
        selectBlocks(previous.id);
        return;
      }
      execute(mergeBlockBackward(tree, block.id));
      return;
    }

    if (event.key === "ArrowUp" && !event.shiftKey && caretOnFirstLine(element)) {
      if (moveCaret(block, -1, element)) event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown" && !event.shiftKey && caretOnLastLine(element)) {
      if (moveCaret(block, 1, element)) event.preventDefault();
      return;
    }
    if (event.key === "ArrowLeft" && !event.shiftKey && caretOffset(element) === 0) {
      const previous = nextEditable(block.id, -1);
      if (previous) {
        event.preventDefault();
        focusAtEnd(previous);
      }
      return;
    }
    if (event.key === "ArrowRight" && !event.shiftKey && caretOffset(element) === inlinePlainText(block.content).length) {
      const next = nextEditable(block.id, 1);
      if (next) {
        event.preventDefault();
        focusRange(next, 0);
      }
    }
  };
  return onBlockKeyDown;
}
