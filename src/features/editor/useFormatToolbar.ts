import { useCallback, useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { applyMarkToRange, inlinePlainText, rangeColor, rangeHasMark, rangeLink, type ToggleableMark } from "../../core/inline-content";
import type { BlockMutation, BlockTree } from "../../core/types";
import { updateBlockContent, type EditorTransaction } from "./editor-commands";
import type { FormatState } from "./FormatToolbar";
import { selectedBlockRanges, selectionRect, type BlockTextRange, type PendingTextSelection } from "./selection";
import { MARKS } from "./marks";

/** What the format toolbar needs of the editor. */
interface FormatContext {
  readOnly: boolean;
  tree: BlockTree;
  blocksRef: RefObject<HTMLDivElement | null>;
  /** A press still down: the toolbar waits for the release. */
  pointerDown: RefObject<boolean>;
  pendingTextSelection: RefObject<PendingTextSelection | null>;
  format: FormatState | null;
  setFormat: Dispatch<SetStateAction<FormatState | null>>;
  execute(change: EditorTransaction | null): void;
}

/** Notion's toolbar over selected text: where it stands and what the text
 *  already is (bold, a link, a colour), kept up as the selection moves, and
 *  the marks it puts on the text — across blocks, the selection kept. */
export function useFormatToolbar({ readOnly, tree, blocksRef, pointerDown, pendingTextSelection, format, setFormat, execute }: FormatContext) {
  const updateFormat = useRef<() => void>(() => {});

  /* ── Format toolbar ─────────────────────────────────────────────────── */

  useEffect(() => {
    if (readOnly) return;
    let frame = 0;
    /* A mention's words are drawn, not written, so the browser's selection
       colour cannot reach them: a mention inside a selection is tinted here. */
    const tintMentions = () => {
      const root = blocksRef.current;
      if (!root) return;
      const selection = window.getSelection();
      const range = selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
      for (const token of root.querySelectorAll<HTMLElement>(".mention")) {
        const inside = Boolean(range?.intersectsNode(token));
        if (token.classList.contains("is-selected") !== inside) token.classList.toggle("is-selected", inside);
      }
    };
    const onSelectionChange = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        updateFormat.current();
        tintMentions();
      });
    };
    updateFormat.current = () => {
      if (pointerDown.current) {
        setFormat(null);
        return;
      }
      // Typing in the toolbar's own fields — the link being pasted in — takes
      // the selection out of the page. The toolbar stays on the words it was
      // opened for, or the link box would vanish with it at the first press.
      if (document.activeElement?.closest('[data-pop-group="format"]')) return;
      {
        const rect = selectionRect();
        const ranges = blocksRef.current ? selectedBlockRanges(blocksRef.current) : [];
        const blocks = ranges.map((range) => tree.by_id[range.blockId]).filter(Boolean);
        const block = blocks[0];
        if (!rect || !block || blocks.some((item) => item.kind === "code")) {
          setFormat(null);
          return;
        }
        const sharedLink = rangeLink(block.content, ranges[0].start, ranges[0].end);
        setFormat({
          anchor: {
            top: rect.top, left: rect.left, bottom: rect.bottom,
            right: rect.right, width: rect.width, height: rect.height,
          },
          blockId: block.id,
          kind: block.kind,
          ranges,
          marks: Object.fromEntries(MARKS.map(({ mark }) => [
            mark,
            ranges.every((range) => rangeHasMark(tree.by_id[range.blockId].content, range.start, range.end, mark)),
          ])) as Record<ToggleableMark, boolean>,
          link: ranges.every((range) => rangeLink(tree.by_id[range.blockId].content, range.start, range.end) === sharedLink)
            ? sharedLink
            : undefined,
          color: (() => {
            const shared = rangeColor(block.content, ranges[0].start, ranges[0].end);
            return ranges.every((range) => rangeColor(tree.by_id[range.blockId].content, range.start, range.end) === shared) ? shared : undefined;
          })(),
          text: ranges.length === 1 ? inlinePlainText(block.content).slice(ranges[0].start, ranges[0].end) : undefined,
        });
      }
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [blocksRef, pointerDown, readOnly, setFormat, tree]);

  const applyMarkToBlocks = useCallback((ranges: BlockTextRange[], mark: ToggleableMark | "link" | "color", value: boolean | string | undefined) => {
    const mutations: BlockMutation[] = [];
    const forceIds: string[] = [];
    for (const range of ranges) {
      const block = tree.by_id[range.blockId];
      if (!block || block.kind === "code") continue;
      const transaction = updateBlockContent(
        tree,
        block.id,
        applyMarkToRange(block.content, range.start, range.end, mark, value),
      );
      if (transaction) mutations.push(...transaction.mutations);
      forceIds.push(block.id);
    }
    if (!mutations.length) return;
    pendingTextSelection.current = { ranges, forceIds };
    execute({ mutations });
  }, [execute, pendingTextSelection, tree]);

  const applyMark = useCallback((mark: ToggleableMark | "link" | "color", value: boolean | string | undefined) => {
    if (format) applyMarkToBlocks(format.ranges, mark, value);
  }, [applyMarkToBlocks, format]);

  /** ⌘K: the toolbar for the words selected, its Link box open. */
  const openLink = useCallback(() => {
    updateFormat.current();
    setFormat((current) => current && { ...current, linkRequested: true });
  }, [setFormat]);

  return { updateFormat, applyMark, applyMarkToBlocks, openLink };
}
