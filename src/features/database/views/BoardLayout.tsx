import { Plus } from "lucide-react";
import { useRef, useState, type DragEvent as ReactDragEvent } from "react";
import type { DatabaseProperty, NotePage } from "../../../core/types";
import {
  propertyName,
  propertyOptions,
  propertyValue,
} from "../database-model";
import { OptionTag } from "../properties";
import {
  CardRename,
  CardTitle,
  previewText,
  ROW_DRAG,
  RowChips,
  type CardEditing,
  type LayoutProps,
} from "./shared";

export function BoardLayout({
  rows,
  properties,
  property,
  onOpen,
  renamingId,
  onStartRename,
  onStopRename,
  onRename,
  onAddInline,
  readOnly,
  reorderable,
  onReorderRow,
}: LayoutProps & CardEditing & { property: DatabaseProperty }) {
  const [dragRowId, setDragRowId] = useState<string | null>(null);
  const [dropColumn, setDropColumn] = useState<string | null>(null);
  /* The card-to-card gap the drag hovers over, when the rows' own order is
     free to be changed; marked on the card itself, kept in a ref so the
     column needs no render for every hovered card. */
  const cardSpot = useRef<{ el: HTMLElement; rowId: string; place: "before" | "after" } | null>(null);
  const clearCardSpot = () => {
    cardSpot.current?.el.classList.remove("is-rdrop-before", "is-rdrop-after");
    cardSpot.current = null;
  };
  const options = propertyOptions(property);
  // A select can be unset; a status cannot (it reads as its first option). The
  // "No value" column is drawn only while something is in it — an empty extra
  // column is 260px a small window cannot spare.
  const unset = property.type === "select" ? rows.filter((row) => !propertyValue(row, property)) : [];
  const columns = unset.length ? ["", ...options] : options;

  /* A drop ends one of two ways: beside a card — its place in the order and
     the column's value — or on the column's own space — last in it, still
     taking its value. Sorts or a filter make the in-between line a lie the
     dragged card could never land on, so only the column takes the drop. */
  const dropColumnSeed = (value: string) => ({ propertyId: property.id, value });
  const onDrop = (value: string) => (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    const spot = cardSpot.current;
    setDropColumn(null);
    clearCardSpot();
    const row = rows.find((item) => item.id === dragRowId);
    setDragRowId(null);
    if (!row) return;
    if (spot) onReorderRow(row.id, spot.rowId, spot.place, dropColumnSeed(value));
    else if (reorderable) onReorderRow(row.id, null, "after", dropColumnSeed(value));
    else onReorderRow(row.id, row.id, "after", dropColumnSeed(value));
  };
  const cardOver = (row: NotePage) => (event: ReactDragEvent<HTMLElement>) => {
    if (!dragRowId || dragRowId === row.id) return;
    event.preventDefault();
    const el = event.currentTarget;
    const place: "before" | "after" = event.clientY < el.getBoundingClientRect().top + el.offsetHeight / 2 ? "before" : "after";
    if (cardSpot.current?.rowId === row.id && cardSpot.current.place === place) return;
    clearCardSpot();
    el.classList.add(place === "before" ? "is-rdrop-before" : "is-rdrop-after");
    cardSpot.current = { el, rowId: row.id, place };
  };

  return (
    <div className="board">
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
                    event.dataTransfer.setData(ROW_DRAG, row.id);
                    setDragRowId(row.id);
                  }}
                  onDragEnd={() => { setDragRowId(null); setDropColumn(null); clearCardSpot(); }}
                  onDragOver={reorderable ? cardOver(row) : undefined}
                  /* The column's drop would also see this one bubble up:
                     stop it, or the card lands beside its neighbour and is
                     then moved on to the column's end. */
                  onDrop={reorderable ? (event) => { event.stopPropagation(); onDrop(value)(event); } : undefined}
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
