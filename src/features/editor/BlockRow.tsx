import { Check, ChevronRight, Copy, GripVertical, Plus } from "lucide-react";
import { memo, type CSSProperties, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import type { AnchorRect } from "../../hooks/useAnchoredPosition";
import { rectOf } from "../../hooks/useAnchoredPosition";
import { Tooltip } from "../../components/Tooltip";
import { Select } from "../../components/Select";
import { inlinePlainText } from "../../core/inline-content";
import type { DescribeMention } from "../../core/inline-content";
import type { Block, InlineContent } from "../../core/types";
import { blockField } from "../../collaboration/protocol";
import { blockRecordId } from "../../platform/record-ids";
import { blockDefinition } from "./block-registry";
import { CODE_LANGUAGES, codeLanguage } from "./code-highlight";
import { InlineEditor } from "./InlineEditor";
import { EmbedBlock, type EmbedActions } from "./EmbedBlock";
import { FileBlock, type MediaActions, type UploadState } from "./MediaBlocks";
import { SimpleTable, type TableActions } from "./SimpleTable";

const BULLETS = ["•", "◦", "▪"];

/** Notion cycles list markers by depth so nesting stays readable without
 *  colour or extra rules. */
export function bulletFor(depth: number): string {
  return BULLETS[depth % BULLETS.length];
}

export function numberFor(value: number, depth: number): string {
  if (depth % 3 === 1) return `${String.fromCharCode(96 + ((value - 1) % 26) + 1)}.`;
  if (depth % 3 === 2) return `${romanize(value)}.`;
  return `${value}.`;
}

function romanize(value: number): string {
  const table: Array<[number, string]> = [[10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let remaining = value;
  let result = "";
  for (const [amount, symbol] of table) {
    while (remaining >= amount) {
      result += symbol;
      remaining -= amount;
    }
  }
  return result || "i";
}

export interface BlockRowProps {
  block: Block;
  /** The page that stores this block, including when drawn in another page. */
  owningPageId?: string;
  depth: number;
  index: number;
  /** Blocks whose first line this is: their marks stand before it, and the
   *  "+" before them. */
  lineMarks?: number;
  /** How many blocks hold this line: with its list depth, how far in from
   *  the page's column its words are, so its "+" and handle stand in the one
   *  column before every line's. */
  frames?: number;
  readOnly: boolean;
  selected: boolean;
  lonely: boolean;
  dragging: boolean;
  dropEdge: "above" | "below" | "inside" | null;
  /** An upload this session is making for the block, if any. */
  upload?: UploadState;
  slot?: ReactNode;
  /** Drawn under the paragraph: the blocks its links show in this page. */
  after?: ReactNode;
  /** Drawn instead of the paragraph: a line that is nothing but a shown link
   *  to a block is that block, here as much as in the page it was made in. */
  replace?: ReactNode;
  /** A sub-page's row, or a folded database's: how many links it has from
   *  outside where it lives. */
  references?: number;
  /** A line that is nothing but a link, folded: drawn as the row of what it
   *  links — its mark and count at the start of the line — the link's name
   *  after them. */
  linkLine?: LinkLine;
  actions: BlockActions;
}

/** What a line that is nothing but a link shows of what it links. */
export interface LinkLine {
  /** The page or block linked. */
  target: string;
  label: string;
  mark: ReactNode;
  /** Its links from outside where it lives. */
  count: number;
  /** It cannot be shown here: gone, out of reach, on screen already. */
  still: boolean;
}

/** What a row can ask its editor to do. The editor hands every row the same
 *  object for its whole life, so a row is rendered again only when its own
 *  block (or how it is shown) changes — not on every keystroke elsewhere. */
export interface BlockActions extends MediaActions, TableActions, EmbedActions {
  /** The margin's "+": a new line below the row (`above`: before it), the
   *  slash menu open on it. */
  add(block: Block, anchor: AnchorRect, above: boolean): void;
  dragOver(block: Block, event: DragEvent<HTMLDivElement>): void;
  drop(event: DragEvent<HTMLDivElement>): void;
  toggleCheck(block: Block): void;
  /** A line that is nothing but a link: show what it links here, by its
   *  mark… */
  toggleLink(block: Block): void;
  /** …or open its menu (right-click). */
  openLinkMenu(block: Block, anchor: AnchorRect): void;
  /** A page's line, by its mark: what links to the page… */
  openBacklinks(pageId: string, anchor: AnchorRect): void;
  /** …and moving the line by it. */
  rowDragStart(block: Block, event: DragEvent<HTMLButtonElement>): void;
  rowDragEnd(): void;
  /** A table's handle pressed (or right-clicked): the table selected, and
   *  its paragraph menu open, as ⌘/ opens it. */
  openBlockMenu(block: Block, anchor: AnchorRect): void;
  /** A page's name pressed: beside the page, in the side peek — or, `full`
   *  (⌘-click), full-page. */
  openLinkedPage(pageId: string, full: boolean): void;
  setLanguage(block: Block, language: string): void;
  copyCode(block: Block): void;
  pickIcon(block: Block, anchor: AnchorRect): void;
  change(block: Block, content: InlineContent, text: string, element: HTMLElement, composing: boolean): void;
  describeMention: DescribeMention;
  keyDown(block: Block, event: KeyboardEvent<HTMLElement>): void;
  paste(block: Block, event: ClipboardEvent<HTMLElement>): void;
}

/** The mark of a page's row — a sub-page's, a folded database's, a line that
 *  is nothing but a link — at the start of the line, where the block's mark
 *  is when it is shown: its icon at rest and, under the pointer, the
 *  triangle that shows it here; drag it to move the line, right-click it
 *  for its menu. On its corner, how many links it has from outside. */
function RowMark({
  label,
  mark,
  count,
  still,
  disabled = false,
  readOnly,
  onShow,
  onCount,
  onMenu,
}: {
  label: string;
  mark: ReactNode;
  count: number;
  still: boolean;
  disabled?: boolean;
  readOnly: boolean;
  onShow(): void;
  onCount(anchor: AnchorRect): void;
  onMenu(anchor: AnchorRect): void;
}) {
  return (
    <span className="block__page-mark">
      <Tooltip label="Show here" hint={readOnly ? "Right-click for more" : "Drag to move · right-click for more"}>
        <button
          type="button"
          className={`block__page-toggle ${still ? "is-static" : ""}`}
          aria-label={`Show ${label} here`}
          aria-expanded={false}
          aria-haspopup="menu"
          disabled={disabled}
          // A press that moves carries the link it marks (pictures.ts).
          onClick={() => { if (!still) onShow(); }}
          onContextMenu={(event) => {
            event.preventDefault();
            onMenu(rectOf(event.currentTarget));
          }}
        >
          <span className="block__page-icon">{mark}</span>
          <ChevronRight className="block__page-twist" size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      {count ? (
        <button
          type="button"
          className="block__page-refs"
          aria-label={`${count} backlink${count === 1 ? "" : "s"} to ${label}`}
          onClick={(event) => onCount(rectOf(event.currentTarget))}
        >
          {count > 99 ? "99+" : count}
        </button>
      ) : null}
    </span>
  );
}

export const BlockRow = memo(function BlockRow(props: BlockRowProps) {
  const { block, depth, index, lineMarks = 0, frames = 0, readOnly, linkLine, actions } = props;
  const definition = blockDefinition(block.kind);
  const done = block.kind === "todo" && block.checked === true;
  // Emptiness is a fact about the model, never about the DOM: a
  // contenteditable that has been typed into and cleared keeps a stray <br>.
  const empty = !inlinePlainText(block.content);

  const editable = (
    <InlineEditor
      block={block}
      readOnly={readOnly}
      collaboration={props.owningPageId ? { pageId: props.owningPageId, key: blockField(blockRecordId(props.owningPageId, block.id)) } : undefined}
      describe={actions.describeMention}
      onChange={(content, text, element, composing) => actions.change(block, content, text, element, composing)}
      onKeyDown={(event) => actions.keyDown(block, event)}
      onPaste={(event) => actions.paste(block, event)}
    />
  );

  return (
    <div
      className={[
        "block",
        `block--${block.kind}`,
        props.selected ? "is-selected" : "",
        props.lonely ? "is-lonely" : "",
        props.dragging ? "is-dragging" : "",
        empty ? "is-empty" : "",
        done ? "is-done" : "",
        linkLine ? "is-link-line" : "",
      ].filter(Boolean).join(" ")}
      data-block-id={block.id}
      data-color={block.color}
      data-align={block.align}
      data-drop={props.dropEdge ?? undefined}
      style={{ "--block-depth": depth, "--line-marks": lineMarks, "--frames": frames } as CSSProperties}
      onDragOver={(event) => actions.dragOver(block, event)}
      onDrop={actions.drop}
    >
      {/* Every line has, under the pointer, Notion's pair in the margin: the
          "+" that adds a line, and the ⋮⋮ handle that opens the line's menu
          (Turn into, Color, Group, Delete…) when pressed and moves the line
          when dragged — a table's too (Winston, round 61; every line's since).
          The first line of a group carries the group's handle instead, on
          its frame. */}
      {props.replace ?? <div className="block__content">
        {readOnly ? null : (
          <Tooltip label="Click to add below" hint="Alt-click to add above">
            <button
              type="button"
              className="block__add"
              contentEditable={false}
              // The keyboard's way in is "/"; a stop on every line would
              // make tabbing through a page a crawl.
              tabIndex={-1}
              aria-label="Add below"
              // The caret stays where it was until the new line takes it.
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => actions.add(block, rectOf(event.currentTarget), event.altKey)}
            >
              <Plus size={16} />
            </button>
          </Tooltip>
        )}
        {block.kind === "todo" ? (
          <span className="block__marker">
            <button
              type="button"
              className={`checkbox ${block.checked ? "is-checked" : ""}`}
              aria-label={block.checked ? "Mark as not done" : "Mark as done"}
              aria-pressed={Boolean(block.checked)}
              disabled={readOnly}
              onClick={() => actions.toggleCheck(block)}
            >
              {block.checked ? <Check size={12} strokeWidth={3} /> : null}
            </button>
          </span>
        ) : null}

        {block.kind === "bullet" ? <span className="block__marker block__marker--bullet" aria-hidden="true">{bulletFor(depth)}</span> : null}
        {block.kind === "numbered" ? <span className="block__marker block__marker--numbered" aria-hidden="true">{numberFor(index, depth)}</span> : null}
        {block.kind === "callout" ? (
          <button
            type="button"
            className="block__callout-icon"
            aria-label="Change callout icon"
            disabled={readOnly}
            onClick={(event) => actions.pickIcon(block, rectOf(event.currentTarget))}
          >
            {block.icon || "💡"}
          </button>
        ) : null}

        {block.kind === "divider" ? <hr className="block__rule" /> : null}

        {/* A line that is nothing but a link: the mark of what it links, at
            the start of the line, as a sub-page's row has it; its words stay
            words. */}
        {linkLine ? (
          <RowMark
            label={linkLine.label}
            mark={linkLine.mark}
            count={linkLine.count}
            still={linkLine.still || readOnly}
            readOnly={readOnly}
            onShow={() => actions.toggleLink(block)}
            onCount={(anchor) => actions.openBacklinks(linkLine.target, anchor)}
            onMenu={(anchor) => actions.openLinkMenu(block, anchor)}
          />
        ) : null}

        {!readOnly && lineMarks === 0 ? (
          <Tooltip label="Drag to move" hint="Click or ⌘/ to open menu">
            <button
              type="button"
              className="block__handle"
              contentEditable={false}
              tabIndex={-1}
              aria-label={block.kind === "table" ? "Table options" : "Line options"}
              aria-haspopup="menu"
              // No preventDefault on its press: that would stop the drag
              // before it began.
              draggable
              onDragStart={(event) => actions.rowDragStart(block, event)}
              onDragEnd={actions.rowDragEnd}
              onClick={(event) => actions.openBlockMenu(block, rectOf(event.currentTarget))}
              onContextMenu={(event) => {
                event.preventDefault();
                actions.openBlockMenu(block, rectOf(event.currentTarget));
              }}
            >
              <GripVertical size={14} />
            </button>
          </Tooltip>
        ) : null}

        {block.kind === "table" ? (
          <SimpleTable block={block} owningPageId={props.owningPageId} readOnly={readOnly} actions={actions} />
        ) : block.kind === "embed" ? (
          <div className="block__media">
            <EmbedBlock block={block} readOnly={readOnly} actions={actions} />
          </div>
        ) : block.kind === "file" ? (
          <div className="block__media">
            <FileBlock block={block} readOnly={readOnly} upload={props.upload} actions={actions} />
            {block.file ? editable : null}
          </div>
        ) : block.kind === "code" ? (
          <div className="block__code">
            <div className="block__code-bar" contentEditable={false}>
              <Select
                className="block__code-lang"
                aria-label="Code language"
                value={codeLanguage(block.language).id}
                disabled={readOnly}
                onValueChange={(language) => actions.setLanguage(block, language)}
                options={CODE_LANGUAGES.map((language) => ({ value: language.id, label: language.label }))}
                size="compact"
                variant="ghost"
              />
              <button type="button" className="icon-btn" aria-label="Copy code" onClick={() => actions.copyCode(block)}>
                <Copy size={14} />
              </button>
            </div>
            {editable}
          </div>
        ) : definition.editable ? editable : null}

        {props.slot}
      </div>}
      {props.after}
    </div>
  );
});
