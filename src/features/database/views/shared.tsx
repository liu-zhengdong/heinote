import {
  Check,
  FileText,
  GripVertical,
  Lock,
  Maximize2,
  Pencil,
} from "lucide-react";
import {
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Avatar } from "../../../components/Avatar";
import { Tooltip } from "../../../components/Tooltip";
import { EMPTY_TREE, orderedBlocks, pageName } from "../../../core/block-tree";
import { inlinePlainText } from "../../../core/inline-content";
import { inTrash } from "../../../core/page-tree";
import { pageTitleContent } from "../../../core/title";
import type {
  DatabaseProperty,
  InlineContent,
  NotePage,
} from "../../../core/types";
import {
  multiValues,
  propertyName,
  propertyValue,
  relationIds,
  rowImages,
  type CardPreview,
} from "../database-model";
import { formatDay, formatMoment, OptionTag, PropertyLink } from "../properties";
import { CardImage, ImageStrip } from "../ImageProperty";
import { linkedWordsAt, NameWords, TitleField } from "../../editor/TitleField";
import { titleField } from "../../../collaboration/protocol";
import { followHref } from "../../editor/RichField";
import { pageCover } from "../../editor/page-decoration";
import { CoverImage } from "../../editor/CoverImage";
import { PageIconMark } from "../../editor/PageIcon";
import { useWorkspaceState } from "../../../app/workspace-store";

/** A row's set values, small, for the layouts that cannot give every property
 *  a column. Only what was actually set: a list where every row repeats "Not
 *  started" is a list of the same word. */
export function RowChips({
  row,
  properties,
  exclude,
  limit,
}: {
  row: NotePage;
  properties: DatabaseProperty[];
  exclude?: string;
  limit: number;
}) {
  const pages = useWorkspaceState((state) => state.pages);
  const chips = properties
    .filter((property) => property.id !== exclude)
    .map((property) => ({ property, value: propertyValue(row, property) }))
    .filter((chip) => (chip.property.type === "image" ? rowImages(row, chip.property.id).length > 0 : chip.value))
    .slice(0, limit);
  if (!chips.length) return null;
  return (
    <span className="db-chips">
      {chips.map(({ property, value }) => {
        if (property.type === "image") return <ImageStrip key={property.id} row={row} property={property} />;
        if (property.type === "status") return <OptionTag key={property.id} property={property} value={propertyValue(row, property)} />;
        if (property.type === "select") return <OptionTag key={property.id} property={property} value={value} />;
        // A multi-select is its pills; only as many as the chip limit gives.
        if (property.type === "multi_select") {
          return (
            <span key={property.id} className="db-chip db-chip--multi">
              {multiValues(value).map((name) => <OptionTag key={name} property={property} value={name} />)}
            </span>
          );
        }
        // Checked or not, the box is what a checkbox says on a card.
        if (property.type === "checkbox") {
          return (
            <span key={property.id} className={`db-chip db-chip--check ${value === "true" ? "is-checked" : ""}`} aria-label={value === "true" ? "Checked" : "Unchecked"}>
              <span className={`checkbox ${value === "true" ? "is-checked" : ""}`}>{value === "true" ? <Check size={11} strokeWidth={3} /> : null}</span>
              {propertyName(property)}
            </span>
          );
        }
        // A relation chip names its pages, up to three; a page that cannot
        // be shown draws as the cell's ghost.
        if (property.type === "relation") {
          return (
            <span key={property.id} className="db-chip db-chip--relation">
              {relationIds(value).slice(0, 3).map((id) => {
                const linked = pages[id];
                const gone = !linked || inTrash(pages, id);
                return (
                  <span key={id} className={`db-rel ${gone ? "db-rel--ghost" : ""}`}>
                    {gone ? <Lock size={10} aria-hidden="true" /> : <FileText size={10} aria-hidden="true" />}
                    <span className="db-rel__name">{gone ? "No access" : pageName(linked) || "Untitled"}</span>
                  </span>
                );
              })}
              {relationIds(value).length > 3 ? <span className="db-rel__name">+{relationIds(value).length - 3}</span> : null}
            </span>
          );
        }
        // A url/email/phone chip is the link it names, clickable — stopped
        // before it opens the row the chip sits on.
        if (property.type === "url" || property.type === "email" || property.type === "phone") {
          return (
            <span key={property.id} className="db-chip">
              <PropertyLink property={property} value={value} />
            </span>
          );
        }
        // A meta chip reads the row's own record, formatted as the column is.
        if (property.type === "created_time" || property.type === "last_edited_time") {
          return <span key={property.id} className="db-chip">{formatMoment(propertyValue(row, property))}</span>;
        }
        if (property.type === "created_by" || property.type === "last_edited_by") {
          const who = propertyValue(row, property);
          return <span key={property.id} className="db-chip"><Avatar name={who} size={16} />{who}</span>;
        }
        if (property.type === "person") {
          return <span key={property.id} className="db-chip"><Avatar name={value} size={16} />{value}</span>;
        }
        return (
          <span key={property.id} className="db-chip">
            {property.type === "date" ? formatDay(value) : value}
          </span>
        );
      })}
    </span>
  );
}

