import {
  ArrowDown,
  ArrowDownAZ,
  ArrowUp,
  ArrowUpRight,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Copy,
  EyeOff,
  FileText,
  Filter,
  LayoutGrid,
  LayoutList,
  List,
  MoreHorizontal,
  Maximize2,
  Minimize2,
  PanelTop,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Table,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Avatar } from "../../components/Avatar";
import { MenuDivider, MenuItem, MenuList } from "../../components/Menu";
import { Popover } from "../../components/Popover";
import { Tooltip } from "../../components/Tooltip";
import { imeComposing } from "../../core/keyboard";
import { pointRect, rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import { orderedBlocks } from "../../core/block-tree";
import { createId } from "../../core/ids";
import { inlinePlainText, isoDate } from "../../core/inline-content";
import { pageTitleContent, titleFields } from "../../core/title";
import type {
  DatabaseConfig,
  DatabaseProperty,
  DatabaseView as View,
  DatabaseViewKind,
  InlineContent,
  NotePage,
  PropertyType,
  ViewSort,
} from "../../core/types";
import { useWorkspace, type PagePatch } from "../../app/workspace-context";
import { useUi } from "../../app/ui-context";
import {
  activeView,
  addStatusOption,
  boardProperty,
  calendarProperty,
  cardPreview,
  cardProperties,
  changePropertyType,
  changeViewKind,
  clampColumnWidth,
  COLUMN_WIDTH,
  columnWidth,
  columnWraps,
  copiedColumn,
  createView,
  databaseRows,
  duplicateProperty,
  duplicateView,
  groupableProperties,
  insertProperty,
  localeWeekStart,
  monthGrid,
  moveStatusOption,
  PROPERTY_LABELS,
  PROPERTY_TYPES,
  propertyName,
  propertyOptions,
  propertyValue,
  recolorStatusOption,
  removeProperty,
  removeStatusOption,
  removeView,
  renameProperty,
  renameStatusOption,
  rowImages,
  rowValues,
  setDefaultStatus,
  setPropertyIcon,
  sortable,
  sortByColumn,
  TITLE_COLUMN,
  titleName,
  toggleCardProperty,
  viewKindLabel,
  viewRows,
  viewSorts,
  withColumnWidth,
  withColumnWrap,
  withSorts,
  withView,
  type RowWrite,
} from "./database-model";
import { formatDay, ISO_DAY, OptionTag, PropertyEditor, PropertyIcon, TitleIcon, TypeIcon } from "./properties";
import { PropertyMenu } from "./PropertyMenu";
import type { StatusEditing } from "./StatusOptions";
import { SortPanel, type SortColumn } from "./SortPanel";
import * as columnIcons from "./property-icons";
import { provideIcons } from "./property-icon-store";
import { CardImage, ImageStrip, useHomedImages } from "./ImageProperty";
import { databaseConvertible, databaseToBlocks } from "./convert";
import { ordersBetween } from "../editor/editor-commands";
import { linkedWordsAt, NameWords, TitleField } from "../editor/TitleField";
import { followHref } from "../editor/RichField";
import { isBareRow, spaceOfPage } from "../../core/page-tree";
import { pageCover } from "../editor/page-decoration";
import { CoverImage, useHomedCovers } from "../editor/CoverImage";
import type { CardPreview } from "./database-model";
import { sameItems, usePage, useWorkspaceState } from "../../app/workspace-store";
import { VIEW_KINDS } from "../../../schema";

// The marks columns can wear come with the database, drawn from its first table.
provideIcons(columnIcons);

export function ViewIcon({ kind, size = 15 }: { kind: DatabaseViewKind; size?: number }) {
  if (kind === "board") return <Columns3 size={size} />;
  if (kind === "list") return <LayoutList size={size} />;
  if (kind === "gallery") return <LayoutGrid size={size} />;
  if (kind === "calendar") return <CalendarDays size={size} />;
  return <Table2 size={size} />;
}

/** A row's set values, small, for the layouts that cannot give every property
 *  a column. Only what was actually set: a list where every row repeats "Not
 *  started" is a list of the same word. */
function RowChips({
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
  const chips = properties
    .filter((property) => property.id !== exclude)
    .map((property) => ({ property, value: row.properties?.[property.id] ?? "" }))
    .filter((chip) => (chip.property.type === "image" ? rowImages(row, chip.property.id).length > 0 : chip.value))
    .slice(0, limit);
  if (!chips.length) return null;
  return (
    <span className="db-chips">
      {chips.map(({ property, value }) => {
        if (property.type === "image") return <ImageStrip key={property.id} row={row} property={property} />;
        if (property.type === "status") return <OptionTag key={property.id} property={property} value={propertyValue(row, property)} />;
        if (property.type === "select") return <OptionTag key={property.id} property={property} value={value} />;
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

/** The first lines a page actually says, for cards that preview it. */
function previewText(row: NotePage, lines: number): string[] {
  return orderedBlocks(row.block_tree)
    .map((block) => inlinePlainText(block.content).trim())
    .filter(Boolean)
    .slice(0, lines);
}

/* ── Layouts ───────────────────────────────────────────────────────────── */

/** A click that asks for the whole page rather than the side peek, as a
 *  link does everywhere in Notes. */
const fullPage = (event: { metaKey: boolean; ctrlKey: boolean }) => event.metaKey || event.ctrlKey;

/** Opens a link in a row's name to a page of this workspace (`#page`) the
 *  way the row itself opens: beside, in the side peek, or whole. */
const pageOpener = (onOpen: (pageId: string, full?: boolean) => void) => (href: string, full: boolean) => {
  const pageId = href.replace(/^#/, "").split(":")[0];
  if (pageId) onOpen(pageId, full);
};

/** Where the caret lands when a name starts being typed: after it (a click
 *  beside the name, a row just made) or over all of it (the pencil, so a new
 *  name is simply typed over the old). */
type RenameCaret = "end" | "all";

interface RowRenaming {
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
function RowName({
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
      ) : <span className={titleClass} data-empty="" />}
    </>
  );
}

/** The mark before the name of a row with anything in it: its icon, or a
 *  page's. Pressed, it opens the row as the row's Open does — beside, in
 *  the side peek; ⌘/Ctrl, whole. */
function RowPageMark({ row, className, size, onOpen }: {
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
      {row.icon || <FileText size={size} />}
    </button>
  );
}

/** A click on the free space of a row's name — beside the link, or on an
 *  untitled row's "Untitled" — types the name, as a click in Notion's title
 *  cell outside its link does. */
const renameOnFreeSpace = (
  event: ReactMouseEvent<HTMLElement>,
  row: NotePage,
  readOnly: boolean,
  onStartRename: (pageId: string, caret?: RenameCaret) => void,
) => {
  if (readOnly || event.button !== 0 || (event.target as Element).closest("a, button, input")) return;
  onStartRename(row.id, "end");
};

/** What a row offers when it is pointed at: Notion's Open — the row as the
 *  page it is, beside, in the side peek; ⌘/Ctrl, whole. */
function RowActions({ row, onOpen }: { row: NotePage; onOpen(pageId: string, full?: boolean): void }) {
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

interface LayoutProps {
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
}

/** A column's head: its mark and its name. Pressed, it opens the column's
 *  menu — its name, its type, a sort, a column beside it — as Notion's does;
 *  for a reader who may only look it is a label. */
function ColumnHead({
  icon,
  label,
  open,
  readOnly,
  onMenu,
}: {
  icon: ReactNode;
  label: string;
  open: boolean;
  readOnly: boolean;
  onMenu(anchor: AnchorRect): void;
}) {
  const content = (
    <>
      {icon}
      <span className="db__th-name">{label}</span>
    </>
  );
  if (readOnly) return <div className="db__th">{content}</div>;
  return (
    <button
      type="button"
      className={`db__th ${open ? "is-open" : ""}`}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={(event) => onMenu(rectOf(event.currentTarget))}
    >
      {content}
    </button>
  );
}

/** The row-name column's width until someone drags it: nearly half the
 *  database, never under a name's worth nor over 440px — the properties
 *  scroll past it (see `.db__name`). */
const TITLE_DEFAULT_WIDTH = "max(168px, min(440px, 48cqi))";

/** The edge of a column's head, dragged to make the column wider or
 *  narrower — Notion's, a blue line where the pointer takes it. */
function ColumnResize({
  column,
  active,
  onStart,
}: {
  column: string;
  active: boolean;
  onStart(column: string, event: ReactPointerEvent<HTMLElement>): void;
}) {
  return (
    <span
      className={`db__resize ${active ? "is-active" : ""}`}
      aria-hidden="true"
      data-resize={column}
      onPointerDown={(event) => onStart(column, event)}
    />
  );
}

/* In minimal mode (a view setting, so everyone reading it sees the same
   table) the table is drawn as a Markdown table would be: the names in a
   hairline grid, compact rows, and none of the database's own furniture — no
   marks by the names, no row icons, no "Add property" column, and its "New"
   row only under the pointer. It is the same table: names are still typed in
   place, a head still opens its column's menu (Insert left and right add a
   column), a column's edge still drags, and a row still offers Open when
   pointed at.

   Every column is exactly as wide as the view says (a fixed table layout:
   nothing in a cell can push its column wider), each dragged by its head's
   edge. Minimal, the table is its columns and no wider, as a Markdown table
   is; otherwise it fills the database's width at least, and "Add property"
   takes whatever is left over. */
function TableLayout({
  rows,
  properties,
  bare,
  peekId,
  renamingId,
  renameCaret,
  onStartRename,
  onStopRename,
  onOpen,
  onAddInline,
  onRename,
  onSetProperty,
  onAddProperty,
  readOnly,
  minimal,
  view,
  titleLabel,
  titleIcon,
  menuColumn,
  onColumnMenu,
  onResize,
}: LayoutProps & RowRenaming & {
  onAddInline(): void;
  onSetProperty(row: NotePage, propertyId: string, value: string): void;
  onAddProperty(anchor: AnchorRect): void;
  minimal: boolean;
  /** The view drawn — its widths are the columns'. */
  view: View;
  /** What the row-name column is called, and the mark it was given. */
  titleLabel: string;
  titleIcon: string | undefined;
  /** The column whose menu is open, if one is. */
  menuColumn: string | null;
  onColumnMenu(column: string, anchor: AnchorRect): void;
  /** A column dragged to a new width, when the drag ends. */
  onResize(column: string, width: number): void;
}) {
  /* A column being dragged is drawn at its new width at once and written to
     the view when the drag ends: one step of undo, and nothing sent to
     anyone while the pointer is still moving. */
  const [resizing, setResizing] = useState<{ column: string; width: number } | null>(null);
  const endResize = useRef<(() => void) | null>(null);
  useEffect(() => () => endResize.current?.(), []);
  const widthOf = (column: string) => (resizing?.column === column ? resizing.width : columnWidth(view, column));
  const titleWidth = widthOf(TITLE_COLUMN);
  const title = titleWidth === undefined ? TITLE_DEFAULT_WIDTH : `${titleWidth}px`;
  const widths = properties.map((property) => widthOf(property.id) ?? COLUMN_WIDTH.property);
  const fixed = widths.reduce((sum, width) => sum + width, minimal ? 0 : COLUMN_WIDTH.addProperty);
  const tableWidth = minimal ? `calc(${title} + ${fixed}px)` : `max(100%, calc(${title} + ${fixed}px))`;
  /* Names and Text values wrap onto the lines below, the row growing to
     hold them, as Notion's do — each column unless its "Wrap text" is off.
     Read as plain values, so the rows below redraw only when one changes. */
  const namesWrap = columnWraps(view, TITLE_COLUMN);
  const oneLine = properties.filter((property) => !columnWraps(view, property.id)).map((property) => property.id).join("\n");

  const startResize = (column: string, event: ReactPointerEvent<HTMLElement>) => {
    const handle = event.currentTarget;
    const head = handle.closest("th");
    if (event.button !== 0 || !head || readOnly) return;
    event.preventDefault();
    const pointer = event.pointerId;
    const startX = event.clientX;
    const from = columnWidth(view, column) ?? head.getBoundingClientRect().width;
    let width = clampColumnWidth(from);
    const move = (moved: PointerEvent) => {
      width = clampColumnWidth(from + moved.clientX - startX);
      setResizing({ column, width });
    };
    const finish = (keep: boolean) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape, true);
      if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
      document.documentElement.classList.remove("is-resizing-column");
      endResize.current = null;
      setResizing(null);
      if (keep && width !== Math.round(from)) onResize(column, width);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    // Escape puts the column back where the drag found it.
    const escape = (key: KeyboardEvent) => {
      if (key.key !== "Escape") return;
      key.preventDefault();
      key.stopPropagation();
      finish(false);
    };
    handle.setPointerCapture(pointer);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", escape, true);
    document.documentElement.classList.add("is-resizing-column");
    endResize.current = cancel;
    setResizing({ column, width });
  };

  /* The rows, kept while only a width changes: a drag redraws the columns,
     never every cell. */
  const body = useMemo(() => {
    const keptToOneLine = new Set(oneLine.split("\n"));
    return (
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className={peekId === row.id ? "is-peeked" : ""} data-page-id={row.id}>
            {/* The name is a link to the page, as Notion's is; the cell
                around it is where the name is typed — all of it, below a
                short name in a row that another cell's words make tall too. */}
            <td
              className={`db__name ${readOnly ? "" : "is-renamable"}`}
              onClick={(event) => renameOnFreeSpace(event, row, readOnly, onStartRename)}
            >
              <div className={`db__row-name ${namesWrap ? "is-wrapped" : ""}`}>
                <RowName
                  row={row}
                  mark={minimal ? null : bare.has(row.id) ? <span className="db__row-icon" aria-hidden="true" /> : <RowPageMark row={row} className="db__row-icon" size={14} onOpen={onOpen} />}
                  titleClass="db__row-title"
                  label={titleLabel}
                  readOnly={readOnly}
                  renaming={row.id === renamingId}
                  caret={renameCaret}
                  onOpen={onOpen}
                  onStopRename={onStopRename}
                  onRename={onRename}
                />
                {row.id === renamingId ? null : <RowActions row={row} onOpen={onOpen} />}
              </div>
            </td>
            {properties.map((property) => (
              <td key={property.id}>
                <PropertyEditor
                  property={property}
                  value={row.properties?.[property.id] ?? ""}
                  row={row}
                  readOnly={readOnly}
                  wrap={!keptToOneLine.has(property.id)}
                  onChange={(next) => onSetProperty(row, property.id, next)}
                />
              </td>
            ))}
            {minimal ? null : <td />}
          </tr>
        ))}
      </tbody>
    );
  }, [bare, minimal, namesWrap, onOpen, oneLine, onRename, onSetProperty, onStartRename, onStopRename, peekId, properties, readOnly, renameCaret, renamingId, rows, titleLabel]);

  return (
    <div className="db__table-wrap scroller">
      <table className="db__table" style={{ width: tableWidth }}>
        <colgroup>
          <col style={{ width: title }} />
          {properties.map((property, index) => <col key={property.id} style={{ width: widths[index] }} />)}
          {minimal ? null : <col />}
        </colgroup>
        <thead>
          <tr>
            <th className="db__name" data-column={TITLE_COLUMN}>
              <ColumnHead
                icon={minimal ? null : <TitleIcon icon={titleIcon} />}
                label={titleLabel}
                open={menuColumn === TITLE_COLUMN}
                readOnly={readOnly}
                onMenu={(anchor) => onColumnMenu(TITLE_COLUMN, anchor)}
              />
              {readOnly ? null : <ColumnResize column={TITLE_COLUMN} active={resizing?.column === TITLE_COLUMN} onStart={startResize} />}
            </th>
            {properties.map((property) => (
              <th key={property.id} data-column={property.id}>
                <ColumnHead
                  icon={minimal ? null : <PropertyIcon property={property} />}
                  label={propertyName(property)}
                  open={menuColumn === property.id}
                  readOnly={readOnly}
                  onMenu={(anchor) => onColumnMenu(property.id, anchor)}
                />
                {readOnly ? null : <ColumnResize column={property.id} active={resizing?.column === property.id} onStart={startResize} />}
              </th>
            ))}
            {minimal ? null : (
              <th className="db__add-property">
                <Tooltip label="Add property">
                  <button type="button" aria-label="Add property" onClick={(event) => onAddProperty(rectOf(event.currentTarget))}>
                    <Plus size={15} />
                  </button>
                </Tooltip>
              </th>
            )}
          </tr>
        </thead>
        {body}
      </table>
      {readOnly ? null : (
        <button type="button" className="db__add-row" onClick={onAddInline}>
          <Plus size={15} />New
        </button>
      )}
    </div>
  );
}

function BoardLayout({
  rows,
  properties,
  property,
  onOpen,
  onMove,
  renamingId,
  onStartRename,
  onStopRename,
  onRename,
  onAddInline,
  readOnly,
}: LayoutProps & CardEditing & { property: DatabaseProperty; onMove(row: NotePage, value: string): void }) {
  const [dragRowId, setDragRowId] = useState<string | null>(null);
  const [dropColumn, setDropColumn] = useState<string | null>(null);
  const options = propertyOptions(property);
  // A select can be unset; a status cannot (it reads as its first option). The
  // "No value" column is drawn only while something is in it — an empty extra
  // column is 260px a small window cannot spare.
  const unset = property.type === "select" ? rows.filter((row) => !propertyValue(row, property)) : [];
  const columns = unset.length ? ["", ...options] : options;

  const onDrop = (value: string) => (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDropColumn(null);
    const row = rows.find((item) => item.id === dragRowId);
    setDragRowId(null);
    if (row) onMove(row, value);
  };

  return (
    <div className="board scroller">
      {columns.map((value) => {
        const items = rows.filter((row) => propertyValue(row, property) === value);
        const label = value || `No ${propertyName(property)}`;
        return (
          <section
            key={value || "none"}
            className={`board__column ${dropColumn === value ? "is-drop-target" : ""}`}
            aria-label={label}
            onDragOver={(event) => { if (!dragRowId) return; event.preventDefault(); setDropColumn(value); }}
            onDragLeave={() => setDropColumn((current) => (current === value ? null : current))}
            onDrop={onDrop(value)}
          >
            <header className="board__column-head">
              {value ? <OptionTag property={property} value={value} /> : <span className="tag">{label}</span>}
              <span className="board__count">{items.length}</span>
              {readOnly ? null : (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`New row in ${label}`}
                  onClick={() => onAddInline(value ? { [property.id]: value } : undefined)}
                >
                  <Plus size={15} />
                </button>
              )}
            </header>
            {items.map((row) => {
              const preview = previewText(row, 1)[0];
              const renaming = row.id === renamingId;
              return (
                <div
                  key={row.id}
                  className={`board__card ${dragRowId === row.id ? "is-dragging" : ""} ${renaming ? "is-renaming" : ""}`}
                  data-page-id={row.id}
                  // A card being renamed holds still: dragging to select its
                  // text must not pick the whole card up.
                  draggable={!renaming && !readOnly}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/x-notes-row", row.id);
                    setDragRowId(row.id);
                  }}
                  onDragEnd={() => { setDragRowId(null); setDropColumn(null); }}
                >
                  <CardTitle
                    row={row}
                    renaming={renaming}
                    className="board__card-title"
                    onOpen={onOpen}
                    onRename={onRename}
                    onStopRename={onStopRename}
                  />
                  <RowChips row={row} properties={properties} exclude={property.id} limit={3} />
                  {preview ? <p>{preview}</p> : null}
                  {renaming || readOnly ? null : <CardRename row={row} onStartRename={onStartRename} />}
                </div>
              );
            })}
            {/* A new card is made in its column with its name ready to type,
                as Notion's is — the blue New above opens a page instead. */}
            {readOnly ? null : (
              <button
                type="button"
                className="board__add"
                onClick={() => onAddInline(value ? { [property.id]: value } : undefined)}
              >
                <Plus size={14} />New
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** A card's name. At rest it is the card's open button, stretched over the
 *  whole card so a click anywhere opens the page — Notion's board and gallery
 *  cards open on a click. Renaming, it becomes a field on the card itself,
 *  text selected so a new name can simply be typed over the old one. */
function CardTitle({
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
      {row.icon ? <span aria-hidden="true">{row.icon}</span> : null}
      <span className="card-open__name">{row.title ? <NameWords content={pageTitleContent(row)} /> : "Untitled"}</span>
    </button>
  );
}

/** The pencil that appears on a card you point at, as on Notion's. */
function CardRename({ row, onStartRename }: { row: NotePage; onStartRename(pageId: string): void }) {
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

interface CardEditing {
  renamingId: string | null;
  onStartRename(pageId: string): void;
  onStopRename(): void;
  onRename(row: NotePage, name: InlineContent): void;
  onAddInline(values?: Record<string, string>): void;
}

/* A list row works exactly like a table row: its name — mark and words — is
   a link to the page, the space beside it is where the name is typed (or the
   pencil), and "New" hands you the new row's name to type. The row used
   to be one big button, which made its name the one thing on it you could
   not edit. */
function ListLayout({
  rows,
  properties,
  bare,
  peekId,
  renamingId,
  renameCaret,
  onStartRename,
  onStopRename,
  onOpen,
  onAddInline,
  onRename,
  readOnly,
  titleLabel,
}: LayoutProps & RowRenaming & {
  onAddInline(): void;
  titleLabel: string;
}) {
  return (
    <div className="db-list">
      {rows.map((row) => (
        <div key={row.id} className={`db-list__row ${peekId === row.id ? "is-peeked" : ""}`} data-page-id={row.id}>
          <span
            className={`db-list__name ${readOnly ? "" : "is-renamable"}`}
            onClick={(event) => renameOnFreeSpace(event, row, readOnly, onStartRename)}
          >
            <RowName
              row={row}
              mark={bare.has(row.id) ? <span className="db-list__icon" aria-hidden="true" /> : <RowPageMark row={row} className="db-list__icon" size={15} onOpen={onOpen} />}
              titleClass="db-list__title"
              label={titleLabel}
              readOnly={readOnly}
              renaming={row.id === renamingId}
              caret={renameCaret}
              onOpen={onOpen}
              onStopRename={onStopRename}
              onRename={onRename}
            />
          </span>
          <RowChips row={row} properties={properties} limit={2} />
          {row.id === renamingId ? null : <RowActions row={row} onOpen={onOpen} />}
        </div>
      ))}
      <button type="button" className="db__add-row" onClick={onAddInline}>
        <Plus size={15} />New
      </button>
    </div>
  );
}

/** What a gallery card shows above its name, as its view says (Notion's
 *  "Card preview"): a picture from an Image property, the page's cover, the
 *  page itself — its first lines, set small — or nothing at all. */
function CardTop({ row, preview }: { row: NotePage; preview: CardPreview }) {
  if (preview.kind === "none") return null;
  if (preview.kind === "image") return <CardImage row={row} property={preview.property} />;
  const blank = <span className="db-card__glyph">{row.icon || <FileText size={22} strokeWidth={1.5} />}</span>;
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

function GalleryLayout({
  rows,
  properties,
  preview,
  peekId,
  onOpen,
  renamingId,
  onStartRename,
  onStopRename,
  onRename,
  onAddInline,
  readOnly,
}: LayoutProps & CardEditing & { preview: CardPreview }) {
  return (
    <div className={`db-gallery ${preview.kind === "none" ? "db-gallery--bare" : ""}`}>
      {rows.map((row) => {
        const renaming = row.id === renamingId;
        return (
          <div
            key={row.id}
            className={`db-card ${peekId === row.id ? "is-peeked" : ""} ${renaming ? "is-renaming" : ""}`}
            data-page-id={row.id}
          >
            <CardTop row={row} preview={preview} />
            <span className="db-card__body">
              <CardTitle
                row={row}
                renaming={renaming}
                className="db-card__title"
                onOpen={onOpen}
                onRename={onRename}
                onStopRename={onStopRename}
              />
              {/* The properties the view shows on its cards; the picture
                  already on top is not shown again. */}
              <RowChips
                row={row}
                properties={properties}
                exclude={preview.kind === "image" ? preview.property.id : undefined}
                limit={properties.length}
              />
            </span>
            {renaming || readOnly ? null : <CardRename row={row} onStartRename={onStartRename} />}
          </div>
        );
      })}
      {readOnly ? null : (
        <button type="button" className="db-card db-card--new" onClick={() => onAddInline()}>
          <Plus size={16} />New
        </button>
      )}
    </div>
  );
}

function CalendarLayout({
  rows,
  property,
  onOpen,
  onAdd,
  readOnly,
}: LayoutProps & { property: DatabaseProperty }) {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const weekStart = useMemo(() => localeWeekStart(navigator.language), []);
  const days = monthGrid(cursor.year, cursor.month, weekStart);
  const today = isoDate(new Date());

  const byDay = useMemo(() => {
    const map = new Map<string, NotePage[]>();
    for (const row of rows) {
      const value = propertyValue(row, property);
      if (!ISO_DAY.test(value)) continue;
      const key = value.slice(0, 10);
      map.set(key, [...(map.get(key) ?? []), row]);
    }
    return map;
  }, [property, rows]);

  const month = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" })
    .format(new Date(cursor.year, cursor.month, 1));
  const weekdays = days.slice(0, 7).map((day) => new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(day));
  const step = (delta: number) => setCursor(({ year, month: current }) => {
    const next = new Date(year, current + delta, 1);
    return { year: next.getFullYear(), month: next.getMonth() };
  });

  return (
    <div className="db-cal">
      <div className="db-cal__bar">
        <strong className="db-cal__month">{month}</strong>
        <span className="db-cal__nav">
          <button type="button" className="icon-btn icon-btn--sm" aria-label="Previous month" onClick={() => step(-1)}>
            <ChevronLeft size={15} />
          </button>
          <button
            type="button"
            className="btn db-cal__today"
            onClick={() => {
              const now = new Date();
              setCursor({ year: now.getFullYear(), month: now.getMonth() });
            }}
          >
            Today
          </button>
          <button type="button" className="icon-btn icon-btn--sm" aria-label="Next month" onClick={() => step(1)}>
            <ChevronRight size={15} />
          </button>
        </span>
      </div>
      <div className="db-cal__grid" role="grid" aria-label={month}>
        {weekdays.map((weekday) => <span key={weekday} className="db-cal__weekday" role="columnheader">{weekday}</span>)}
        {days.map((day) => {
          const key = isoDate(day);
          const items = byDay.get(key) ?? [];
          const outside = day.getMonth() !== cursor.month;
          const label = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric" }).format(day);
          return (
            <div
              key={key}
              role="gridcell"
              aria-label={label}
              className={`db-cal__day ${outside ? "is-outside" : ""} ${key === today ? "is-today" : ""}`}
            >
              <span className="db-cal__date">{day.getDate()}</span>
              {readOnly ? null : (
                <button
                  type="button"
                  className="db-cal__add"
                  aria-label={`New row on ${label}`}
                  onClick={() => onAdd({ [property.id]: key })}
                >
                  <Plus size={12} />
                </button>
              )}
              {items.slice(0, 3).map((row) => (
                <button type="button" key={row.id} className="db-cal__item" data-page-id={row.id} onClick={(event) => onOpen(row.id, fullPage(event))}>
                  {row.title || "Untitled"}
                </button>
              ))}
              {items.length > 3 ? <span className="db-cal__more">+{items.length - 3} more</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A gallery view's own settings, in its view menu (Notion's "Card preview"
 *  and "Properties"): what each card shows on top, and which properties it
 *  lists. Choosing leaves the menu open, so the cards can be seen change. */
function GallerySettings({
  view,
  properties,
  onChange,
}: {
  view: View;
  properties: DatabaseProperty[];
  onChange(next: View): void;
}) {
  const preview = cardPreview(view, properties);
  const shown = new Set(cardProperties(view, properties).map((property) => property.id));
  const choices: Array<{ value: string; label: string; icon: ReactNode; on: boolean }> = [
    { value: "none", label: "None", icon: <EyeOff size={16} />, on: preview.kind === "none" },
    { value: "cover", label: "Page cover", icon: <PanelTop size={16} />, on: preview.kind === "cover" },
    { value: "content", label: "Page content", icon: <FileText size={16} />, on: preview.kind === "content" },
    ...properties.filter((property) => property.type === "image").map((property) => ({
      value: property.id,
      label: propertyName(property),
      icon: <PropertyIcon property={property} />,
      on: preview.kind === "image" && preview.property.id === property.id,
    })),
  ];
  return (
    <>
      <div className="menu__section-title">Card preview</div>
      {choices.map((choice) => (
        <MenuItem
          key={choice.value}
          icon={choice.icon}
          label={choice.label}
          selected={choice.on}
          onSelect={() => onChange({ ...view, card_preview: choice.value })}
        />
      ))}
      {properties.length ? (
        <>
          <div className="menu__section-title">Properties</div>
          {properties.map((property) => (
            <MenuItem
              key={property.id}
              icon={<PropertyIcon property={property} />}
              label={propertyName(property)}
              selected={shown.has(property.id)}
              onSelect={() => onChange(toggleCardProperty(view, properties, property.id))}
            />
          ))}
        </>
      ) : null}
    </>
  );
}

/* ── The database ──────────────────────────────────────────────────────── */

type MenuState =
  | { kind: "filter" | "sort" | "property" | "add-view" | "views"; anchor: AnchorRect }
  | { kind: "view"; anchor: AnchorRect; viewId: string }
  /* A row's menu, opened where it was right-clicked in any view. */
  | { kind: "row"; anchor: AnchorRect; rowId: string }
  /* A column's menu: a property's id, or TITLE_COLUMN. With no anchor yet it
     is for a column just made, opened under its head once the head is drawn. */
  | { kind: "column"; column: string; anchor: AnchorRect | null };

/** Scrolls the table sideways, when it must, so a column's head is in full
 *  view beside the name column that stays put — a column put at the far end
 *  of a wide table is opened where it can be seen. The table only: never the
 *  page around it. */
function revealColumn(head: HTMLElement): void {
  const wrap = head.closest<HTMLElement>(".db__table-wrap");
  if (!wrap) return;
  const pinned = wrap.querySelector<HTMLElement>("th.db__name")?.offsetWidth ?? 0;
  const left = head.offsetLeft;
  const right = left + head.offsetWidth;
  if (left < wrap.scrollLeft + pinned) wrap.scrollLeft = Math.max(0, left - pinned);
  else if (right > wrap.scrollLeft + wrap.clientWidth) wrap.scrollLeft = right - wrap.clientWidth;
}

/** A database, drawn the same way wherever it appears: as a page of its own,
 *  or inline inside a document. Everything below the title is this component,
 *  so the two can never drift into two different databases.
 *
 *  Views are the database's (shared); which one is open is the reader's
 *  (personal, remembered per database); the search box is this instance's. */
export function DatabaseView({
  databaseId,
  variant,
  readOnly: heldReadOnly = false,
  title,
}: {
  databaseId: string;
  variant: "page" | "inline";
  /** Nothing changed from here, even for someone who may change it: shown
   *  "Read only here", or in an old version of the page. */
  readOnly?: boolean;
  /** An inline database's name, drawn at the start of its toolbar's row; on
   *  its own page the name is the page's. */
  title?: ReactNode;
}) {
  const { document, preferences, setPreference, updatePage: writePage, createPage, selectPage, archivePage, canEdit, commitWrites, platform } = useWorkspace();
  const { peekPageId, openPeek, closePeek, toast } = useUi();
  /* Someone who can only view a shared database reads it, switches between
     its views (which view is open is theirs), filters nothing and changes
     nothing: every write it would send would be refused. A database shown
     "Read only here" is read the same way, whoever reads it. */
  const readOnly = heldReadOnly || !canEdit(databaseId);
  const updatePage = (pageId: string, patch: PagePatch) => { if (!readOnly) writePage(pageId, patch); };
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // The row whose name is being typed — a table's or a list's row, or a card.
  const [renaming, setRenaming] = useState<{ id: string; caret: RenameCaret } | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  /* The database and its rows, each redrawn only when it changes: typing in
     a page elsewhere leaves every database as it is. */
  const database = usePage(databaseId);
  const allRows = useWorkspaceState((state) => databaseRows(state.pages, databaseId), sameItems);
  // The rows that are their values alone, which show no page mark.
  const bareIds = useWorkspaceState((state) => databaseRows(state.pages, databaseId).filter((row) => isBareRow(state.pages, row)).map((row) => row.id), sameItems);
  const bare = useMemo(() => new Set(bareIds), [bareIds]);
  // The row open in the side peek, when it is one of these.
  const peeked = useWorkspaceState((state) => {
    const row = peekPageId ? state.pages[peekPageId] : undefined;
    return row && row.parent_id === databaseId && !row.archived ? row.id : null;
  });
  const config = database?.database;
  const view = config ? activeView(config, preferences.database_views[databaseId]) : null;
  const properties = useMemo(() => config?.properties ?? [], [config]);
  /* Every row's pictures are where the database's readers can reach them,
     whichever view is open: shared from here or from any page above, the
     database's space changes, and the pictures follow. */
  const space = useWorkspaceState((state) => spaceOfPage(state.pages, databaseId));
  useHomedImages(allRows, properties, space);
  useHomedCovers(allRows, space);

  const rows = useMemo(() => {
    if (!config || !view) return [];
    return viewRows(allRows, view, properties, deferredQuery);
  }, [allRows, config, deferredQuery, properties, view]);

  const viewId = view?.id;
  useEffect(() => {
    // Scroll the strip by hand rather than `scrollIntoView`, which would also
    // scroll the document to bring an inline database into view — moving the
    // page under the reader because someone else switched a view.
    const strip = tabsRef.current;
    const tab = strip?.querySelector<HTMLElement>(".view-tab.is-active");
    if (!strip || !tab) return;
    const left = tab.offsetLeft - strip.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < strip.scrollLeft) strip.scrollLeft = left - 8;
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth + 8;
  }, [viewId, config?.views.length]);

  /* A column just made — added, or put in beside another — opens its menu
     with its name ready to type over, as Notion's does. Its head is drawn
     only once the write that made it has come back as state, so the menu is
     anchored here, after that render, rather than where it was asked for. */
  const pendingColumn = menu?.kind === "column" && !menu.anchor ? menu.column : null;
  useLayoutEffect(() => {
    if (!pendingColumn) return;
    const head = rootRef.current?.querySelector<HTMLElement>(`th[data-column="${CSS.escape(pendingColumn)}"]`);
    if (head) {
      revealColumn(head);
      setMenu({ kind: "column", column: pendingColumn, anchor: rectOf(head) });
    } else if (properties.some((property) => property.id === pendingColumn)) {
      // Made, but not drawn as a column here (not a table): nothing to open under.
      setMenu(null);
    }
  }, [pendingColumn, properties]);

  /* A column's menu stays only as long as its column: one someone else
     deleted, or that undo took back, closes. */
  const columnMenu = menu?.kind === "column" && menu.anchor ? { column: menu.column, anchor: menu.anchor } : null;
  const menuColumn = columnMenu?.column ?? null;
  const columnGone = Boolean(menuColumn && menuColumn !== TITLE_COLUMN && !properties.some((property) => property.id === menuColumn));
  useEffect(() => {
    if (columnGone) setMenu(null);
  }, [columnGone]);

  if (!database || !config || !view) return null;

  const filterable = properties.filter((property) => property.type === "status" || property.type === "select");
  const filterProperty = view.filter ? properties.find((property) => property.id === view.filter?.property_id) : undefined;
  const titleLabel = titleName(config);
  /* The columns a view can be sorted by — the row names first, as in its
     table — and the keys it is sorted by now, first key first. */
  const sortColumns: SortColumn[] = [
    { id: TITLE_COLUMN, label: titleLabel, icon: <TitleIcon icon={config.title_icon} /> },
    ...properties.filter(sortable).map((property) => ({ id: property.id, label: propertyName(property), icon: <PropertyIcon property={property} /> })),
  ];
  const sorts = viewSorts(view, properties);
  const sortNames = sorts.map((sort) => sortColumns.find((column) => column.id === sort.property_id)?.label ?? "");
  // One key names its column, as Notion's chip does; several say how many.
  const sortLabel = sorts.length > 1 ? `${sorts.length} sorts` : sortNames[0];
  const sortTitle = sorts.length ? `Sorted by ${sortNames.join(", then ")}` : "Sort";
  const menuView = menu?.kind === "view" ? config.views.find((item) => item.id === menu.viewId) : undefined;
  const menuProperty = menuColumn && menuColumn !== TITLE_COLUMN ? properties.find((property) => property.id === menuColumn) : undefined;
  const newPropertyId = () => createId("property");
  /* Minimal is a table's way of being drawn; the same view turned into a
     board keeps the setting for when it is a table again. */
  const minimal = view.kind === "table" && Boolean(view.minimal);
  /* Inline in a document, a minimal table's toolbar keeps to the view's name
     until the table is approached, so at rest the page reads as words and a
     table. It stays up while anything in it is in use — a menu, a search — or
     while a filter hides rows, which nothing else on screen would say. */
  const quiet = minimal && variant === "inline" && !menu && !searchOpen && !query && !view.filter;

  const saveConfig = (next: DatabaseConfig) => updatePage(databaseId, { database: next });
  const saveView = (next: View) => saveConfig(withView(config, next));
  const openView = (viewId: string) => setPreference("database_views", { ...preferences.database_views, [databaseId]: viewId });

  const addView = (kind: DatabaseViewKind) => {
    const created = createView(createId("view"), kind, config, newPropertyId);
    saveConfig(created.config);
    openView(created.view.id);
    setMenu(null);
  };

  const changeLayout = (target: View, kind: DatabaseViewKind) => {
    saveConfig(changeViewKind(target, kind, config, newPropertyId).config);
  };

  const setProperty = (row: NotePage, propertyId: string, value: string) => updatePage(row.id, rowValues(row, { [propertyId]: value }));

  /* A new row is born matching the view it was made in: inside a filter it
     takes the filtered value, so it does not vanish the moment it exists; in a
     calendar it lands on today; in a board column, in that column. A table
     or a list gives you the new row's name to type where it stands; a board,
     a gallery or a calendar opens it beside, in the side peek, name first. */
  const addRow = (values: Record<string, string> = {}, open: "peek" | "cell" | "card" = view.kind === "table" || view.kind === "list" ? "cell" : "peek") => {
    if (readOnly) return;
    const id = createPage(databaseId, "document", { select: false });
    if (!id) return;
    const seeded: Record<string, string> = { ...values };
    if (view.filter && filterProperty && !(filterProperty.id in seeded)) seeded[filterProperty.id] = view.filter.value;
    if (view.kind === "calendar") {
      const date = calendarProperty(view, properties);
      if (date && !(date.id in seeded)) seeded[date.id] = isoDate(new Date());
    }
    const created = document?.state.pages[id];
    if (created && Object.keys(seeded).length) {
      updatePage(created.id, rowValues(created, seeded));
    }
    if (open === "cell" || open === "card") setRenaming({ id, caret: "end" });
    else openPeek(id);
  };

  /* A column made — at the end, from "Add property", or beside another,
     from its menu — opens its own menu next, its name selected. */
  const addColumn = (type: PropertyType, index: number) => {
    if (readOnly) return;
    const made = insertProperty(config, newPropertyId(), type, index);
    saveConfig(made.config);
    setMenu({ kind: "column", column: made.property.id, anchor: null });
  };

  const insertColumn = (column: string, side: "left" | "right") => {
    const at = column === TITLE_COLUMN ? 0 : properties.findIndex((property) => property.id === column);
    if (at < 0) return;
    addColumn("text", column === TITLE_COLUMN || side === "left" ? at : at + 1);
  };

  /* A copy carries its column's values, as Notion's does: they live on the
     rows, so each row that has one is written — one step to undo. */
  const duplicateColumn = (propertyId: string) => {
    if (readOnly) return;
    const copied = duplicateProperty(config, propertyId, newPropertyId());
    if (!copied) return;
    saveConfig(copied.config);
    for (const { id, patch } of copiedColumn(allRows, propertyId, copied.property)) updatePage(id, patch);
  };

  const saveSorts = (next: ViewSort[]) => {
    saveView(withSorts(view, next));
    // The last key taken away, the panel has nothing left to show.
    if (!next.length) setMenu(null);
  };

  /* A status's options, edited from its column's menu. Rows hold an option's
     name, so a rename or a delete writes the rows holding it too — in the
     same step as the option, so one undo takes both back. */
  const writeRows = (propertyId: string, writes: RowWrite[]) => {
    const byId = new Map(allRows.map((row) => [row.id, row]));
    for (const write of writes) {
      const row = byId.get(write.rowId);
      if (row) setProperty(row, propertyId, write.value);
    }
  };
  const statusEditing = (propertyId: string): StatusEditing => ({
    add: (group, name) => {
      const made = readOnly ? null : addStatusOption(config, propertyId, group, name, createId("status"));
      if (made) saveConfig(made.config);
      return Boolean(made);
    },
    rename: (optionId, name) => {
      const renamed = readOnly ? null : renameStatusOption(config, propertyId, optionId, name, allRows);
      if (!renamed) return false;
      saveConfig(renamed.config);
      writeRows(propertyId, renamed.writes);
      return true;
    },
    recolor: (optionId, color) => saveConfig(recolorStatusOption(config, propertyId, optionId, color)),
    move: (optionId, group, index) => saveConfig(moveStatusOption(config, propertyId, optionId, group, index)),
    makeDefault: (optionId) => saveConfig(setDefaultStatus(config, propertyId, optionId)),
    remove: (optionId) => {
      const removed = readOnly ? null : removeStatusOption(config, propertyId, optionId, allRows);
      if (!removed) return;
      saveConfig(removed.config);
      writeRows(propertyId, removed.writes);
    },
  });

  const board = view.kind === "board" ? boardProperty(view, properties) : undefined;
  const dates = view.kind === "calendar" ? calendarProperty(view, properties) : undefined;
  // The side peek is the window's; this database marks the row it shows, if
  // it is one of this database's.
  // A row opens beside, in the side peek; asked for whole (⌘/Ctrl), it is
  // the page, as the peek's own "Open as full page" makes it.
  const openRow = (id: string, full?: boolean) => {
    if (!full) {
      openPeek(id);
      return;
    }
    selectPage(id);
    closePeek();
  };
  const layoutProps: LayoutProps = { rows, properties, bare, peekId: peeked, onOpen: openRow, onAdd: addRow, readOnly };

  /* A row's own menu, from a right-click on it in any view: Open — the row
     as the page it is — and Delete. */
  const menuRow = menu?.kind === "row" ? allRows.find((row) => row.id === menu.rowId) : undefined;
  const rowMenu = (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target as Element;
    // Words being typed keep the browser's own menu: copy, paste, spelling.
    if (readOnly || target.closest("input, textarea, [contenteditable='true']")) return;
    const rowId = target.closest<HTMLElement>("[data-page-id]")?.dataset.pageId;
    if (!rowId || !allRows.some((row) => row.id === rowId)) return;
    event.preventDefault();
    setRenaming(null);
    setMenu({ kind: "row", rowId, anchor: pointRect(event.clientX, event.clientY) });
  };
  const rename = (row: NotePage, name: InlineContent) => updatePage(row.id, titleFields(name));
  const cardEditing: CardEditing = {
    renamingId: renaming?.id ?? null,
    onStartRename: (id) => setRenaming({ id, caret: "all" }),
    onStopRename: () => setRenaming(null),
    onRename: rename,
    onAddInline: (values) => addRow(values, "card"),
  };
  const rowRenaming: RowRenaming = {
    renamingId: renaming?.id ?? null,
    renameCaret: renaming?.caret ?? "end",
    onStartRename: (id, caret = "all") => {
      if (!readOnly) setRenaming({ id, caret });
    },
    onStopRename: () => setRenaming(null),
    onRename: rename,
  };

  /* The tabs — the narrow database's one switch, or the strip — only once
     there is a second view: one view needs no tab to say which it is. */
  const tabs = config.views.length > 1 ? (
    <>
      <button
        type="button"
        className="db__view-switch"
        aria-haspopup="menu"
        aria-label={`View: ${view.name || viewKindLabel(view.kind)}`}
        onClick={(event) => setMenu({ kind: "views", anchor: rectOf(event.currentTarget) })}
      >
        <ViewIcon kind={view.kind} />
        <span className="view-tab__name">{view.name || viewKindLabel(view.kind)}</span>
        <ChevronDown size={14} />
      </button>
      <div className="db__views" role="tablist" aria-label="Views" ref={tabsRef}>
        {config.views.map((item) => {
          const active = item.id === view.id;
          return (
            <button
              type="button"
              role="tab"
              key={item.id}
              aria-selected={active}
              aria-haspopup={active ? "menu" : undefined}
              className={`view-tab ${active ? "is-active" : ""}`}
              // Notion's grammar: a tab you are not on switches to it; the
              // tab you ARE on opens its settings. Right-click does the
              // latter from anywhere.
              onClick={(event) => {
                if (!active) openView(item.id);
                else if (!readOnly) setMenu({ kind: "view", viewId: item.id, anchor: rectOf(event.currentTarget) });
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                if (!readOnly) setMenu({ kind: "view", viewId: item.id, anchor: rectOf(event.currentTarget) });
              }}
            >
              <ViewIcon kind={item.kind} />
              <span className="view-tab__name">{item.name || viewKindLabel(item.kind)}</span>
            </button>
          );
        })}
        <Tooltip label="Add a view">
          <button
            type="button"
            className="view-tab view-tab--add"
            aria-label="Add a view"
            onClick={(event) => setMenu({ kind: "add-view", anchor: rectOf(event.currentTarget) })}
          >
            <Plus size={15} />
          </button>
        </Tooltip>
      </div>
    </>
  ) : null;
  // The tools stay in sight while one of them is in use.
  const toolsHeld = Boolean(view.filter) || sorts.length > 0 || searchOpen || Boolean(query) || menu !== null;

  let layout;
  if (view.kind === "board" && board) {
    layout = (
      <BoardLayout
        {...layoutProps}
        {...cardEditing}
        property={board}
        onMove={(row, value) => setProperty(row, board.id, value)}
      />
    );
  } else if (view.kind === "list") {
    layout = (
      <ListLayout
        {...layoutProps}
        {...rowRenaming}
        onAddInline={() => addRow({}, "cell")}
        titleLabel={titleLabel}
      />
    );
  } else if (view.kind === "gallery") {
    layout = (
      <GalleryLayout
        {...layoutProps}
        {...cardEditing}
        properties={cardProperties(view, properties)}
        preview={cardPreview(view, properties)}
      />
    );
  } else if (view.kind === "calendar" && dates) {
    layout = <CalendarLayout {...layoutProps} property={dates} />;
  } else {
    layout = (
      <TableLayout
        {...layoutProps}
        {...rowRenaming}
        onAddInline={() => addRow({}, "cell")}
        onSetProperty={setProperty}
        onAddProperty={(anchor) => setMenu({ kind: "property", anchor })}
        minimal={minimal}
        view={view}
        titleLabel={titleLabel}
        titleIcon={config.title_icon}
        menuColumn={menuColumn}
        onColumnMenu={(column, anchor) => setMenu({ kind: "column", column, anchor })}
        onResize={(column, width) => saveView(withColumnWidth(view, column, width))}
      />
    );
  }

  return (
    <div
      ref={rootRef}
      className={`dbv dbv--${variant} ${readOnly ? "dbv--readonly" : ""} ${minimal ? "dbv--minimal" : ""} ${quiet ? "dbv--quiet" : ""}`}
      onContextMenu={rowMenu}
    >
      {/* One row: an inline database's name — on its own page, whose name is
          the page's, its views — then its tools: Filter, Sort, Search and ···,
          which holds the rest of the view and of the database. In a document
          the tools come when the pointer does, and stay while one is in use.
          A second view brings the tabs, under the name. A row is added where
          the rows are (+ New), never from up here. */}
      <div className={`db__toolbar ${toolsHeld ? "is-held" : ""}`}>
        {title ? <div className="db__title">{title}</div> : <div className="db__tabs">{tabs}</div>}
        <div className="db__tools">
          {filterable.length && !readOnly ? (
            <Tooltip label={view.filter ? `${filterProperty ? propertyName(filterProperty) : ""}: ${view.filter.value}` : "Filter"}>
              <button
                type="button"
                className={`db__tool ${view.filter ? "is-on" : ""}`}
                aria-label={view.filter ? `Filtered by ${filterProperty ? propertyName(filterProperty) : ""}: ${view.filter.value}` : "Filter"}
                onClick={(event) => setMenu({ kind: "filter", anchor: rectOf(event.currentTarget) })}
              >
                <Filter size={15} />
                {view.filter ? <span className="db__tool-label">{view.filter.value}</span> : null}
              </button>
            </Tooltip>
          ) : null}
          {readOnly ? null : (
            <Tooltip label={sortTitle}>
              <button
                type="button"
                className={`db__tool ${sorts.length ? "is-on" : ""}`}
                aria-label={sortTitle}
                onClick={(event) => setMenu({ kind: "sort", anchor: rectOf(event.currentTarget) })}
              >
                {/* Sorted, the arrow is the first key's direction, as on
                    Notion's sort chip. */}
                {!sorts.length ? <ArrowDownAZ size={15} /> : sorts[0].direction === "desc" ? <ArrowDown size={15} /> : <ArrowUp size={15} />}
                {sorts.length ? <span className="db__tool-label">{sortLabel}</span> : null}
              </button>
            </Tooltip>
          )}
          {/* Search sits right after Sort (Winston, round 60). The box opens
              out of the button. */}
          <input
            ref={searchRef}
            className={`db__search ${searchOpen ? "is-open" : ""}`}
            value={query}
            aria-label="Search this database"
            placeholder="Search…"
            tabIndex={searchOpen ? 0 : -1}
            onChange={(event) => setQuery(event.target.value)}
            onBlur={() => { if (!query) setSearchOpen(false); }}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || imeComposing(event)) return;
              setQuery("");
              setSearchOpen(false);
            }}
          />
          <Tooltip label="Search">
            <button
              type="button"
              className="icon-btn"
              aria-label="Search this database"
              onClick={() => {
                setSearchOpen((open) => !open);
                window.setTimeout(() => searchRef.current?.focus(), 60);
              }}
            >
              <Search size={16} />
            </button>
          </Tooltip>
          {readOnly ? (
            variant === "inline" ? (
              <Tooltip label="Open as full page">
                <button type="button" className="db__tool" aria-label="Open as full page" onClick={() => selectPage(databaseId)}>
                  <ArrowUpRight size={16} />
                </button>
              </Tooltip>
            ) : null
          ) : (
            <Tooltip label="View and database settings">
              <button
                type="button"
                className={`db__tool ${menu?.kind === "view" && menu.viewId === view.id ? "is-open" : ""}`}
                aria-label="View and database settings"
                aria-haspopup="menu"
                onClick={(event) => setMenu({ kind: "view", viewId: view.id, anchor: rectOf(event.currentTarget) })}
              >
                <MoreHorizontal size={16} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
      {title && tabs ? <div className="db__toolbar db__toolbar--tabs"><div className="db__tabs">{tabs}</div></div> : null}

      {layout}

      {columnMenu && menuColumn && (menuColumn === TITLE_COLUMN || menuProperty) ? (
        <PropertyMenu
          key={menuColumn}
          anchor={columnMenu.anchor}
          databaseId={databaseId}
          property={menuProperty ?? null}
          name={menuProperty ? menuProperty.name : config.title_name ?? titleLabel}
          placeholder={menuProperty ? PROPERTY_LABELS[menuProperty.type] : "Name"}
          icon={menuProperty ? menuProperty.icon : config.title_icon}
          sort={sorts.find((sort) => sort.property_id === menuColumn)?.direction}
          wrap={menuColumn === TITLE_COLUMN || menuProperty?.type === "text" ? columnWraps(view, menuColumn) : undefined}
          statusEditing={menuProperty?.type === "status" ? statusEditing(menuProperty.id) : undefined}
          onRename={(name) => saveConfig(renameProperty(config, menuColumn, name))}
          onIcon={(icon) => saveConfig(setPropertyIcon(config, menuColumn, icon))}
          onChangeType={(type) => saveConfig(changePropertyType(config, menuColumn, type, allRows))}
          onSort={(direction) => saveView(sortByColumn(view, properties, menuColumn, direction))}
          onWrap={(wraps) => saveView(withColumnWrap(view, menuColumn, wraps))}
          onInsert={(side) => insertColumn(menuColumn, side)}
          onDuplicate={() => duplicateColumn(menuColumn)}
          onDelete={() => saveConfig(removeProperty(config, menuColumn))}
          onClose={() => setMenu(null)}
        />
      ) : null}

      <Popover
        open={menu?.kind === "row" && Boolean(menuRow)}
        anchor={menu?.kind === "row" ? menu.anchor : null}
        placement="bottom-start"
        label="Row"
        onDismiss={() => setMenu(null)}
      >
        {menuRow ? (
          <MenuList label="Row" autoFocus>
            <MenuItem icon={<Maximize2 size={16} />} label="Open" onSelect={() => { setMenu(null); openRow(menuRow.id); }} />
            <MenuDivider />
            <MenuItem
              icon={<Trash2 size={16} />}
              label="Delete"
              tone="danger"
              onSelect={() => {
                setMenu(null);
                if (peekPageId === menuRow.id) closePeek();
                archivePage(menuRow.id);
              }}
            />
          </MenuList>
        ) : <div />}
      </Popover>

      <Popover
        open={menu?.kind === "view" && Boolean(menuView)}
        anchor={menu?.kind === "view" ? menu.anchor : null}
        placement="bottom-start"
        label="View settings"
        onDismiss={() => setMenu(null)}
      >
        {menuView ? (
          <div className="view-menu">
            {/* One view has no tab to name: the database's name is its name. */}
            {config.views.length > 1 ? <input
              className="view-menu__name"
              value={menuView.name}
              aria-label="View name"
              data-history-field={`view:${menuView.id}`}
              data-page-id={databaseId}
              placeholder={viewKindLabel(menuView.kind)}
              onChange={(event) => saveView({ ...menuView, name: event.target.value })}
              onKeyDown={(event) => { if (event.key === "Enter" && !imeComposing(event)) setMenu(null); }}
            /> : null}
            <MenuList label="View settings" autoFocus={config.views.length <= 1}>
              <div className="menu__section-title">Layout</div>
              {VIEW_KINDS.map((kind) => (
                <MenuItem
                  key={kind}
                  icon={<ViewIcon kind={kind} size={16} />}
                  label={viewKindLabel(kind)}
                  selected={menuView.kind === kind}
                  onSelect={() => changeLayout(menuView, kind)}
                />
              ))}
              {menuView.kind === "board" && groupableProperties(properties).length > 1 ? (
                <>
                  <div className="menu__section-title">Group by</div>
                  {groupableProperties(properties).map((property) => (
                    <MenuItem
                      key={property.id}
                      icon={<PropertyIcon property={property} />}
                      label={propertyName(property)}
                      selected={boardProperty(menuView, properties)?.id === property.id}
                      onSelect={() => saveView({ ...menuView, group_by: property.id })}
                    />
                  ))}
                </>
              ) : null}
              {menuView.kind === "calendar" && properties.filter((property) => property.type === "date").length > 1 ? (
                <>
                  <div className="menu__section-title">Show by</div>
                  {properties.filter((property) => property.type === "date").map((property) => (
                    <MenuItem
                      key={property.id}
                      icon={<PropertyIcon property={property} />}
                      label={propertyName(property)}
                      selected={calendarProperty(menuView, properties)?.id === property.id}
                      onSelect={() => saveView({ ...menuView, date_by: property.id })}
                    />
                  ))}
                </>
              ) : null}
              {menuView.kind === "gallery" ? (
                <GallerySettings
                  view={menuView}
                  properties={properties}
                  onChange={saveView}
                />
              ) : null}
              <MenuDivider />
              <MenuItem
                icon={<Copy size={16} />}
                label="Duplicate view"
                onSelect={() => {
                  const copied = duplicateView(config, menuView.id, createId("view"));
                  if (!copied) return;
                  saveConfig(copied.config);
                  openView(copied.view.id);
                  setMenu(null);
                }}
              />
              {config.views.length > 1 ? (
                <MenuItem
                  icon={<Trash2 size={16} />}
                  label="Delete view"
                  tone="danger"
                  onSelect={() => {
                    const next = removeView(config, menuView.id);
                    if (!next) return;
                    saveConfig(next);
                    setMenu(null);
                  }}
                />
              ) : (
                <MenuItem
                  icon={<Plus size={16} />}
                  label="Add a view"
                  onSelect={() => { if (menu?.anchor) setMenu({ kind: "add-view", anchor: menu.anchor }); }}
                />
              )}
              {/* The database's own: drawn plain, opened whole, or turned back
                  into a table or a list — offered only when it can be, its rows
                  empty (convert.ts); one step of undo either way, the rows
                  going with it. */}
              <MenuDivider />
              {menuView.kind === "table" ? (
                <MenuItem
                  icon={<Minimize2 size={16} />}
                  label="Minimal table"
                  selected={Boolean(menuView.minimal)}
                  onSelect={() => saveView({ ...menuView, minimal: !menuView.minimal })}
                />
              ) : null}
              {variant === "inline" ? (
                <MenuItem icon={<ArrowUpRight size={16} />} label="Open as full page" onSelect={() => { setMenu(null); selectPage(databaseId); }} />
              ) : null}
              {document ? (() => {
                const convertible = databaseConvertible(document.state.pages, databaseId);
                const turn = (as: "table" | "list") => {
                  setMenu(null);
                  if (!platform) return;
                  const done = databaseToBlocks(document.state.pages, databaseId, as, view, {
                    page: (kind) => createId(kind),
                    block: () => createId("block"),
                    property: () => createId("property"),
                    view: () => createId("view"),
                    column: () => createId("col"),
                    row: () => createId("row"),
                  }, { now: new Date().toISOString(), author: platform.bootstrap.user.displayName }, ordersBetween);
                  if ("refusal" in done) toast(done.refusal, "error");
                  else commitWrites(done.mutations);
                };
                if (convertible.table && convertible.list) return null;
                return (
                  <>
                    <div className="menu__section-title">Turn into</div>
                    {convertible.table ? null : <MenuItem icon={<Table size={16} />} label="Table" onSelect={() => turn("table")} />}
                    {convertible.list ? null : <MenuItem icon={<List size={16} />} label="List" onSelect={() => turn("list")} />}
                  </>
                );
              })() : null}
            </MenuList>
          </div>
        ) : <div />}
      </Popover>

      <Popover
        open={menu?.kind === "views"}
        anchor={menu?.kind === "views" ? menu.anchor : null}
        placement="bottom-start"
        label="Views"
        onDismiss={() => setMenu(null)}
      >
        <MenuList label="Views" autoFocus>
          <div className="menu__section-title">Views</div>
          {config.views.map((item) => (
            <MenuItem
              key={item.id}
              icon={<ViewIcon kind={item.kind} size={16} />}
              label={item.name || viewKindLabel(item.kind)}
              selected={item.id === view.id}
              onSelect={() => { openView(item.id); setMenu(null); }}
            />
          ))}
          <MenuDivider />
          <MenuItem
            icon={<SlidersHorizontal size={16} />}
            label="Edit this view"
            onSelect={() => { if (menu?.anchor) setMenu({ kind: "view", viewId: view.id, anchor: menu.anchor }); }}
          />
          <MenuItem
            icon={<Plus size={16} />}
            label="Add a view"
            onSelect={() => { if (menu?.anchor) setMenu({ kind: "add-view", anchor: menu.anchor }); }}
          />
        </MenuList>
      </Popover>

      <Popover
        open={menu?.kind === "add-view"}
        anchor={menu?.kind === "add-view" ? menu.anchor : null}
        placement="bottom-start"
        label="Add a view"
        onDismiss={() => setMenu(null)}
      >
        <MenuList label="Add a view" autoFocus>
          <div className="menu__section-title">Add a view</div>
          {VIEW_KINDS.map((kind) => (
            <MenuItem
              key={kind}
              icon={<ViewIcon kind={kind} size={16} />}
              label={viewKindLabel(kind)}
              onSelect={() => addView(kind)}
            />
          ))}
        </MenuList>
      </Popover>

      <Popover
        open={menu?.kind === "filter"}
        anchor={menu?.kind === "filter" ? menu.anchor : null}
        placement="bottom-end"
        label="Filter"
        onDismiss={() => setMenu(null)}
      >
        <MenuList label="Filter" autoFocus>
          {filterable.map((property) => (
            <div key={property.id} className="menu__group">
              <div className="menu__section-title">{propertyName(property)}</div>
              {propertyOptions(property).map((option) => (
                <MenuItem
                  key={option}
                  label={option}
                  selected={view.filter?.property_id === property.id && view.filter.value === option}
                  onSelect={() => { saveView({ ...view, filter: { property_id: property.id, value: option } }); setMenu(null); }}
                />
              ))}
            </div>
          ))}
          <MenuDivider />
          <MenuItem
            icon={<X size={16} />}
            label="Clear filter"
            disabled={!view.filter}
            onSelect={() => { saveView({ ...view, filter: undefined }); setMenu(null); }}
          />
        </MenuList>
      </Popover>

      <Popover
        open={menu?.kind === "sort"}
        anchor={menu?.kind === "sort" ? menu.anchor : null}
        placement="bottom-end"
        label="Sort"
        onDismiss={() => setMenu(null)}
      >
        {/* Unsorted, Sort is the list of what to sort by; sorted, it is the
            view's sorts, as Notion's panel. */}
        {sorts.length ? (
          <SortPanel sorts={sorts} columns={sortColumns} onChange={saveSorts} />
        ) : (
          <MenuList label="Sort by" autoFocus>
            <div className="menu__section-title">Sort by</div>
            {sortColumns.map((column) => (
              <MenuItem
                key={column.id}
                icon={column.icon}
                label={column.label}
                onSelect={() => saveView(withSorts(view, [{ property_id: column.id, direction: "asc" }]))}
              />
            ))}
          </MenuList>
        )}
      </Popover>

      <Popover
        open={menu?.kind === "property"}
        anchor={menu?.kind === "property" ? menu.anchor : null}
        placement="bottom-start"
        label="Add property"
        onDismiss={() => setMenu(null)}
      >
        <MenuList label="Property type" autoFocus>
          {PROPERTY_TYPES.map((type) => (
            <MenuItem
              key={type}
              icon={<TypeIcon type={type} />}
              label={PROPERTY_LABELS[type]}
              onSelect={() => addColumn(type, properties.length)}
            />
          ))}
        </MenuList>
      </Popover>

    </div>
  );
}
