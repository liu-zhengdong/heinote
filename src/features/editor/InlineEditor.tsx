import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type CompositionEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { inlineFromText, inlinePlainText, inlineSignature, sameInlineContent, type DescribeMention } from "../../core/inline-content";
import type { Block, InlineContent } from "../../core/types";
import { contentOfRuns, storedRuns } from "../../core/stored-runs";
import type { RichText } from "../../platform/schema";
import { collaborationFieldTick, fieldIsOurs, fieldStale, subscribeCollaboration } from "../../collaboration/client";
import { preserveTextDraft, refreshTextBinding, renderedText, withTextBasis, type BoundText } from "../../collaboration/binding";
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
  onBeforeInput,
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
  /** A character about to be typed — an input method's commit reaches here
   *  without a printable keydown. Answers whether the editor took it. */
  onBeforeInput(element: HTMLElement, data: string | null): boolean;
  onPaste(event: ClipboardEvent<HTMLElement>): void;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const composing = useRef(false);
  const bound = useRef<BoundText | null>(null);
  const lastInput = useRef<InlineContent | null>(null);
  const compositionTimer = useRef<number | null>(null);
  const compositionFrame = useRef<number | null>(null);
  /* A collaborative change that never moves this block's record still has
   *  to resync: the bound Y.Text lives outside the record prop, so without
   *  a per-field subscription a remote delta under an unchanged record
   *  leaves the DOM frozen at whatever the last render decided. */
  const collaborationTick = useSyncExternalStore(
    subscribeCollaboration,
    () => collaboration ? collaborationFieldTick(collaboration.pageId, collaboration.key) : "none",
  );
  const commit = useRef<(element: HTMLElement) => void>(() => {});
  const compositionDraft = useRef<{ bound: BoundText | null; content: InlineContent; address?: { pageId: string; key: string } } | null>(null);
  /** The HTML last written into a focused code block, to tell a redraw that
   *  is needed from one that is not. */
  const drawn = useRef("");
  const sync = useRef<(marks?: boolean) => void>(() => {});
  /** The once-registered `beforeinput` listener calls through these so it
   *  always reaches this render's `run` and `onBeforeInput`. */
  const runRef = useRef<(action: () => void) => boolean>(() => true);
  const beforeInputRef = useRef(onBeforeInput);
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
  /* A field can draw before its collaborative session exists, and nothing
     re-runs sync when the session arrives — the first commit then has no
     shown basis at all. Adopt one only while the shared words still equal
     what the DOM drew; when they do not, the DOM is stale and a naive diff
     would bury words it never showed. */
  const adoptBound = (): BoundText | null => {
    if (bound.current || !collaboration) return bound.current;
    const live = renderedText(collaboration.pageId, collaboration.key);
    if (live && lastInput.current && sameInlineContent(contentOfRuns(readText(live.field.text)), lastInput.current)) bound.current = live;
    return bound.current;
  };
  const run = (action: () => void): boolean => {
    let previous = bound.current;
    if (previous) {
      const current = refreshTextBinding(previous);
      if (!current) {
        /* A dead binding (stale session, generation swap) must not swallow
           the action: the event still has to reach onKeyDown/onPaste so the
           record write lands. The binding itself stays dead — its DOM was
           never drawn from the new document's atoms, so a commit authored
           from it is refused into a draft instead of laundered into a
           fresh-generation write over text it predates. */
        if (ref.current) saveDraft({ bound: previous, content: readDom(ref.current) });
      } else {
        previous = current; bound.current = current;
      }
    }
    const updated = withTextBasis(previous, action);
    // A synchronous render may already have drawn and captured newer runs.
    if (bound.current === previous) bound.current = updated;
    return true;
  };

  /* `beforeinput` natively, not through React: an input method's committed
     character (a Chinese keyboard's `·`, `＊`, `【`) reaches it with the
     selection still standing, and React's synthetic `onBeforeInput` does not
     carry it. */
  useLayoutEffect(() => {
    runRef.current = run;
    beforeInputRef.current = onBeforeInput;
  });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const beforeInput = (event: InputEvent) => {
      if (composing.current || event.inputType !== "insertText" && event.inputType !== "insertReplacementText") return;
      let taken = false;
      const allowed = runRef.current(() => { taken = beforeInputRef.current(element, event.data); });
      if (!allowed || taken) event.preventDefault();
    };
    element.addEventListener("beforeinput", beforeInput);
    return () => element.removeEventListener("beforeinput", beforeInput);
  }, []);

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
      if (!adoptBound() && collaboration) {
        const live = renderedText(collaboration.pageId, collaboration.key);
        if (live && !sameInlineContent(content, contentOfRuns(readText(live.field.text)))) {
          saveDraft({ bound: live, content, address: collaboration });
          lastInput.current = content;
          sync.current(true);
          return;
        }
      }
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
      /* A bound field may only rewrite the element when its text is outside
       *  our own write chain: genuinely remote (past the latest delta for a
       *  local write, and equal to neither the base nor the result of an
       *  in-flight commit). Everything else — a stale seed, an older commit's
       *  echo, the acknowledgment for the newest one — is our own text on
       *  its way back, and the DOM already carries at least that. */
      const boundRuns = nextBound ? readText(nextBound.field.text) : null;
      const chain: { next?: RichText } = {};
      /* A bound equal to the record prop cannot be a lagging echo: both
       *  mirror the same committed record, so the field already carries
       *  current truth. Stale only matters while the field lags the
       *  record — then redrawing it would tear the newer text. */
      const stale = boundRuns !== null && collaboration != null
        && !sameInlineContent(contentOfRuns(boundRuns), block.content)
        && fieldStale(collaboration.pageId, collaboration.key);
      const ours = boundRuns !== null && collaboration != null && fieldIsOurs(collaboration.pageId, collaboration.key, boundRuns, chain);
      /* While a write is in flight the field can only ever show chain
       *  values or their echoes; a bound matching neither is not newer —
       *  it is simply not ours, so the focused DOM stays ahead. A true
       *  peer merge lands after the pending entries settle, when the
       *  next projection renders it fresh again. */
      const remote = boundRuns !== null && !stale && !ours && chain.next === undefined;
      /* A bound behind the record prop is a lagging echo: the prop already
       *  carries a newer value, so the echo may not overwrite it. A peer's
       *  write lands in both at once, so a true remote still wins. */
      const boundContent = remote && boundRuns && !sameInlineContent(contentOfRuns(boundRuns), block.content) ? null : remote && boundRuns ? contentOfRuns(boundRuns) : null;
      const showing = document.activeElement === element ? readDom(element) : null;
      const chainHead = chain.next ? contentOfRuns(chain.next) : null;
      /* The focused DOM shows a programmatic value — never an edit — while
       *  it carries the same text the element last submitted and the chain
       *  carries nothing different. A write that settles this field to
       *  something other than the submitted text — a split truncating the
       *  element, undo, redo, recovered pending text — outranks the DOM:
       *  the submitted text is then simply an older value, not user intent.
       *  Plain typing submits the same text the chain holds, so nothing
       *  mid-typing ever tears. */
      const wroteElsewhere = chainHead !== null && (lastInput.current === null || !sameInlineContent(chainHead, lastInput.current));
      const content = boundContent ?? (wroteElsewhere ? chainHead : showing ?? chainHead ?? block.content);
      const html = editableHtml({ ...block, content }, describe);
      element.toggleAttribute("data-blank", !inlinePlainText(content));
      if (document.activeElement !== element) {
        if (element.innerHTML !== html) element.innerHTML = html;
        drawn.current = html;
        bound.current = nextBound;
        lastInput.current = content;
        return;
      }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block, code, coloured, describe, collaboration?.pageId, collaboration?.key, collaborationTick]);

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
        compositionDraft.current = { bound: bound.current ?? adoptBound(), content: readDom(event.currentTarget), address: collaboration };
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
