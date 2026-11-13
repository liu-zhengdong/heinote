import { Link2 } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Popover } from "../../components/Popover";
import { linkifyContent } from "../../core/autolink";
import {
  applyMarkToRange,
  inlinePlainText,
  inlineToHtml,
  isWebAddress,
  isWebLink,
  rangeHasMark,
  rangeLink,
  replaceRange,
  sameInlineContent,
  type ToggleableMark,
} from "../../core/inline-content";
import { imeComposing } from "../../core/keyboard";
import { normalizeCell } from "../../core/simple-table";
import { replaceInTitle, titleRuns } from "../../core/title";
import type { InlineContent } from "../../core/types";
import { contentOfRuns, storedRuns } from "../../core/stored-runs";
import { preserveTextDraft, renderedText, withTextBasis, type BoundText } from "../../collaboration/binding";
import { captureSelection, readText, resolveSelection } from "../../collaboration/text";
import type { AnchorRect } from "../../hooks/useAnchoredPosition";
import type { DismissReason } from "../../hooks/useDismiss";
import { LinkForm, linkHref, selectedAddress } from "./FormatToolbar";
import { inlineFromNodes, keptOffset } from "./rich-text";
import { focusRange, selectionOffsets, selectionRect } from "./selection";
import { markForKey, MARKS } from "./marks";

/* Words typed outside a page's paragraphs — a page's name (TitleField), a
   simple table's cell (SimpleTable) — in one line of `contenteditable` of
   their own, which the page's block editor never treats as a paragraph. What
   the field may hold is its grammar's: a name is words and links on one
   line; a cell is words, marks and links, over as many lines as Shift+Enter
   makes.

   - Words selected and a web address pasted over them link those words; an
     address pasted with nothing selected goes in linked; anything else is
     pasted as words (on one line, in a name).
   - Words selected by hand — the pointer, Shift and the arrows, ⌘A; never a
     select-all made for a rename, nor words a link was pasted over — bring a
     small bar: Link (the text toolbar's own Link box, in the bar's place, so
     one popover stands at a time), and a cell's marks. ⌘K opens the box.
   - A click on a link opens it (a web address in a new tab); a click that
     ends a selection does not.
   - The field is drawn from its words only while it does not hold the caret,
     or when they changed from elsewhere (another member, undo) — never under
     a live caret for nothing, and never mid-composition. */

export interface FieldGrammar {
  /** Words made fit for the field. */
  normalize(content: InlineContent): InlineContent;
  /** The field's markup for its words. */
  html(content: InlineContent): string;
  /** Elements that may stand in the field; a browser's stray others (a rich
   *  drop, an emptied field's <br>) are drawn away at once. */
  tags: ReadonlySet<string>;
  /** Shift+Enter makes a new line in the field. */
  lines: boolean;
  /** ⌘B, ⌘I, ⌘U, ⌘⇧S and ⌘E mark words, and the bar offers them. */
  marks: boolean;
}

/** A page's name: words and links, one line (core/title.ts). */
export const NAME_GRAMMAR: FieldGrammar = {
  normalize: titleRuns,
  html: (content) => inlineToHtml(content),
  tags: new Set(["A"]),
  lines: false,
  marks: false,
};

/** A simple table's cell: words, marks and links, over lines of its own. As
 *  a paragraph's editable, a final line break gets a `<br>` after it, which
 *  no offset sees and reading drops, so the empty line it starts shows. */
export const CELL_GRAMMAR: FieldGrammar = {
  normalize: normalizeCell,
  html: (content) => {
    const html = inlineToHtml(content, undefined, true);
    return inlinePlainText(content).endsWith("\n") ? `${html}<br>` : html;
  },
  tags: new Set(["A", "STRONG", "B", "EM", "I", "U", "S", "CODE", "BR", "SPAN"]),
  lines: true,
  marks: true,
};

const POP_GROUP = "field-bar";
/** The words the field shows now, read back. */
function shownWords(element: HTMLElement, grammar: FieldGrammar): InlineContent {
  return grammar.normalize(inlineFromNodes(element));
}

/** Whether the field holds only markup its grammar draws. */
function holdsOnly(element: HTMLElement, grammar: FieldGrammar): boolean {
  for (const child of element.querySelectorAll("*")) {
    if (!grammar.tags.has(child.tagName)) return false;
  }
  return true;
}

/** Words selected in the field: where, and what they are now. */
interface FieldSelection {
  anchor: AnchorRect;
  start: number;
  end: number;
  link?: string;
  marks: Record<ToggleableMark, boolean>;
  words: string;
}