/** The first lines a page actually says, for cards that preview it. A row
 *  whose body is not pulled in previews nothing. */
export function previewText(row: NotePage, lines: number): string[] {
  return orderedBlocks(row.block_tree ?? EMPTY_TREE)
    .map((block) => inlinePlainText(block.content).trim())
    .filter(Boolean)
    .slice(0, lines);
}

/* ── Layouts ───────────────────────────────────────────────────────────── */

/** A click that asks for the whole page rather than the side peek, as a
 *  link does everywhere in HeiNote. */
export const fullPage = (event: { metaKey: boolean; ctrlKey: boolean }) => event.metaKey || event.ctrlKey;

/** Opens a link in a row's name to a page of this workspace (`#page`) the
 *  way the row itself opens: beside, in the side peek, or whole. */
export const pageOpener = (onOpen: (pageId: string, full?: boolean) => void) => (href: string, full: boolean) => {
  const pageId = href.replace(/^#/, "").split(":")[0];
  if (pageId) onOpen(pageId, full);
};

/** Where the caret lands when a name starts being typed: after it (a click
 *  beside the name, a row just made) or over all of it (the pencil, so a new
 *  name is simply typed over the old). */
export type RenameCaret = "end" | "all";

export interface RowRenaming {
  /** The row whose name is being typed, if one is. */
  renamingId: string | null;
  renameCaret: RenameCaret;
  onStartRename(pageId: string, caret?: RenameCaret): void;
  onStopRename(): void;
  onRename(row: NotePage, name: InlineContent): void;
}

/** A row's name in the table and the list — one component, so the two views
 *  cannot drift apart. A name is a value like any other: words, typed where
 *  they stand — a click in them types them, as in a spreadsheet's cell —
 *  its linked words still opening their link. Every row opens, and is
 *  written in, as the page it is: from its Open, or — a row with anything in
 *  it (not `isBareRow`) — from its page's mark before its name. Enter or
 *  Escape puts a name down. An untitled row's quiet "Untitled" is where its
 *  name is typed. */
export function RowName({
  row,
  mark,
  titleClass,
  label,
  readOnly,
  renaming,
  caret,
  onOpen,
  onStopRename,
  onRename,
}: {
  row: NotePage;
  /** The row's page mark as the layout draws it (`RowPageMark`) — for a row
   *  that is its values alone, the mark's empty room, so every name starts
   *  in one place — or nothing, in a minimal table. */
  mark: ReactNode;
  /** The name's own class: `db__row-title` in the table, `db-list__title` in
   *  the list — the text at rest and the field while typing. */
  titleClass: string;
  /** What the row-name column is called. */
  label: string;
  readOnly: boolean;
  renaming: boolean;
  caret: RenameCaret;
  onOpen(pageId: string, full?: boolean): void;
  onStopRename(): void;
  onRename(row: NotePage, name: InlineContent): void;
}) {
  if (renaming && !readOnly) {
    return (
      <>
        {mark}
        <TitleField
          className={titleClass}
          content={pageTitleContent(row)}
          placeholder="Untitled"
          label={label}
          historyField="title"
          blockId={row.id}
          collaboration={{ pageId: row.id, key: titleField(row.id) }}
          focusOnMount={caret}
          onChange={(next) => onRename(row, next)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== "Escape") return;
            event.preventDefault();
            event.currentTarget.blur();
          }}
          onBlur={() => onStopRename()}
          onOpenPage={pageOpener(onOpen)}
        />
      </>
    );
  }
  return (
    <>
      {mark}
      {row.title ? (
        <span
          className={titleClass}
          data-block-name={row.id}
          onClick={(event) => {
            const href = linkedWordsAt(event.target);
            if (!href) return;
            // Its link, not the name to type: the cell is not told.
            event.stopPropagation();
            followHref(href, fullPage(event), pageOpener(onOpen));
          }}
        >
          <NameWords content={pageTitleContent(row)} />
        </span>
      ) : <span className={titleClass} data-block-name={row.id} data-empty="" />}
    </>
  );
}

