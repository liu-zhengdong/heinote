import { ChevronRight, GripVertical } from "lucide-react";
import type { CSSProperties, DragEvent, ReactNode } from "react";
import { Tooltip } from "../../components/Tooltip";
import { rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import { PageIcon } from "./block-registry";

/** A page drawn in another — a block, a page or a database shown here — and
 *  marked as a page is wherever one stands: its mark at the start of its
 *  first line, inside it — its icon, a page's, or the emoji it was given,
 *  and under the pointer the triangle that folds it — and everything it
 *  holds one step in, hanging after the mark as a toggle's lines do in
 *  Notion, with a thin line from under the mark to its last line. How many
 *  links it has from outside is a count on the mark's corner. Under the
 *  pointer its handle shows beside the mark, as a table's does — Notion's
 *  ⋮⋮: pressed, the block's menu (Ungroup, Fold, Move to…); dragged, the
 *  block.
 *
 *  A block inside another is one step further in, its mark inside the block
 *  holding it, so nesting reads as it nests. Folded — for everyone — it is
 *  its row, a sub-page's: the same mark in the same place, its name where its
 *  words were; the row's mark shows it here again. The mark can be dragged
 *  and right-clicked as the handle can. */
export function PageFrame({
  pageId,
  name,
  title,
  mark,
  headKind = "text",
  depth,
  level = 0,
  shift = 0,
  readOnly,
  locked = false,
  menuOpen,
  dragging,
  references,
  onMenu,
  onDragStart,
  onDragEnd,
  onReferences,
  onToggle,
  children,
}: {
  pageId: string;
  /** What the block is called: its name, or its first line. */
  name: string;
  /** Its name, when it has one of its own: drawn as its first line. */
  title?: ReactNode;
  /** Its icon, when it has one of its own; a page's glyph otherwise. */
  mark?: ReactNode;
  /** What its first line is (a heading, a title…), so the mark sits level
   *  with it. */
  headKind?: string;
  /** The list depth of the paragraphs it holds: theirs is counted from it. */
  depth: number;
  /** How many blocks hold it: with its depth, how far in from the page's
   *  column it stands, so its handle stands in the column every line's does. */
  level?: number;
  /** How many list steps in it stands in the block holding it. */
  shift?: number;
  readOnly: boolean;
  /** Kept read only in this page (a block shown here from another). */
  locked?: boolean;
  menuOpen: boolean;
  dragging: boolean;
  /** How many links it has from outside the page it is in. */
  references: number;
  onMenu(anchor: AnchorRect): void;
  onDragStart(event: DragEvent<HTMLButtonElement>): void;
  onDragEnd(): void;
  onReferences(anchor: AnchorRect): void;
  /** The mark pressed: fold the block back onto its row, for everyone. */
  onToggle?: (pageId: string) => void;
  children: ReactNode;
}) {
  const hint = [locked ? "Read only here" : null, readOnly ? null : "drag to move"].filter(Boolean).join(" · ");
  const menu = (event: { preventDefault(): void; currentTarget: Element }) => {
    event.preventDefault();
    onMenu(rectOf(event.currentTarget));
  };
  return (
    <div
      className={[
        "page-frame",
        menuOpen ? "is-menu-open" : "",
        dragging ? "is-dragging" : "",
        locked ? "is-locked" : "",
      ].filter(Boolean).join(" ")}
      data-frame-of={pageId}
      data-head-kind={headKind}
      style={{ "--depth-base": depth, "--frame-level": level, "--frame-shift": shift } as CSSProperties}
    >
      <Tooltip label={readOnly ? "Open menu" : "Drag to move"} hint={readOnly ? undefined : "Click to open menu"}>
        <button
          type="button"
          className="page-frame__handle"
          contentEditable={false}
          tabIndex={-1}
          aria-label={`Options for ${name}`}
          aria-haspopup="menu"
          draggable={!readOnly}
          onDragStart={readOnly ? undefined : onDragStart}
          onDragEnd={readOnly ? undefined : onDragEnd}
          onClick={menu}
          onContextMenu={menu}
        >
          <GripVertical size={14} />
        </button>
      </Tooltip>
      {/* Opening it as a page of its own is its name's to do. */}
      <Tooltip label="Fold" hint={hint ? hint.charAt(0).toUpperCase() + hint.slice(1) : undefined}>
        <button
          type="button"
          className="page-frame__mark"
          contentEditable={false}
          aria-label={`Fold ${name}`}
          aria-expanded
          aria-haspopup="menu"
          draggable={!readOnly}
          onDragStart={readOnly ? undefined : onDragStart}
          onDragEnd={readOnly ? undefined : onDragEnd}
          onClick={() => onToggle?.(pageId)}
          onContextMenu={menu}
        >
          <span className="page-frame__mark-icon" aria-hidden="true">{mark ?? <PageIcon size={16} />}</span>
          <ChevronRight className="page-frame__mark-twist" size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      {references ? (
        <button
          type="button"
          className="page-frame__refs"
          contentEditable={false}
          aria-label={`${references} backlink${references === 1 ? "" : "s"} to this block`}
          onClick={(event) => onReferences(rectOf(event.currentTarget))}
        >
          {references > 99 ? "99+" : references}
        </button>
      ) : null}
      {title ? <div className="page-frame__title" contentEditable={false}>{title}</div> : null}
      {children}
    </div>
  );
}