/** Opens a link from a field: a web address in a new tab, a page of this
 *  workspace (`#page`) by the place's own `onOpenPage`. */
export function followHref(href: string, full: boolean, onOpenPage?: (href: string, full: boolean) => void): void {
  if (isWebLink(href)) window.open(href, "_blank", "noopener,noreferrer");
  else if (href.startsWith("#")) onOpenPage?.(href, full);
}

export interface RichFieldProps {
  grammar: FieldGrammar;
  content: InlineContent;
  className: string;
  label: string;
  placeholder: string;
  readOnly?: boolean;
  collaboration?: { pageId: string; key: string };
  /** `data-history-field`: undo brings the caret back here. */
  historyField?: string;
  /** Takes the caret when it appears: all of it selected, or after it. */
  focusOnMount?: "all" | "end";
  elementRef?: (element: HTMLElement | null) => void;
  onChange(next: InlineContent): void;
  /** The place's own keys — Enter, Escape, Tab, the arrows. A key it
   *  prevents is spent. */
  onKeyDown?(event: KeyboardEvent<HTMLElement>): void;
  /** A paste the place takes itself (a grid into a table); true when it did. */
  onPasteFirst?(event: ClipboardEvent<HTMLElement>): boolean;
  onFocus?(): void;
  /** The field let go of — never for its own bar or Link box taking the focus. */
  onBlur?(): void;
  /** A link to a page of this workspace, clicked. */
  onOpenPage?(href: string, full: boolean): void;
}