/** The mark before the name of a row with anything in it: its icon, or a
 *  page's. Pressed, it opens the row as the row's Open does — beside, in
 *  the side peek; ⌘/Ctrl, whole. */
export function RowPageMark({ row, className, size, onOpen }: {
  row: NotePage;
  className: string;
  size: number;
  onOpen(pageId: string, full?: boolean): void;
}) {
  return (
    <button
      type="button"
      className={`${className} db__row-mark`}
      aria-label={`Open ${row.title || "Untitled"}`}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(row.id, fullPage(event));
      }}
    >
      <PageIconMark page={row} size={size} />
    </button>
  );
}

/** A click on the free space of a row's name — beside the link, or on an
 *  untitled row's "Untitled" — types the name, as a click in Notion's title
 *  cell outside its link does. */
export const renameOnFreeSpace = (
  event: ReactMouseEvent<HTMLElement>,
  row: NotePage,
  readOnly: boolean,
  onStartRename: (pageId: string, caret?: RenameCaret) => void,
) => {
  if (readOnly || event.button !== 0 || (event.target as Element).closest("a, button, input")) return;
  onStartRename(row.id, "end");
};

/** The drag payload a database row carries — the board's already, kept for
 *  the rows of the other views: a drag stays inside the view it began in
 *  because every layout tracks its own dragged row. */
export const ROW_DRAG = "text/x-notes-row";

/** A row's grip — Notion's ⋮⋮ — shown on hover, the handle the row is
 *  dragged by. Only the grip is draggable: the row around it selects text
 *  and takes clicks. Focused, its arrows step the row up or down by one —
 *  the keyboard's own reorder, no pointer needed. `ghost` names the
 *  element whose picture the drag carries (the whole row, not the grip). */
export function RowGrip({
  row,
  ghost,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  row: NotePage;
  ghost: string;
  onDragStart?(event: ReactDragEvent<HTMLElement>): void;
  onDragEnd?(): void;
  onMove(step: -1 | 1): void;
}) {
  return (
    <button
      type="button"
      className="row-grip"
      draggable
      aria-label={`Reorder ${row.title || "Untitled"} — use arrow keys to move`}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(ROW_DRAG, row.id);
        const image = event.currentTarget.closest<HTMLElement>(ghost);
        if (image) event.dataTransfer.setDragImage(image, 10, 10);
        onDragStart?.(event);
      }}
      onDragEnd={() => onDragEnd?.()}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp") {
          event.preventDefault();
          onMove(-1);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          onMove(1);
        }
      }}
    >
      <GripVertical size={14} />
    </button>
  );
}

/** What a row offers when it is pointed at: Notion's Open — the row as the
 *  page it is, beside, in the side peek; ⌘/Ctrl, whole. */
export function RowActions({ row, onOpen }: { row: NotePage; onOpen(pageId: string, full?: boolean): void }) {
  return (
    <span className="db__row-actions">
      <Tooltip label="Open">
        <button type="button" className="db__open" aria-label={`Open ${row.title || "Untitled"}`} onClick={(event) => onOpen(row.id, fullPage(event))}>
          <Maximize2 size={13} />
        </button>
      </Tooltip>
    </span>
  );
}

export interface LayoutProps {
  rows: NotePage[];
  properties: DatabaseProperty[];
  /** The rows that are their values alone (`isBareRow`): no page mark. */
  bare: ReadonlySet<string>;
  peekId: string | null;
  /** Opens a row: beside, in the side peek, or — `full` — as the page. */
  onOpen(pageId: string, full?: boolean): void;
  onAdd(values?: Record<string, string>): void;
  /** A viewer's copy: nothing in it adds, moves, renames or edits a cell. */
  readOnly: boolean;
  /** Rows may be dragged into order: the view is writable and nothing — a
   *  sort, a filter, a search — is choosing or hiding part of their order. */
  reorderable: boolean;
  /** A row dropped beside `boundaryId` (before or after it), or last when
   *  `boundaryId` is null. `seed` gives the group the row landed in — its
   *  property id and the value to write there — when the drop was into one. */
  onReorderRow(rowId: string, boundaryId: string | null, place: "before" | "after", seed?: { propertyId: string; value: string }): void;
}

