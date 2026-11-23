import {
  ChevronRight,
  Plus,
} from "lucide-react";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Avatar } from "../../../components/Avatar";
import { Select } from "../../../components/Select";
import { Tooltip } from "../../../components/Tooltip";
import { rectOf, type AnchorRect } from "../../../hooks/useAnchoredPosition";
import type {
  DatabaseProperty,
  DatabaseView as View,
  NotePage,
} from "../../../core/types";
import {
  calcKinds,
  CALC_LABELS,
  calcValue,
  clampColumnWidth,
  COLUMN_DRAG,
  COLUMN_WIDTH,
  columnWidth,
  columnWraps,
  isMetaType,
  propertyName,
  TITLE_COLUMN,
  type ViewGroup,
} from "../database-model";
import { formatDay, OptionTag, PropertyEditor, PropertyIcon, TitleIcon } from "../properties";
import { tableEdges } from "../table-edges";
import {
  renameOnFreeSpace,
  RowActions,
  RowGrip,
  RowName,
  RowPageMark,
  type LayoutProps,
  type RowRenaming,
} from "./shared";

/** A column's head: its mark and its name. Pressed, it opens the column's
 *  menu — its name, its type, a sort, a column beside it — as Notion's does;
 *  for a reader who may only look it is a label. */
function ColumnHead({
  icon,
  label,
  open,
  readOnly,
  onMenu,
  draggable,
  onColumnDragStart,
  onColumnDragEnd,
}: {
  icon: ReactNode;
  label: string;
  open: boolean;
  readOnly: boolean;
  onMenu(anchor: AnchorRect): void;
  /** A column head may be pulled straight onto another's place — a press
      that goes nowhere is still the menu's click. */
  draggable?: boolean;
  onColumnDragStart?(event: ReactDragEvent<HTMLElement>): void;
  onColumnDragEnd?(): void;
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
      draggable={draggable}
      onDragStart={onColumnDragStart}
      onDragEnd={onColumnDragEnd}
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
/** A footer's one cell: the calculation the column runs, and its answer —
 *  a dash while there is nothing to count. */
function CalcCell({
  column,
  property,
  view,
  rows,
  readOnly,
  onCalc,
}: {
  column: string;
  property?: DatabaseProperty;
  view: View;
  rows: readonly NotePage[];
  readOnly: boolean;
  onCalc(column: string, kind: string | null): void;
}) {
  const kinds = calcKinds(column, property);
  const kind = view.calcs?.[column] ?? "";
  const options = [
    { value: "", label: "None" },
    ...kinds.map((item) => ({ value: item, label: CALC_LABELS[item] ?? item })),
    // A stored name this type no longer offers stays named, not silent.
    ...(kind && !kinds.includes(kind) ? [{ value: kind, label: CALC_LABELS[kind] ?? kind }] : []),
  ];
  if (!kinds.length) return <span className="db__calc db__calc--none">—</span>;
  const answer = kind ? calcValue(rows, column, property, kind) : null;
  return (
    <span className="db__calc">
      <Select
        size="compact"
        variant="ghost"
        className="db__calc-fn"
        aria-label={`Calculation for ${property ? propertyName(property) : "the name column"}`}
        disabled={readOnly || !kinds.length}
        value={kind}
        onValueChange={(next) => onCalc(column, next || null)}
        options={options}
      />
      {kind ? <span className={`db__calc-val ${answer === null ? "is-empty" : ""}`}>{answer ?? "—"}</span> : null}
    </span>
  );
}

export function TableLayout({
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
  onReorder,
  onReorderRow,
  reorderable,
  groups,
  groupedBy,
  onCalc,
}: LayoutProps & RowRenaming & {
  onAddInline(values?: Record<string, string>): void;
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
  /** A column head pulled onto a neighbour's side: the dragged column's id,
      the column beside the gap it lands in, and which side of that column.
      DatabaseView turns the pair into a spot inside its own list — hidden
      columns a head never drew count. */
  onReorder?(propertyId: string, boundaryId: string, place: "before" | "after"): void;
  /** The row groups and the property they group by — none, one open group. */
  groups: readonly ViewGroup[];
  groupedBy: DatabaseProperty | undefined;
  /** A column's footer calculation chosen — null clears it. */
  onCalc(column: string, kind: string | null): void;
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

  /* A column head held by its name is the same drag the Columns panel gives
     a grip: its shadow follows the pointer, a blue edge marks the gap it
     fills and its column washes over so the rows read where it lands. Own
     and system columns keep to their own lists — a head only takes one that
     matches its kind. The name column stays put; a reader drags nothing. */
  const [colDrag, setColDrag] = useState<{ id: string; meta: boolean } | null>(null);
  const [colSpot, setColSpot] = useState<{ id: string; place: "before" | "after" } | null>(null);
  const colSpotFor = (property: DatabaseProperty, event: ReactDragEvent<HTMLElement>) => {
    if (!colDrag || readOnly || colDrag.meta !== isMetaType(property.type) || colDrag.id === property.id) return;
    const before = event.clientX < event.currentTarget.getBoundingClientRect().left + event.currentTarget.offsetWidth / 2;
    setColSpot({ id: property.id, place: before ? "before" : "after" });
  };
  const dropColumn = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    if (colSpot && colDrag) onReorder?.(colDrag.id, colSpot.id, colSpot.place);
    setColDrag(null);
    setColSpot(null);
  };

  /* Groups fold away where the header is toggled — a pointer's choice for
     the moment, never written to the view: they open again as they were. */
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const foldedGroups = groupedBy ? folded : new Set<string>();
  const fold = (key: string) => setFolded((held) => {
    const next = new Set(held);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  /* A row being dragged and the gap it hovers over. Neither is state: the
     body below is memoised (redrawing every cell for every hovered row is
     what the memo is there to prevent), so the drag is tracked in refs and
     the drop line is drawn by marking the hovered <tr> itself — a DOM mark
     the next render does not disturb, cleared when the drag ends. */
  const rowDrag = useRef<string | null>(null);
  const rowSpot = useRef<{
    el: HTMLElement;
    rowId: string | null;
    place: "before" | "after";
    seed?: { propertyId: string; value: string };
  } | null>(null);
  const clearRowSpot = () => {
    rowSpot.current?.el.classList.remove("is-rdrop-before", "is-rdrop-after");
    rowSpot.current = null;
  };
  /* The value a row dropped in `group` should take from the property the
     view groups by — its seed, or "" for the no-value group; undefined on a
     flat view, where nothing is seeded. */
  const seedOf = (group: ViewGroup | undefined): { propertyId: string; value: string } | undefined =>
    groupedBy && group ? { propertyId: groupedBy.id, value: group.seed ?? "" } : undefined;
  const markRowSpot = (el: HTMLElement, row: NotePage, group: ViewGroup | undefined, event: ReactDragEvent<HTMLElement>) => {
    const place: "before" | "after" = event.clientY < el.getBoundingClientRect().top + el.offsetHeight / 2 ? "before" : "after";
    if (rowSpot.current?.rowId === row.id && rowSpot.current.place === place) return;
    clearRowSpot();
    el.classList.add(place === "before" ? "is-rdrop-before" : "is-rdrop-after");
    rowSpot.current = { el, rowId: row.id, place, seed: seedOf(group) };
  };
  /* A group header takes a drop as "into the group, after its last row" —
     the one way into an empty group, which has no row to land beside. */
  const markGroupSpot = (el: HTMLElement, group: ViewGroup) => {
    clearRowSpot();
    el.classList.add("is-rdrop-after");
    const last = group.rows[group.rows.length - 1];
    rowSpot.current = { el, rowId: last ? last.id : null, place: "after", seed: seedOf(group) };
  };
  const rowOver = (row: NotePage, group: ViewGroup | undefined) => (event: ReactDragEvent<HTMLElement>) => {
    if (!rowDrag.current || rowDrag.current === row.id) return;
    event.preventDefault();
    markRowSpot(event.currentTarget, row, group, event);
  };
  const headOver = (group: ViewGroup) => (event: ReactDragEvent<HTMLElement>) => {
    if (!rowDrag.current) return;
    event.preventDefault();
    markGroupSpot(event.currentTarget, group);
  };
  const rowOut = () => {
    if (rowDrag.current) clearRowSpot();
  };
  const rowDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (!rowDrag.current) return;
    event.preventDefault();
    const spot = rowSpot.current;
    onReorderRow(rowDrag.current, spot?.rowId ?? null, spot?.place ?? "after", spot?.seed);
    clearRowSpot();
    rowDrag.current = null;
  };
  /* A row stepped by its focused grip: one place — before or after its
     immediate neighbour — in the group it belongs to, or in the whole
     list ungrouped. A row at the edge steps nowhere. */
  const stepRow = (row: NotePage, group: ViewGroup | undefined, step: -1 | 1) => {
    const sequence = groupedBy && group ? group.rows : rows;
    const at = sequence.findIndex((item) => item.id === row.id);
    const neighbour = sequence[at + step];
    if (at < 0 || !neighbour) return;
    onReorderRow(row.id, neighbour.id, step < 0 ? "before" : "after", seedOf(group));
  };

  /* The rows, kept while only a width changes: a drag redraws the columns,
     never every cell. Grouped, each group opens with its header — chevron,
     value and count — and its rows fold under it; a column counting in the
     footer puts its own subtotal under each group. */
  const body = useMemo(() => {
    const keptToOneLine = new Set(oneLine.split("\n"));
    const rowTr = (row: NotePage, group: ViewGroup | undefined, foldedIn: string) => (
      <tr
        key={`${foldedIn}${row.id}`}
        className={`${foldedIn ? "is-folded" : ""} ${peekId === row.id ? "is-peeked" : ""}`}
        data-page-id={row.id}
        onDragOver={reorderable ? rowOver(row, group) : undefined}
        onDragLeave={reorderable ? rowOut : undefined}
        onDrop={reorderable ? rowDrop : undefined}
      >
        {/* The name is a link to the page, as Notion's is; the cell
            around it is where the name is typed — all of it, below a
            short name in a row that another cell's words make tall too. */}
        <td
          className={`db__name ${readOnly ? "" : "is-renamable"}`}
          onClick={(event) => renameOnFreeSpace(event, row, readOnly, onStartRename)}
        >
          <div className={`db__row-name ${namesWrap ? "is-wrapped" : ""}`}>
            {reorderable && row.id !== renamingId ? (
              <RowGrip
                row={row}
                ghost="tr"
                onDragStart={() => { rowDrag.current = row.id; }}
                onDragEnd={() => { rowDrag.current = null; clearRowSpot(); }}
                onMove={(step) => stepRow(row, group, step)}
              />
            ) : null}
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
    );
    const groupHead = (group: ViewGroup) => {
      const closed = foldedGroups.has(group.key);
      const label = group.key === ""
        ? <span className="grp-h__none">No {groupedBy ? propertyName(groupedBy) : "value"}</span>
        : !groupedBy ? group.value
        : groupedBy.type === "select" || groupedBy.type === "status" || groupedBy.type === "multi_select"
          ? <OptionTag property={groupedBy} value={group.value} />
          : groupedBy.type === "checkbox"
            ? (group.value === "true" ? "Checked" : "Unchecked")
            : groupedBy.type === "person"
              ? <><Avatar name={group.value} size={16} />{group.value}</>
              : groupedBy.type === "date" ? formatDay(group.value) : group.value;
      return (
        <tr
          className="grp-row"
          onDragOver={reorderable && groupedBy ? headOver(group) : undefined}
          onDragLeave={reorderable && groupedBy ? rowOut : undefined}
          onDrop={reorderable && groupedBy ? rowDrop : undefined}
        >
          <td className="db__name">
            <div className="grp-h">
              <button
                type="button"
                className="grp-h__toggle"
                aria-expanded={!closed}
                aria-label={`${closed ? "Expand" : "Collapse"} group ${group.value || "No value"}`}
                onClick={() => fold(group.key)}
              >
                <ChevronRight className={`grp-h__chev ${closed ? "is-closed" : ""}`} size={14} />
                <span className="grp-h__label">{label}</span>
                <span className="grp-h__count">{group.rows.length}</span>
              </button>
              {/* A new row under a header takes the group's own value; the
                  no-value group seeds nothing — its New is the table's. */}
              {readOnly || group.seed === null || !groupedBy ? null : (
                <button type="button" className="grp-h__add" aria-label={`New row in ${group.value}`} onClick={() => onAddInline({ [groupedBy.id]: group.seed ?? "" })}>
                  <Plus size={13} />New
                </button>
              )}
            </div>
          </td>
          {properties.map((property) => {
            const kind = view.calcs?.[property.id];
            const value = kind ? calcValue(group.rows, property.id, property, kind) : null;
            return <td key={property.id} className={value !== null ? "grp-sum" : undefined}>{value !== null ? <span className="grp-sum__val">{value}</span> : null}</td>;
          })}
          {minimal ? null : <td />}
        </tr>
      );
    };
    return (
      <tbody>
        {groups.length > 1 || groupedBy ? groups.map((group) => (
          <Fragment key={`${groupedBy?.id ?? ""}~${group.key}`}>
            {groupHead(group)}
            {group.rows.map((row) => rowTr(row, group, foldedGroups.has(group.key) ? "1" : ""))}
          </Fragment>
        )) : rows.map((row) => rowTr(row, groups[0], ""))}
      </tbody>
    );
    /* eslint-disable-next-line react-hooks/exhaustive-deps — the row drag
       helpers are stable refs-and-callbacks closed over the render. */
  }, [bare, foldedGroups, groupedBy, groups, minimal, namesWrap, onAddInline, onOpen, oneLine, onRename, onSetProperty, onStartRename, onStopRename, peekId, properties, readOnly, renameCaret, renamingId, reorderable, rows, titleLabel, view.calcs]);

  return (
    <div ref={tableEdges} className="db__table-wrap" role="region" tabIndex={0} aria-label="Database table">
      <table className="db__table" style={{ width: tableWidth }}>
        <colgroup>
          <col style={{ width: title }} />
          {properties.map((property, index) => (
            <col
              key={property.id}
              style={{ width: widths[index] }}
              className={`${colDrag?.id === property.id ? "is-col-dragging" : ""} ${colSpot?.id === property.id ? "is-col-spot" : ""}`}
            />
          ))}
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
              <th
                key={property.id}
                data-column={property.id}
                className={`${colSpot?.id === property.id ? `is-col-drop-${colSpot.place}` : ""}`}
                onDragOver={(event) => { if (colDrag) { event.preventDefault(); colSpotFor(property, event); } }}
                onDrop={dropColumn}
              >
                <ColumnHead
                  icon={minimal ? null : <PropertyIcon property={property} />}
                  label={propertyName(property)}
                  open={menuColumn === property.id}
                  readOnly={readOnly}
                  draggable={!readOnly && Boolean(onReorder)}
                  onColumnDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData(COLUMN_DRAG, property.id);
                    setColDrag({ id: property.id, meta: isMetaType(property.type) });
                  }}
                  onColumnDragEnd={() => { setColDrag(null); setColSpot(null); }}
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
        {view.calcs && Object.keys(view.calcs).length ? (
          <tfoot>
            <tr>
              {/* The footer counts what the rows show — filter and search
                  applied — under the column it belongs to. */}
              <td className="db__name"><CalcCell column={TITLE_COLUMN} view={view} rows={rows} readOnly={readOnly} onCalc={onCalc} /></td>
              {properties.map((property) => (
                <td key={property.id}><CalcCell column={property.id} property={property} view={view} rows={rows} readOnly={readOnly} onCalc={onCalc} /></td>
              ))}
              {minimal ? null : <td />}
            </tr>
          </tfoot>
        ) : null}
      </table>
      {readOnly ? null : (
        <button type="button" className="db__add-row" onClick={() => onAddInline()}>
          <Plus size={15} />New
        </button>
      )}
    </div>
  );
}