export function RichField({
  grammar,
  content,
  className,
  label,
  placeholder,
  readOnly = false,
  collaboration,
  historyField,
  focusOnMount,
  elementRef,
  onChange,
  onKeyDown,
  onPasteFirst,
  onFocus,
  onBlur,
  onOpenPage,
}: RichFieldProps) {
  const ref = useRef<HTMLElement | null>(null);
  const composing = useRef(false);
  const bound = useRef<BoundText | null>(null);
  const lastInput = useRef<InlineContent | null>(null);
  const compositionTimer = useRef<number | null>(null);
  const compositionFrame = useRef<number | null>(null);
  const compositionDraft = useRef<{ bound: BoundText | null; content: InlineContent; address?: { pageId: string; key: string } } | null>(null);
  const commit = useRef<() => void>(() => {});
  const sync = useRef<() => void>(() => {});
  const [bar, setBar] = useState<FieldSelection | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState("");

  const saveDraft = (draft: NonNullable<typeof compositionDraft.current>) => {
    if (draft.bound) preserveTextDraft(draft.bound, storedRuns(draft.content));
    else if (draft.address) window.dispatchEvent(new CustomEvent("notes:save-refused", { detail: {
      message: "编辑位置已变化。输入中的文字已保留为草稿。", writes: [],
      documents: [{ pageId: draft.address.pageId, fields: { [draft.address.key]: storedRuns(draft.content) } }],
    } }));
  };
  const run = (action: () => void): boolean => {
    const previous = bound.current;
    if (previous) {
      const current = renderedText(previous.field.pageId, previous.field.key);
      if (!current || current.field.text !== previous.field.text || current.field.generation !== previous.field.generation) {
        if (ref.current) saveDraft({ bound: previous, content: shownWords(ref.current, grammar) });
        sync.current();
        return false;
      }
    }
    /* `lastInput` names what the DOM last showed: a commit that lands before
       a basis exists must only touch shared words it actually saw. */
    const updated = withTextBasis(previous, action,
      collaboration && lastInput.current ? { key: collaboration.key, content: storedRuns(lastInput.current) } : undefined);
    if (bound.current === previous) bound.current = updated;
    return true;
  };

  useEffect(() => () => {
    if (compositionTimer.current !== null) window.clearTimeout(compositionTimer.current);
    if (compositionFrame.current !== null) window.cancelAnimationFrame(compositionFrame.current);
    if (compositionDraft.current) saveDraft(compositionDraft.current);
  }, []);

  /* Capture a basis only after these shared runs are actually in the DOM. */
  useLayoutEffect(() => {
    sync.current = () => {
      const element = ref.current;
      if (!element || composing.current) return;
      const nextBound = collaboration ? renderedText(collaboration.pageId, collaboration.key) : null;
      const wantedContent = nextBound ? grammar.normalize(contentOfRuns(readText(nextBound.field.text))) : content;
      const html = grammar.html(wantedContent);
      if (document.activeElement !== element) {
        if (element.innerHTML !== html) element.innerHTML = html;
      } else {
        const showing = shownWords(element, grammar);
        if (!sameInlineContent(showing, wantedContent) || !holdsOnly(element, grammar)) {
          const selection = selectionOffsets(element);
          const anchored = selection && bound.current ? captureSelection(bound.current.basis, selection.start, selection.end) : null;
          const resolved = anchored && nextBound ? resolveSelection(nextBound.field.text, anchored) : null;
          const shown = inlinePlainText(showing);
          const wanted = inlinePlainText(wantedContent);
          element.innerHTML = html;
          if (selection) focusRange(element,
            resolved?.start ?? keptOffset(shown, wanted, selection.start),
            resolved?.end ?? keptOffset(shown, wanted, selection.end));
        }
      }
      element.toggleAttribute("data-blank", !element.textContent);
      bound.current = nextBound;
      lastInput.current = wantedContent;
    };
    sync.current();
  }, [content, grammar, collaboration?.pageId, collaboration?.key]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!focusOnMount || !element || readOnly) return;
    const length = element.textContent?.length ?? 0;
    focusRange(element, focusOnMount === "all" ? 0 : length, length);
    // Only as it appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* What the field does not hold is refused before it is made: a paragraph
     break always, a line break where there are no lines (the field makes its
     own), and the browser's own bold and italic. */
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const refuse = (event: InputEvent) => {
      if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak" || event.inputType.startsWith("format")) {
        event.preventDefault();
      }
    };
    element.addEventListener("beforeinput", refuse);
    return () => element.removeEventListener("beforeinput", refuse);
  }, []);

  /** Draws `next` at once, the caret or selection placed, and writes it. */
  const draw = (next: InlineContent, start: number, end = start) => {
    const element = ref.current;
    if (!element || composing.current) return;
    element.innerHTML = grammar.html(next);
    element.toggleAttribute("data-blank", !element.textContent);
    focusRange(element, start, end);
    lastInput.current = next;
    run(() => onChange(next));
  };

  /** The words selected in the field now, when there are some. */
  const measure = (): FieldSelection | null => {
    const element = ref.current;
    if (!element || document.activeElement !== element) return null;
    const offsets = selectionOffsets(element);
    const rect = selectionRect();
    if (!offsets || !rect || offsets.start === offsets.end) return null;
    const start = Math.min(offsets.start, offsets.end);
    const end = Math.max(offsets.start, offsets.end);
    const words = shownWords(element, grammar);
    return {
      anchor: { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right, width: rect.width, height: rect.height },
      start,
      end,
      link: rangeLink(words, start, end),
      marks: Object.fromEntries(MARKS.map(({ mark }) => [mark, rangeHasMark(words, start, end, mark)])) as Record<ToggleableMark, boolean>,
      words: inlinePlainText(words).slice(start, end),
    };
  };

  const offerBar = () => {
    if (readOnly) return;
    requestAnimationFrame(() => {
      if (!composing.current) setBar(measure());
    });
  };

  /* The bar follows the selection while it lasts, and goes with it. */
  useEffect(() => {
    if (!bar) return;
    const onSelectionChange = () => {
      // Typing the link takes the caret into the box.
      if (document.activeElement?.closest(`[data-pop-group="${POP_GROUP}"]`)) return;
      const next = measure();
      if (!next) {
        setBar(null);
        setLinkOpen(false);
      } else if (next.start !== bar.start || next.end !== bar.end) {
        setBar(next);
      }
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
    // `measure` reads the DOM, not state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bar]);

  const openBox = (at: FieldSelection) => {
    setBar(at);
    setHref(at.link ?? selectedAddress(at.words) ?? "");
    setLinkOpen(true);
  };

  const setLink = (value: string | undefined) => {
    const element = ref.current;
    const at = bar;
    setLinkOpen(false);
    setBar(null);
    if (!element || !at) return;
    draw(grammar.normalize(applyMarkToRange(shownWords(element, grammar), at.start, at.end, "link", value)), at.start, at.end);
  };

  /** A mark on the words selected, or off them when they all carry it. */
  const toggleMark = (mark: ToggleableMark, range?: { start: number; end: number }) => {
    const element = ref.current;
    if (!element || readOnly) return;
    const offsets = range ?? selectionOffsets(element);
    if (!offsets || offsets.start === offsets.end) return;
    const start = Math.min(offsets.start, offsets.end);
    const end = Math.max(offsets.start, offsets.end);
    const words = shownWords(element, grammar);
    const on = !rangeHasMark(words, start, end, mark);
    draw(grammar.normalize(applyMarkToRange(words, start, end, mark, on || undefined)), start, end);
    const next = measure();
    if (bar && next) setBar(next);
  };

  const closeBox = (reason: DismissReason) => {
    setLinkOpen(false);
    const element = ref.current;
    const at = bar;
    if (reason === "escape" && element && at) {
      // Back to the words, still selected and their bar with them, as the
      // text toolbar's box does.
      focusRange(element, at.start, at.end);
      return;
    }
    setBar(null);
    // Pressed away from the box: the field was let go of while the box held
    // the caret, so the place hears it now.
    requestAnimationFrame(() => {
      if (document.activeElement !== ref.current) onBlur?.();
    });
  };

  useLayoutEffect(() => {
    commit.current = () => {
      const element = ref.current;
      if (!element || composing.current) return;
      if (readOnly) {
        if (compositionDraft.current) saveDraft({ ...compositionDraft.current, content: shownWords(element, grammar) });
        return;
      }
      const next = shownWords(element, grammar);
      if (!holdsOnly(element, grammar)) {
        const selection = selectionOffsets(element);
        element.innerHTML = grammar.html(next);
        if (selection) focusRange(element, selection.start, selection.end);
      }
      element.toggleAttribute("data-blank", !element.textContent);
      if (lastInput.current && sameInlineContent(lastInput.current, next)) return;
      lastInput.current = next;
      run(() => onChange(next));
    };
  });

  const onInput = () => {
    const element = ref.current;
    // Preedit changes the visible words before it changes the saved content.
    if (element) element.toggleAttribute("data-blank", !element.textContent);
    if (composing.current) {
      if (ref.current) compositionDraft.current = { bound: bound.current, content: shownWords(ref.current, grammar), address: collaboration };
      return;
    }
    commit.current();
  };

  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (imeComposing(event)) return;
    const meta = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    // A new line of the field's own comes before the place's Enter.
    if (event.key === "Enter" && event.shiftKey && grammar.lines && !meta) {
      event.preventDefault();
      const element = ref.current;
      if (!element || readOnly) return;
      const words = shownWords(element, grammar);
      const length = inlinePlainText(words).length;
      const offsets = selectionOffsets(element) ?? { start: length, end: length };
      const start = Math.min(offsets.start, offsets.end);
      const end = Math.max(offsets.start, offsets.end);
      draw(grammar.normalize(replaceRange(words, start, end, "\n")), start + 1);
      return;
    }
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Enter") {
      event.preventDefault();
      return;
    }
    if (meta && !event.altKey) {
      const mark = markForKey(event);
      if (mark && (grammar.marks || mark === "bold" || mark === "italic" || mark === "underline")) {
        // A name holds no marks: the browser's own are refused too.
        event.preventDefault();
        if (grammar.marks) toggleMark(mark);
        return;
      }
      if (key === "k" && !event.shiftKey && !readOnly) {
        // Words selected: their Link box. Nothing selected: left to Quick Find.
        const at = measure();
        if (!at) return;
        event.preventDefault();
        openBox(at);
      }
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLElement>) => {
    if (onPasteFirst?.(event)) return;
    event.preventDefault();
    const element = ref.current;
    if (!element || readOnly) return;
    const text = event.clipboardData.getData("text/plain");
    // A picture, or nothing: the field takes words only.
    if (!text) return;
    const words = shownWords(element, grammar);
    const length = inlinePlainText(words).length;
    const offsets = selectionOffsets(element) ?? { start: length, end: length };
    const start = Math.min(offsets.start, offsets.end);
    const end = Math.max(offsets.start, offsets.end);
    const address = text.trim();
    setBar(null);
    setLinkOpen(false);
    // A web address pasted over selected words links THOSE words.
    if (start !== end && isWebAddress(address)) {
      draw(grammar.normalize(applyMarkToRange(words, start, end, "link", address)), start, end);
      return;
    }
    // Anything else is words — one line in a name — an address among them
    // linked.
    const line = grammar.lines
      ? text.replace(/\r\n?/g, "\n").replace(/\n$/, "")
      : text.replace(/\r?\n$/, "").replace(/\s*[\r\n]+\s*/g, " ");
    const inserted = grammar.lines ? replaceRange(words, start, end, line) : replaceInTitle(words, start, end, line);
    draw(grammar.normalize(linkifyContent(inserted, start, start + line.length)), start + line.length);
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    // A file dropped on the field is not its; words dropped are typed in.
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  };

  const onClick = (event: ReactMouseEvent<HTMLElement>) => {
    const anchor = (event.target as Element | null)?.closest?.("a[href]");
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    event.preventDefault();
    // A click that ends a selection was selecting words, not pressing the link.
    if (window.getSelection()?.isCollapsed === false) return;
    followHref(anchor.getAttribute("href") ?? "", event.metaKey || event.ctrlKey, onOpenPage);
  };

  const onFieldBlur = (event: FocusEvent<HTMLElement>) => {
    // The field's own bar or Link box taking the caret is not a letting go.
    if ((event.relatedTarget as Element | null)?.closest?.(`[data-pop-group="${POP_GROUP}"]`)) return;
    setBar(null);
    setLinkOpen(false);
    sync.current();
    onBlur?.();
  };

  return (
    <>
      <span
        ref={(element: HTMLElement | null) => {
          ref.current = element;
          elementRef?.(element);
        }}
        className={`title-field ${className}`}
        contentEditable={!readOnly}
        suppressContentEditableWarning
        role="textbox"
        aria-label={label}
        aria-multiline={grammar.lines}
        aria-placeholder={placeholder}
        aria-readonly={readOnly || undefined}
        data-placeholder={placeholder}
        data-history-field={historyField}
        data-collaboration-page={collaboration?.pageId}
        data-collaboration-field={collaboration?.key}
        onInput={onInput}
        onKeyDown={(event) => { if (!composing.current && !run(() => onKey(event))) event.preventDefault(); }}
        onKeyUp={(event) => {
          if (event.shiftKey || event.key === "Shift" || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a")) offerBar();
        }}
        /* pointerup, not mouseup: a cell's press is prevented at pointerdown
           (SimpleTable), which swallows the whole compat-mouse stream —
           mouseup never arrives there, pointerup still does. */
        onPointerUp={offerBar}
        onPaste={(event) => { if (!composing.current && !run(() => onPaste(event))) event.preventDefault(); }}
        onDrop={onDrop}
        onDragStart={(event) => event.preventDefault()}
        onClick={onClick}
        onFocus={onFocus}
        onBlur={onFieldBlur}
        onCompositionStart={() => {
          if (compositionTimer.current !== null) {
            window.clearTimeout(compositionTimer.current);
            compositionTimer.current = null;
            composing.current = false;
            commit.current();
          }
          composing.current = true;
          if (ref.current) compositionDraft.current = { bound: bound.current, content: shownWords(ref.current, grammar), address: collaboration };
        }}
        onCompositionEnd={() => {
          if (ref.current) compositionDraft.current = { bound: bound.current, content: shownWords(ref.current, grammar), address: collaboration };
          if (compositionTimer.current !== null) window.clearTimeout(compositionTimer.current);
          // Keep the DOM and basis fixed through Safari's trailing input.
          compositionTimer.current = window.setTimeout(() => {
            compositionTimer.current = null;
            composing.current = false;
            if (!ref.current?.isConnected) return;
            commit.current();
            compositionDraft.current = null;
            compositionFrame.current = window.requestAnimationFrame(() => {
              compositionFrame.current = null;
              sync.current();
            });
          }, 0);
        }}
      />
      {bar && !readOnly && !linkOpen ? (
        <Popover
          open
          anchor={bar.anchor}
          placement="top-start"
          gap={8}
          role="toolbar"
          label={grammar.marks ? "Cell formatting" : "Name"}
          group={POP_GROUP}
          onDismiss={() => setBar(null)}
        >
          <div className="format-bar">
            {grammar.marks ? (
              <div className="format-bar__group">
                {MARKS.map(({ mark, label: markLabel, icon: Icon }) => (
                  <button
                    type="button"
                    key={mark}
                    className={`icon-btn ${bar.marks[mark] ? "is-on" : ""}`}
                    aria-label={markLabel}
                    aria-pressed={bar.marks[mark]}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => toggleMark(mark, bar)}
                  >
                    <Icon size={15} />
                  </button>
                ))}
              </div>
            ) : null}
            <div className="format-bar__group">
              <button
                type="button"
                className={`format-bar__turn ${bar.link ? "is-on" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => openBox(bar)}
              >
                <Link2 size={15} />{bar.link ? "Edit link" : "Link"}
              </button>
            </div>
          </div>
        </Popover>
      ) : null}
      <Popover
        open={linkOpen && Boolean(bar)}
        anchor={bar?.anchor ?? null}
        gap={8}
        placement="bottom-start"
        role="dialog"
        label="Link"
        group={POP_GROUP}
        closeOnScroll={false}
        onDismiss={closeBox}
      >
        <LinkForm
          value={href}
          linked={Boolean(bar?.link)}
          onValue={setHref}
          onSubmit={() => setLink(linkHref(href))}
          onRemove={() => setLink(undefined)}
        />
      </Popover>
    </>
  );
}