/** A card's name. At rest it is the card's open button, stretched over the
 *  whole card so a click anywhere opens the page — Notion's board and gallery
 *  cards open on a click. Renaming, it becomes a field on the card itself,
 *  text selected so a new name can simply be typed over the old one. */
export function CardTitle({
  row,
  renaming,
  className,
  onOpen,
  onRename,
  onStopRename,
}: {
  row: NotePage;
  renaming: boolean;
  className: string;
  onOpen(pageId: string, full?: boolean): void;
  onRename(row: NotePage, name: InlineContent): void;
  onStopRename(): void;
}) {
  if (renaming) {
    return (
      <TitleField
        className={`${className} card-title-input`}
        content={pageTitleContent(row)}
        placeholder="Untitled"
        label="Name"
        historyField="title"
        blockId={row.id}
        collaboration={{ pageId: row.id, key: titleField(row.id) }}
        focusOnMount="all"
        onChange={(next) => onRename(row, next)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== "Escape") return;
          event.preventDefault();
          event.currentTarget.blur();
        }}
        onBlur={onStopRename}
        onOpenPage={pageOpener(onOpen)}
      />
    );
  }
  return (
    <button
      type="button"
      className={`${className} card-open`}
      onClick={(event) => {
        // Linked words in the name open their link; anywhere else, the page.
        const href = linkedWordsAt(event.target);
        if (href) followHref(href, fullPage(event), pageOpener(onOpen));
        else onOpen(row.id, fullPage(event));
      }}
    >
      {row.icon || row.icon_image ? <span aria-hidden="true"><PageIconMark page={row} size={15} /></span> : null}
      <span className="card-open__name" data-block-name={row.id}>{row.title ? <NameWords content={pageTitleContent(row)} /> : "Untitled"}</span>
    </button>
  );
}

/** The pencil that appears on a card you point at, as on Notion's. */
export function CardRename({ row, onStartRename }: { row: NotePage; onStartRename(pageId: string): void }) {
  return (
    <Tooltip label="Rename">
      <button
        type="button"
        className="card-rename"
        aria-label={`Rename ${row.title || "Untitled"}`}
        onClick={() => onStartRename(row.id)}
      >
        <Pencil size={13} />
      </button>
    </Tooltip>
  );
}

export interface CardEditing {
  renamingId: string | null;
  onStartRename(pageId: string): void;
  onStopRename(): void;
  onRename(row: NotePage, name: InlineContent): void;
  onAddInline(values?: Record<string, string>): void;
}

/** What a gallery card shows above its name, as its view says (Notion's
 *  "Card preview"): a picture from an Image property, the page's cover, the
 *  page itself — its first lines, set small — or nothing at all. */
export function CardTop({ row, preview }: { row: NotePage; preview: CardPreview }) {
  if (preview.kind === "none") return null;
  if (preview.kind === "image") return <CardImage row={row} property={preview.property} />;
  const blank = <span className="db-card__glyph">{row.icon || row.icon_image ? <PageIconMark page={row} size={22} /> : <FileText size={22} strokeWidth={1.5} />}</span>;
  if (preview.kind === "cover") {
    const cover = pageCover(row);
    if (cover?.kind === "image") {
      return (
        <span className="db-card__preview db-card__preview--cover" aria-hidden="true">
          <CoverImage file={cover.file} className="db-card__cover-image" />
        </span>
      );
    }
    const background = cover?.background;
    return (
      <span className={`db-card__preview ${background ? "db-card__preview--cover" : "is-blank"}`} style={background ? { background } : undefined} aria-hidden="true">
        {background ? null : blank}
      </span>
    );
  }
  const lines = previewText(row, 4);
  return (
    <span className={`db-card__preview ${lines.length ? "" : "is-blank"}`} aria-hidden="true">
      {lines.length ? lines.map((line, index) => <span key={index}>{line}</span>) : blank}
    </span>
  );
}
