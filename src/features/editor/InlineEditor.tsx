import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type CompositionEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { inlineFromText, inlinePlainText, inlineSignature, sameInlineContent, type DescribeMention } from "../../core/inline-content";
import type { Block, InlineContent } from "../../core/types";
import { contentOfRuns, storedRuns } from "../../core/stored-runs";
import { preserveTextDraft, renderedText, withTextBasis, type BoundText } from "../../collaboration/binding";
import { captureSelection, readText, resolveSelection } from "../../collaboration/text";
import { editableHtml } from "./block-html";
import { blockDefinition } from "./block-registry";
import { highlighterReady, whenHighlighterReady } from "./code-highlight";
import { inlineFromNodes, keptOffset } from "./rich-text";
import { focusRange, selectionOffsets } from "./selection";

/** One `contenteditable` per block.
 *
 * A block without the caret is simply drawn from the model. A block WITH the
 * caret is left alone while its words and the model's agree — typing there is
 * what the model came from, and rewriting under a live caret would collapse
 * the selection on every keystroke. Words that differ came from elsewhere
 * (another person, another window) and are written in at once, the caret kept
 * where it was among the words around it; left out, the next keystroke would
 * have written the old words back over theirs. Nothing is rewritten while an
 * input method is mid-composition; once it lets go, marks the editor changed
 * meanwhile are drawn too (typing on after inline Markdown). When the editor
 * itself changes a focused block — applying a mark, collapsing inline
 * Markdown — it also re-writes the DOM and places the caret itself, after this.
 *
 * A code block is the exception to leaving a focused block alone: its colours
 * depend on the words around each one, so it is redrawn after every change
 * (and once an input method lets go), the caret put back at the same offset. */
