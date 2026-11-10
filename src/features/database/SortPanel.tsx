import { ChevronDown, GripVertical, Plus, Trash2, X } from "lucide-react";
import { useState, type DragEvent, type ReactNode } from "react";
import { MenuItem, MenuList } from "../../components/Menu";
import type { ViewSort } from "../../core/types";

/** A column a view can be sorted by: its id (`TITLE_COLUMN` for the row
 *  names), its name and its mark. */
export interface SortColumn {
  id: string;
  label: string;
  icon: ReactNode;
}

const DIRECTIONS: ReadonlyArray<{ direction: ViewSort["direction"]; label: string }> = [
  { direction: "asc", label: "Sort ascending" },
  { direction: "desc", label: "Sort descending" },
];

/** A view's sorts — Notion's sort panel: a line per key, first key first,
 *  each its column and its direction (the platform's own pickers, as a
 *  cell's are) and × to take it away, dragged by its grip to change which
 *  decides first; then Add sort (the next column not yet sorted by) and
 *  Delete sort (every key). Every change is the whole list, handed back. */
export function SortPanel({
  sorts,
  columns,
  onChange,
}: {
  sorts: readonly ViewSort[];
  columns: readonly SortColumn[];
  onChange(next: ViewSort[]): void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // Where a dragged line would land: before the line at this index (the
  // dragged one still counted), or after the last.
  const [spot, setSpot] = useState<number | null>(null);
  const used = new Set(sorts.map((sort) => sort.property_id));
  const unused = columns.filter((column) => !used.has(column.id));

  const replace = (index: number, sort: ViewSort) => onChange(sorts.map((item, at) => (at === index ? sort : item)));
  const over = (event: DragEvent<HTMLElement>, index: number) => {
    if (dragIndex === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const box = event.currentTarget.getBoundingClientRect();
    const next = event.clientY < box.top + box.height / 2 ? index : index + 1;
    setSpot((current) => (current === next ? current : next));
  };
  const drop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (dragIndex !== null && spot !== null && spot !== dragIndex && spot !== dragIndex + 1) {
      const next = [...sorts];
      const [moving] = next.splice(dragIndex, 1);
      next.splice(spot > dragIndex ? spot - 1 : spot, 0, moving);
      onChange(next);
    }
    setDragIndex(null);
    setSpot(null);
  };

  return (
    <div className="sort-panel">
      <div className="sort-panel__lines" onDragOver={(event) => { if (dragIndex !== null) event.preventDefault(); }} onDrop={drop}>
        {sorts.map((sort, index) => {
          const column = columns.find((item) => item.id === sort.property_id);
          const direction = DIRECTIONS.find((item) => item.direction === sort.direction) ?? DIRECTIONS[0];
          const before = spot === index;
          const after = spot === sorts.length && index === sorts.length - 1;
          return (
            <div
              key={sort.property_id}
              className={`sort-panel__line ${dragIndex === index ? "is-dragging" : ""} ${before ? "is-drop-before" : ""} ${after ? "is-drop-after" : ""}`}
              data-sort={sort.property_id}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/x-notes-sort", sort.property_id);
                setDragIndex(index);
              }}
              onDragEnd={() => { setDragIndex(null); setSpot(null); }}
              onDragOver={(event) => over(event, index)}
            >
              <span className="sort-panel__grip" aria-hidden="true"><GripVertical size={14} /></span>
              <label className="sort-panel__field sort-panel__field--column">
                <span className="sort-panel__mark" aria-hidden="true">{column?.icon}</span>
                <span className="sort-panel__value">{column?.label ?? ""}</span>
                <ChevronDown size={14} className="sort-panel__chevron" aria-hidden="true" />
                <select
                  aria-label={`Sort ${index + 1}: property`}
                  value={sort.property_id}
                  onChange={(event) => replace(index, { ...sort, property_id: event.target.value })}
                >
                  {columns.filter((item) => item.id === sort.property_id || !used.has(item.id)).map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </select>
              </label>
              <label className="sort-panel__field">
                <span className="sort-panel__value">{direction.label}</span>
                <ChevronDown size={14} className="sort-panel__chevron" aria-hidden="true" />
                <select
                  aria-label={`Sort ${index + 1}: direction`}
                  value={sort.direction}
                  onChange={(event) => replace(index, { ...sort, direction: event.target.value === "desc" ? "desc" : "asc" })}
                >
                  {DIRECTIONS.map((item) => <option key={item.direction} value={item.direction}>{item.label}</option>)}
                </select>
              </label>
              <button
                type="button"
                className="icon-btn icon-btn--sm sort-panel__remove"
                aria-label={`Remove sort by ${column?.label ?? ""}`}
                onClick={() => onChange(sorts.filter((_, at) => at !== index))}
              >
                <X size={15} />
              </button>
            </div>
          );
        })}
      </div>
      <MenuList label="Sorts">
        <MenuItem
          icon={<Plus size={16} />}
          label="Add sort"
          disabled={!unused.length}
          onSelect={() => { if (unused.length) onChange([...sorts, { property_id: unused[0].id, direction: "asc" }]); }}
        />
        <MenuItem icon={<Trash2 size={16} />} label="Delete sort" onSelect={() => onChange([])} />
      </MenuList>
    </div>
  );
}
