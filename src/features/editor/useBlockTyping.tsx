import type { ClipboardEvent } from "react";
import { pointRect } from "../../hooks/useAnchoredPosition";
import { createId } from "../../core/ids";
import {
  inlineFromText,
  inlinePlainText,
  insertMention,
  isWebAddress,
  replaceRange,
  sliceInlineContent,
} from "../../core/inline-content";
import type { Block, BlockMutation, InlineContent, Mention } from "../../core/types";
import type { HistoryFocus } from "../../core/workspace-history";
import { markdownShortcut } from "./adapters";
import { readBlocks } from "./block-clipboard";
import { lastCodeLanguage, rememberCodeLanguage } from "./code-highlight";
import {
  applyEditorTransaction,
  embedPage,
  insertBlockAfter,
  lineIsOnlyLink,
  pageFromBlocks,
  pasteFragment,
  updateBlockContent,
  updateBlockFields,
  type EditorTransaction,
} from "./editor-commands";
import { collapseInlineMarkdown, mentionQueryAt, resumeTyping, slashQueryAt } from "./inline-markdown";
import { mentionItems, pageFromLink, type MentionItem } from "./mentions";
import { linkifyContent, linkTypedAddress } from "../../core/autolink";
import { embedFromUrl } from "../../core/embeds";
import { caretOffset, caretRect, editableWithin, placeCaretNear, selectionOffsets } from "./selection";
import { slashCommands, type Command } from "./SlashMenu";
import { newDatabaseConfig } from "../database/database-model";
import { createBlock, orderedBlocks } from "../../core/block-tree";
import { newSimpleTable } from "../../core/simple-table";
import { markFreshTable, tableEntryCell } from "./SimpleTable";
import { markFresh } from "../database/fresh";
import type { Editor, PendingFocus } from "./editor-state";
import type { useMedia } from "./useMedia";

/* The content with an arrow in place of the "->" or "<-" just typed before
   the caret, or null. Not inside inline code. */
function typedArrow(content: InlineContent, caret: number): InlineContent | null {
  const text = inlinePlainText(content);
  const typed = text.slice(Math.max(0, caret - 2), caret);
  const arrow = typed === "->" ? "→" : typed === "<-" ? "←" : null;
  if (!arrow || sliceInlineContent(content, caret - 2, caret).some((run) => run.marks?.code)) return null;
  return replaceRange(content, caret - 2, caret, arrow);
}

function caretAt(pageId: string, blockId: string, offset: number): HistoryFocus {
  return { kind: "text", pageId, ranges: [{ blockId, start: offset, end: offset }] };
}

/** Typing in a block: what is typed, and what it turns into — Markdown
 *  that writes a heading or a list, "/" and "@" and "[[" opening their
 *  menus, an arrow for "->" — what is pasted into it, the slash commands,
 *  and the caret going on past a line into the next. */