export const InlineEditor = memo(function InlineEditor({
  block,
  readOnly,
  describe,
  collaboration,
  onChange,
  onKeyDown,
  onPaste,
}: {
  block: Block;
  readOnly: boolean;
  collaboration?: { pageId: string; key: string };
  /** How a mention reads now. Stable for the editor's life; a title that
   *  changes later is redrawn by the editor, attribute by attribute. */
  describe?: DescribeMention;
  /** `composing` while an input method has the text: the DOM is not drawn
   *  again until it lets go. */
  onChange(content: InlineContent, text: string, element: HTMLElement, composing: boolean): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
  onPaste(event: ClipboardEvent<HTMLElement>): void;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const composing = useRef(false);
  const bound = useRef<BoundText | null>(null);
  const lastInput = useRef<InlineContent | null>(null);
  const compositionTimer = useRef<number | null>(null);
  const compositionFrame = useRef<number | null>(null);
  const commit = useRef<(element: HTMLElement) => void>(() => {});
  const compositionDraft = useRef<{ bound: BoundText | null; content: InlineContent; address?: { pageId: string; key: string } } | null>(null);
  /** The HTML last written into a focused code block, to tell a redraw that
   *  is needed from one that is not. */
  const drawn = useRef("");
  const sync = useRef<(marks?: boolean) => void>(() => {});
  const definition = blockDefinition(block.kind);
  const Tag = definition.tag ?? "div";
  const code = block.kind === "code";
  const [coloured, setColoured] = useState(highlighterReady);

  useEffect(() => {
    if (!code || coloured) return;
    return whenHighlighterReady(() => setColoured(true));
  }, [code, coloured]);

  const saveDraft = (draft: NonNullable<typeof compositionDraft.current>) => {
    if (draft.bound) preserveTextDraft(draft.bound, storedRuns(draft.content));
    else if (draft.address) window.dispatchEvent(new CustomEvent("notes:save-refused", { detail: {
      message: "编辑位置已变化。输入中的文字已保留为草稿。", writes: [],
      documents: [{ pageId: draft.address.pageId, fields: { [draft.address.key]: storedRuns(draft.content) } }],
    } }));
  };
  const readDom = (element: HTMLElement) => code ? inlineFromText(element.textContent ?? "") : inlineFromNodes(element);
  const run = (action: () => void): boolean => {
    const previous = bound.current;
    if (previous) {
      const current = renderedText(previous.field.pageId, previous.field.key);
      if (!current || current.field.text !== previous.field.text || current.field.generation !== previous.field.generation) {
        if (ref.current) saveDraft({ bound: previous, content: readDom(ref.current) });
        sync.current(true);
        return false;
      }
    }
    /* `lastInput` is what the DOM last actually showed: pass it through so a
       commit made before a basis exists (the session can arrive after mount)
       cannot erase shared words this element never drew. */
    const updated = withTextBasis(previous, action,
      collaboration && lastInput.current ? { key: collaboration.key, content: storedRuns(lastInput.current) } : undefined);
    // A synchronous render may already have drawn and captured newer runs.
    if (bound.current === previous) bound.current = updated;
    return true;
  };

  useLayoutEffect(() => {
    commit.current = (element) => {
      if (composing.current) return;
      if (readOnly) {
        if (compositionDraft.current) saveDraft({ ...compositionDraft.current, content: readDom(element) });
        return;
      }
      const text = element.textContent ?? "";
      const content = code ? inlineFromText(text) : inlineFromNodes(element);
      if (lastInput.current && sameInlineContent(lastInput.current, content)) return;
      lastInput.current = content;
      run(() => onChange(content, text, element, false));
    };
  });

  useEffect(() => () => {
    if (compositionTimer.current !== null) window.clearTimeout(compositionTimer.current);
    if (compositionFrame.current !== null) window.cancelAnimationFrame(compositionFrame.current);
    if (compositionDraft.current) saveDraft(compositionDraft.current);
  }, []);

  useLayoutEffect(() => {
    sync.current = (marks = false) => {
      const element = ref.current;
      if (!element || composing.current) return;
      const nextBound = collaboration ? renderedText(collaboration.pageId, collaboration.key) : null;
      const content = nextBound ? contentOfRuns(readText(nextBound.field.text)) : block.content;
      const html = editableHtml({ ...block, content }, describe);
      element.toggleAttribute("data-blank", !inlinePlainText(content));
      if (document.activeElement !== element) {
        if (element.innerHTML !== html) element.innerHTML = html;
        drawn.current = html;
        bound.current = nextBound;
        lastInput.current = content;
        return;
      }
      const showing = code ? null : inlineFromNodes(element);
      const shown = showing ? inlinePlainText(showing) : element.textContent ?? "";
      const wanted = inlinePlainText(content);
      const agree = showing
        ? marks || nextBound ? sameInlineContent(showing, content) : inlineSignature(showing) === inlineSignature(content)
        : html === drawn.current && shown === wanted;
      if (!agree) {
        const selection = selectionOffsets(element);
        const anchored = selection && bound.current ? captureSelection(bound.current.basis, selection.start, selection.end) : null;
        const resolved = anchored && nextBound ? resolveSelection(nextBound.field.text, anchored) : null;
        element.innerHTML = html;
        drawn.current = html;
        if (selection) focusRange(element,
          resolved?.start ?? keptOffset(shown, wanted, selection.start),
          resolved?.end ?? keptOffset(shown, wanted, selection.end));
      }
      // Capture only after the DOM contains these complete shared runs.
      bound.current = nextBound;
      lastInput.current = content;
    };
    sync.current();
  }, [block, code, coloured, describe, collaboration?.pageId, collaboration?.key]);

  return (
    <Tag
      ref={(node: HTMLElement | null) => { ref.current = node; }}
      className="block__editable"
      contentEditable={!readOnly && definition.editable}
      suppressContentEditableWarning
      dir="ltr"
      role="textbox"
      aria-multiline="true"
      aria-label={definition.label}
      data-placeholder={definition.placeholder}
      spellCheck={!code}
      data-collaboration-page={collaboration?.pageId}
      data-collaboration-field={collaboration?.key}
      onInput={(event: FormEvent<HTMLElement>) => {
        event.currentTarget.toggleAttribute("data-blank", !event.currentTarget.textContent);
        if (composing.current) {
          compositionDraft.current = { bound: bound.current, content: readDom(event.currentTarget), address: collaboration };
          return;
        }
        commit.current(event.currentTarget);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLElement>) => { if (!composing.current && !run(() => onKeyDown(event))) event.preventDefault(); }}
      onPaste={(event: ClipboardEvent<HTMLElement>) => { if (!composing.current && !run(() => onPaste(event))) event.preventDefault(); }}
      onCompositionStart={(event: CompositionEvent<HTMLElement>) => {
        if (compositionTimer.current !== null) {
          window.clearTimeout(compositionTimer.current);
          compositionTimer.current = null;
          composing.current = false;
          commit.current(event.currentTarget);
        }
        composing.current = true;
        compositionDraft.current = { bound: bound.current, content: readDom(event.currentTarget), address: collaboration };
      }}
      onCompositionEnd={(event: CompositionEvent<HTMLElement>) => {
        const element = event.currentTarget;
        compositionDraft.current = { bound: bound.current, content: readDom(element), address: collaboration };
        // Safari may update the DOM and emit input after compositionend.
        // Keep the basis fixed until that final native input has completed.
        if (compositionTimer.current !== null) window.clearTimeout(compositionTimer.current);
        compositionTimer.current = window.setTimeout(() => {
          compositionTimer.current = null;
          composing.current = false;
          if (!element.isConnected) return;
          commit.current(element);
          compositionDraft.current = null;
          compositionFrame.current = window.requestAnimationFrame(() => {
            compositionFrame.current = null;
            sync.current(true);
          });
        }, 0);
      }}
    />
  );
});
