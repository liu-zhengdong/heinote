import { ChevronRight, Plus } from "lucide-react";
import {
  Fragment,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";
import { Avatar } from "../../../components/Avatar";
import type { DatabaseProperty, NotePage } from "../../../core/types";
import { propertyName, type ViewGroup } from "../database-model";
import { formatDay, OptionTag } from "../properties";
import {
  renameOnFreeSpace,
  RowActions,
  RowChips,
  RowGrip,
  RowName,
  RowPageMark,
  type LayoutProps,
  type RowRenaming,
} from "./shared";

/* A list row works exactly like a table row: its name — mark and words — is
   a link to the page, the space beside it is where the name is typed (or the
   pencil), and "New" hands you the new row's name to type. The row used
   to be one big button, which made its name the one thing on it you could
   not edit. */
export function ListLayout({
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
  reorderable,
  onReorderRow,
  titleLabel,
  groups,
  groupedBy,
}: LayoutProps & RowRenaming & {
  onAddInline(values?: Record<string, string>): void;
  titleLabel: string;
  /** The row groups and the property they group by — none, one open group. */
  groups: readonly ViewGroup[];
  groupedBy: DatabaseProperty | undefined;
}) {
  // As the table's groups fold, a list's do — for the moment only.
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const fold = (key: string) => setFolded((held) => {
    const next = new Set(held);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  /* The table's own drag, row for row: the dragged row and the gap it
     hovers over live in refs, the drop line is a class the hovered row is
     marked with — nothing here is memoised, but rows still skip a render
     for every hovered line this way. */
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
  const seedOf = (group: ViewGroup | undefined): { propertyId: string; value: string } | undefined =>
    groupedBy && group ? { propertyId: groupedBy.id, value: group.seed ?? "" } : undefined;
  const markRowSpot = (el: HTMLElement, row: NotePage, group: ViewGroup | undefined, event: ReactDragEvent<HTMLElement>) => {
    const place: "before" | "after" = event.clientY < el.getBoundingClientRect().top + el.offsetHeight / 2 ? "before" : "after";
    if (rowSpot.current?.rowId === row.id && rowSpot.current.place === place) return;
    clearRowSpot();
    el.classList.add(place === "before" ? "is-rdrop-before" : "is-rdrop-after");
    rowSpot.current = { el, rowId: row.id, place, seed: seedOf(group) };
  };
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
  const rowOut = () => { if (rowDrag.current) clearRowSpot(); };
  const rowDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (!rowDrag.current) return;
    event.preventDefault();
    const spot = rowSpot.current;
    onReorderRow(rowDrag.current, spot?.rowId ?? null, spot?.place ?? "after", spot?.seed);
    clearRowSpot();
    rowDrag.current = null;
  };
  const stepRow = (row: NotePage, group: ViewGroup | undefined, step: -1 | 1) => {
    const sequence = groupedBy && group ? group.rows : rows;
    const at = sequence.findIndex((item) => item.id === row.id);
    const neighbour = sequence[at + step];
    if (at < 0 || !neighbour) return;
    onReorderRow(row.id, neighbour.id, step < 0 ? "before" : "after", seedOf(group));
  };

  const listRow = (row: NotePage, group: ViewGroup | undefined) => (
    <div
      key={row.id}
      className={`db-list__row ${peekId === row.id ? "is-peeked" : ""}`}
      data-page-id={row.id}
      onDragOver={reorderable ? rowOver(row, group) : undefined}
      onDragLeave={reorderable ? rowOut : undefined}
      onDrop={reorderable ? rowDrop : undefined}
    >
      {reorderable && row.id !== renamingId ? (
        <RowGrip
          row={row}
          ghost=".db-list__row"
          onDragStart={() => { rowDrag.current = row.id; }}
          onDragEnd={() => { rowDrag.current = null; clearRowSpot(); }}
          onMove={(step) => stepRow(row, group, step)}
        />
      ) : null}
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
  );
  const groupLabel = (group: ViewGroup) => group.key === ""
    ? <span className="grp-h__none">No {groupedBy ? propertyName(groupedBy) : "value"}</span>
    : !groupedBy ? group.value
    : groupedBy.type === "select" || groupedBy.type === "status" || groupedBy.type === "multi_select"
      ? <OptionTag property={groupedBy} value={group.value} />
      : groupedBy.type === "checkbox"
        ? (group.value === "true" ? "Checked" : "Unchecked")
        : groupedBy.type === "person"
          ? <><Avatar name={group.value} size={16} />{group.value}</>
          : groupedBy.type === "date" ? formatDay(group.value) : group.value;
  const groupHead = (group: ViewGroup) => {
    const closed = folded.has(group.key);
    return (
      <div
        className="db-list__group grp-h"
        onDragOver={reorderable && groupedBy ? headOver(group) : undefined}
        onDragLeave={reorderable && groupedBy ? rowOut : undefined}
        onDrop={reorderable && groupedBy ? rowDrop : undefined}
      >
        <button
          type="button"
          className="grp-h__toggle"
          aria-expanded={!closed}
          aria-label={`${closed ? "Expand" : "Collapse"} group ${group.value || "No value"}`}
          onClick={() => fold(group.key)}
        >
          <ChevronRight className={`grp-h__chev ${closed ? "is-closed" : ""}`} size={14} />
          <span className="grp-h__label">{groupLabel(group)}</span>
          <span className="grp-h__count">{group.rows.length}</span>
        </button>
        {readOnly || group.seed === null || !groupedBy ? null : (
          <button type="button" className="grp-h__add" aria-label={`New row in ${group.value}`} onClick={() => onAddInline({ [groupedBy.id]: group.seed ?? "" })}>
            <Plus size={13} />New
          </button>
        )}
      </div>
    );
  };
  return (
    <div className="db-list">
      {groupedBy ? groups.map((group) => (
        <Fragment key={`${groupedBy.id}~${group.key}`}>
          {groupHead(group)}
          {folded.has(group.key) ? null : group.rows.map((row) => listRow(row, group))}
        </Fragment>
      )) : rows.map((row) => listRow(row, groups[0]))}
      <button type="button" className="db__add-row" onClick={() => onAddInline()}>
        <Plus size={15} />New
      </button>
    </div>
  );
}