export function blockTyping(editor: Editor & Pick<ReturnType<typeof useMedia>, "placeFiles">) {
  const {
    page, tree, rows, embed, blocksRef, pagesRef, caretX, slash, setSlash, setSlashIndex, slashDismissed, mention,
    setMention, setMentionIndex, mentionDismissed, setFormat, resume, pendingTextSelection, ownerOf, createPage,
    checkpointHistory, annotateHistory, execute, runReplace, replaceSelection, applyMarkToBlocks, placeFiles,
    pastedBlocks, adoptCutPages, offerCard,
  } = editor;

  /* ── Block editing ──────────────────────────────────────────────────── */

  const openSlash = (block: Block, element: HTMLElement, from: number, query: string) => {
    const rect = caretRect(element);
    setSlash((current) => ({
      blockId: block.id,
      from,
      query,
      anchor: current?.blockId === block.id && current.from === from
        ? current.anchor
        : pointRect(rect?.left ?? 0, rect?.bottom ?? 0),
    }));
    setSlashIndex(0);
  };

  const onBlockChange = (block: Block, typed: InlineContent, text: string, element: HTMLElement, composing: boolean) => {
    setFormat(null);
    const caret = caretOffset(element);

    // Straight after `*word*` collapses, the browser types into the new
    // italic run. What is typed there gets back the marks from before the
    // delimiters, and the block is drawn again — or, while an input method is
    // composing, once it lets go (InlineEditor draws it then).
    let content = typed;
    let redraw: PendingFocus | undefined;
    const pending = resume.current;
    if (pending) {
      const resumed = pending.blockId === block.id ? resumeTyping(pending, typed, caret) : null;
      if (resumed) content = resumed.content;
      if (resumed?.changed && !composing) redraw = { id: block.id, start: caret, force: true };
      if (!resumed || !composing) resume.current = null;
    }

    // "->" and "<-" become arrows as they are typed, as in Notion — and ⌘Z
    // gives the two characters back.
    const arrow = block.kind === "code" ? null : typedArrow(content, caret);
    if (arrow) {
      execute(updateBlockContent(tree, block.id, content));
      checkpointHistory(caretAt(page.id, block.id, caret));
      execute(updateBlockContent(tree, block.id, arrow), { id: block.id, start: caret - 1, force: true });
      setSlash(null);
      return;
    }

    const collapsedMarkdown = block.kind === "code" ? null : collapseInlineMarkdown(content, caret);
    if (collapsedMarkdown) {
      // The characters as typed are a step of their own, so ⌘Z turns the
      // formatting back into them — the way Notion's undo does.
      execute(updateBlockContent(tree, block.id, content));
      checkpointHistory(caretAt(page.id, block.id, caret));
      execute(updateBlockContent(tree, block.id, collapsedMarkdown.content), {
        id: block.id,
        start: collapsedMarkdown.caret,
        force: true,
      });
      resume.current = { blockId: block.id, ...collapsedMarkdown.resume };
      setSlash(null);
      return;
    }

    // A web address becomes a link as the space after it is typed, as in
    // Notion — and ⌘Z gives it back as the words it was typed as. Not while
    // an input method is still composing: that space may be one of its own.
    const linkedAddress = block.kind === "code" || composing ? null : linkTypedAddress(content, caret);
    if (linkedAddress) {
      execute(updateBlockContent(tree, block.id, content));
      checkpointHistory(caretAt(page.id, block.id, caret));
      execute(updateBlockContent(tree, block.id, linkedAddress), { id: block.id, start: caret, force: true });
      setSlash(null);
      return;
    }

    execute(updateBlockContent(tree, block.id, content), redraw);
    const query = block.kind === "code" || block.kind === "file" ? null : slashQueryAt(text, caret);
    const dismissed = slashDismissed.current;
    let slashOpen = false;
    if (!query) {
      slashDismissed.current = null;
      setSlash(null);
    } else if (dismissed?.blockId === block.id && dismissed.from === query.from) {
      setSlash(null);
    } else if (/\s$/.test(query.query) && !slashCommands(query.query).length) {
      slashDismissed.current = { blockId: block.id, from: query.from };
      setSlash(null);
    } else {
      openSlash(block, element, query.from, query.query);
      slashOpen = true;
    }

    /* `@` and `[[` open the mention menu the same way. An `@` typed in
       passing — "meet @ 5", "@everyone " with no such page — lets go at the
       next space; `[[` is only ever typed to link, so it stays for a name
       with spaces in it until Escape. */
    const found = slashOpen || block.kind === "code" ? null : mentionQueryAt(text, caret);
    const waved = mentionDismissed.current;
    if (!found) {
      mentionDismissed.current = null;
      setMention(null);
    } else if (waved?.blockId === block.id && waved.from === found.from) {
      setMention(null);
    } else if (found.trigger === "@" && /\s$/.test(found.query)
      && !mentionItems(found.query, "@", pagesRef.current, page.id).some((item) => item.kind !== "new")) {
      mentionDismissed.current = { blockId: block.id, from: found.from };
      setMention(null);
    } else {
      const rect = caretRect(element);
      setMention((current) => ({
        blockId: block.id,
        from: found.from,
        query: found.query,
        trigger: found.trigger,
        anchor: current?.blockId === block.id && current.from === found.from
          ? current.anchor
          : pointRect(rect?.left ?? 0, rect?.bottom ?? 0),
      }));
      setMentionIndex(0);
    }
  };

  /** Puts the chosen page or date where `@query` (or `[[query`) was typed —
   *  making the page first, when it is a new one. What was typed stays a
   *  step of its own, so ⌘Z gives it back, as Notion's undo does. */
  const chooseMention = (block: Block, item: MentionItem) => {
    const current = tree.by_id[block.id];
    if (!mention || !current) return;
    let target: Mention;
    if (item.kind === "page") target = { kind: "page", page_id: item.page.id };
    else if (item.kind === "date") target = { kind: "date", date: item.date };
    else {
      const created = createPage(ownerOf(block.id), "document", { select: false, title: item.title });
      if (!created) return;
      target = { kind: "page", page_id: created };
    }
    const end = mention.from + mention.trigger.length + mention.query.length;
    const inserted = insertMention(current.content, mention.from, end, target);
    setMention(null);
    checkpointHistory(caretAt(page.id, block.id, end));
    execute(updateBlockContent(tree, block.id, inserted.content), { id: block.id, start: inserted.caret, force: true });
  };

  /** `# `, `- `, `1. `, `[] `, `> `, `"` — applied on the space that closes
   *  the trigger, and only when the caret is at the end of an untouched
   *  paragraph. */
  const applyBlockShortcut = (block: Block, element: HTMLElement): boolean => {
    if (block.kind !== "text") return false;
    const text = element.textContent ?? "";
    if (caretOffset(element) !== text.length) return false;
    const shortcut = markdownShortcut(text);
    if (!shortcut) return false;
    // A fence that names its language (```python) sets it — and is the
    // language the next code block starts in, as one picked from the menu is.
    if (shortcut.language) rememberCodeLanguage(shortcut.language);
    const converted = updateBlockFields(tree, block.id, {
      kind: shortcut.kind,
      content: [],
      checked: shortcut.kind === "todo" ? shortcut.checked ?? false : undefined,
      language: shortcut.kind === "code" ? shortcut.language ?? lastCodeLanguage() : undefined,
    });
    const inserted = shortcut.kind === "divider" ? insertBlockAfter(tree, block.id, createId("block")) : null;
    if (!converted || (shortcut.kind === "divider" && !inserted)) return false;
    // The space that set the shortcut off is written first, as typing, so ⌘Z
    // gives back "# " rather than a heading — the way Notion's undo does.
    execute(updateBlockContent(tree, block.id, replaceRange(block.content, text.length, text.length, " ")));
    annotateHistory("insert");
    checkpointHistory(caretAt(page.id, block.id, text.length + 1));
    element.innerHTML = "";
    if (inserted) {
      execute({ mutations: [...converted.mutations, ...inserted.mutations], focus: inserted.focus });
    } else {
      execute(converted, { id: block.id, start: 0, force: true });
    }
    setSlash(null);
    return true;
  };

  /* Pasting blocks at the caret: see `pasteFragment` for where each lands. A
     selection across blocks goes first, as if deleted, and a code block takes
     everything as its own text. One line of text is left to the browser, which
     pastes it among the words like anything typed. */
  const onBlockPaste = (block: Block, event: ClipboardEvent<HTMLElement>) => {
    // Code takes what is pasted as its own characters, lines and indentation
    // intact — never as blocks, and never as the markup a browser would paste.
    if (block.kind === "code") {
      event.preventDefault();
      const text = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
      const caret = caretOffset(event.currentTarget);
      const range = selectionOffsets(event.currentTarget) ?? { start: caret, end: caret };
      const code = inlinePlainText(block.content);
      const next = code.slice(0, range.start) + text + code.slice(range.end);
      execute(updateBlockContent(tree, block.id, inlineFromText(next)), { id: block.id, start: range.start + text.length, force: true });
      return;
    }
    // A picture or file on the clipboard — a screenshot, an image copied from
    // a web page — is uploaded as a block. Copied text that also carries a
    // picture of itself (a spreadsheet's cells) is pasted as the text.
    const pastedFiles = [...event.clipboardData.files];
    const pastedText = event.clipboardData.getData("text/plain").trim();
    const pastedHtml = event.clipboardData.getData("text/html");
    if (pastedFiles.length && !readBlocks(event.clipboardData)
      && (!pastedText || (/<img\b/i.test(pastedHtml) && !pastedHtml.replace(/<[^>]*>/g, "").trim()))) {
      event.preventDefault();
      /* Pictures stand among the words at the caret, as in Google Docs; an
         empty line — a list item's too — takes them as its own. A file, or a
         caption's caret, puts each on a line of its own after this one. */
      const blank = !inlinePlainText(block.content) && (block.kind !== "file" || !block.file);
      if (blank) {
        void placeFiles(pastedFiles, { kind: "line", blockId: block.id, edge: "fill" });
      } else if (block.kind === "file") {
        void placeFiles(pastedFiles, { kind: "line", blockId: block.id, edge: "after" });
      } else {
        const caret = caretOffset(event.currentTarget);
        const range = selectionOffsets(event.currentTarget) ?? { start: caret, end: caret };
        void placeFiles(pastedFiles, { kind: "words", blockId: block.id, ...range });
      }
      return;
    }
    // A link to a page of this workspace — a block is a page — pasted on its
    // own, mentions it: what Notion offers first for a page link.
    const words = selectionOffsets(event.currentTarget);
    const linked = pageFromLink(event.clipboardData.getData("text/plain"), pagesRef.current, window.location);
    if (linked && (!words || words.start === words.end) && !replaceSelection()) {
      event.preventDefault();
      const caret = caretOffset(event.currentTarget);
      const inserted = insertMention(block.content, caret, caret, { kind: "page", page_id: linked });
      execute(updateBlockContent(tree, block.id, inserted.content), { id: block.id, start: inserted.caret, force: true });
      return;
    }
    // A link pasted over selected words links them, as in Notion.
    const url = event.clipboardData.getData("text/plain").trim();
    if (words && words.start !== words.end && isWebAddress(url)) {
      event.preventDefault();
      applyMarkToBlocks([{ blockId: block.id, start: words.start, end: words.end }], "link", url);
      return;
    }
    const pasted = pastedBlocks(event.clipboardData);
    if (!pasted) {
      const plain = event.clipboardData.getData("text/plain");
      const across = replaceSelection(linkifyContent(inlineFromText(plain)));
      if (across) {
        event.preventDefault();
        runReplace(across);
        return;
      }
      // One line holding a web address — pasted from the address bar, say —
      // goes in with the address linked, as Notion pastes one. Any other line
      // is left to the browser, which pastes it among the words like typing.
      const range = words ?? { start: caretOffset(event.currentTarget), end: caretOffset(event.currentTarget) };
      const line = plain.replace(/\r?\n$/, "");
      const inserted = replaceRange(block.content, range.start, range.end, line);
      const withLinks = linkifyContent(inserted, range.start, range.start + line.length);
      if (withLinks !== inserted && !/\n/.test(line)) {
        event.preventDefault();
        execute(updateBlockContent(tree, block.id, withLinks), { id: block.id, start: range.start + line.length, force: true });
        // A link that makes a card, pasted onto an empty line: its card is
        // offered, the link kept if it is not taken.
        const href = withLinks.find((run) => run.marks?.link)?.marks?.link;
        if (href && !inlinePlainText(block.content).trim() && embedFromUrl(href) && lineIsOnlyLink({ ...block, content: withLinks }, href)) {
          offerCard(block.id, href);
        }
      }
      return;
    }
    event.preventDefault();
    let base = tree;
    let cleared: BlockMutation[] = [];
    let target = block.id;
    const caret = caretOffset(event.currentTarget);
    let range = selectionOffsets(event.currentTarget) ?? { start: caret, end: caret };
    const across = replaceSelection();
    if (across?.focus) {
      base = applyEditorTransaction(tree, across);
      cleared = across.mutations;
      target = across.focus.id;
      range = { start: across.focus.offset, end: across.focus.offset };
    }
    const transaction = pasteFragment(base, target, range, pasted.fragment, () => createId("block"));
    if (!transaction) return;
    adoptCutPages(pasted.incoming, pasted.fragment, target);
    setFormat(null);
    setSlash(null);
    const focus = transaction.focus;
    // The line the caret was in changed under it, and so may the block the
    // caret ends in: both are redrawn before the caret is placed.
    if (focus) pendingTextSelection.current = { ranges: [{ blockId: focus.id, start: focus.offset, end: focus.offset }], forceIds: [target, focus.id] };
    execute({ mutations: [...cleared, ...transaction.mutations] });
  };

  /** The next line on from `blockId` that takes the caret — its own words, or
   *  the first (or last) line of a block shown in it — past lines that take
   *  none: a divider, a sub-page's row, a folded block. */
  const nextEditable = (blockId: string, direction: -1 | 1): HTMLElement | null => {
    const container = blocksRef.current;
    for (let position = rows.findIndex((row) => row.block.id === blockId) + direction; position >= 0 && position < rows.length; position += direction) {
      const target = rows[position].block.id;
      // A table is entered at the cell of its first (or last) row under the
      // caret.
      if (rows[position].block.kind === "table") {
        const drawn = container?.querySelector(`[data-block-id="${CSS.escape(target)}"]`);
        const cell = drawn ? tableEntryCell(drawn, direction, caretX.current) : null;
        if (cell) return cell;
        continue;
      }
      const shown = [...(container?.querySelectorAll<HTMLElement>(`[data-block-id="${CSS.escape(target)}"] > .mount .block__editable`) ?? [])];
      const next = editableWithin(container, target) ?? (direction === 1 ? shown[0] : shown.at(-1));
      if (next) return next;
    }
    return null;
  };

  const moveCaret = (block: Block, direction: -1 | 1, element: HTMLElement): boolean => {
    const rect = caretRect(element);
    if (rect) caretX.current = rect.left;
    const next = nextEditable(block.id, direction);
    // Past the edge of a block shown here from another page: on into the page.
    if (!next) return embed?.mount?.caretOut(direction, caretX.current) ?? false;
    placeCaretNear(next, caretX.current, direction === 1 ? "top" : "bottom");
    return true;
  };

  /* ── Slash commands ─────────────────────────────────────────────────── */

  const runCommand = (block: Block, command: Command) => {
    if (!slash) return;
    const stripped = replaceRange(block.content, slash.from, slash.from + 1 + slash.query.length, "");
    setSlash(null);

    if (command.action) {
      const ids = { embed: createId("block"), trailing: createId("block") };
      if (command.action === "database-inline") {
        // Drawn right here, so it must not take the reader away: the new
        // database is created unselected and asks for its name in place.
        const created = createPage(ownerOf(block.id), "database", {
          select: false,
          database: newDatabaseConfig(command.view ?? "table", createId("view"), () => createId("property")),
        });
        if (!created) return;
        markFresh(created);
        execute(embedPage(tree, block.id, created, stripped, ids, { shown: true, database: true }));
        return;
      }
      // A child page or a full-page database opens as it is made, the way
      // Notion's do, and leaves a link to itself behind.
      const created = createPage(ownerOf(block.id), command.action === "page" ? "document" : "database");
      if (!created) return;
      execute(embedPage(tree, block.id, created, stripped, ids, { database: command.action !== "page" }));
      return;
    }

    if (!command.kind) return;
    const target = command.kind;
    /* /table: the line becomes a table when the command was all it held,
       else one goes in after it; its first cell takes the caret, and a line
       follows it when it would end the page. */
    if (target === "table") {
      const tableId = inlinePlainText(stripped) ? createId("block") : block.id;
      const table = newSimpleTable(3, 2, (kind) => createId(kind === "column" ? "col" : "row"));
      const mutations: BlockMutation[] = [];
      if (tableId === block.id) {
        mutations.push({ action: "put", block: createBlock(block.id, "table", { parent_id: block.parent_id, order: block.order, table }) });
      } else {
        const inserted = insertBlockAfter(tree, block.id, tableId, "table");
        if (!inserted) return;
        const made = (inserted.mutations[0] as Extract<BlockMutation, { action: "put" }>).block;
        mutations.push({ action: "put", block: { ...block, content: stripped } }, { action: "put", block: { ...made, table } });
      }
      const placed = applyEditorTransaction(tree, { mutations });
      const parentId = placed.by_id[tableId]?.parent_id ?? null;
      if (orderedBlocks(placed, parentId).at(-1)?.id === tableId) {
        const trailing = insertBlockAfter(placed, tableId, createId("block"));
        if (trailing) mutations.push(...trailing.mutations);
      }
      markFreshTable(tableId);
      execute({ mutations });
      return;
    }
    // "/block": the paragraph becomes a block of its own, words and all.
    if (target === "page") {
      const stripping: EditorTransaction = { mutations: [{ action: "put", block: { ...block, content: stripped } }] };
      const wrapped = pageFromBlocks(applyEditorTransaction(tree, stripping), [block.id], createId("page"));
      execute(
        { mutations: [...stripping.mutations, ...(wrapped?.transaction?.mutations ?? [])] },
        { id: block.id, start: slash.from, force: true },
      );
      return;
    }
    // A to-do or a callout: the line becomes one, words and all.
    execute(updateBlockFields(tree, block.id, {
      kind: target,
      content: stripped,
      checked: target === "todo" ? false : undefined,
    }), { id: block.id, start: slash.from, force: true });
  };

  return { onBlockChange, chooseMention, applyBlockShortcut, onBlockPaste, nextEditable, moveCaret, runCommand };
}

/** What typing hands the keys: the menus' choices, the caret across lines. */
export type BlockTyping = ReturnType<typeof blockTyping>;
