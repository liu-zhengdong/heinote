import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, RotateCcw } from "lucide-react";
import { useState, type DragEvent } from "react";
import { MenuItem, MenuList } from "../../components/Menu";
import type { DatabaseProperty } from "../../core/types";
import { isMetaType, propertyName } from "./database-model";
import { PropertyIcon, TitleIcon } from "./properties";

/* The columns a view draws, as Notion's Columns tool: every property a row
   — the system's last, under their own head — with the eye that takes it
   out of the view and back. The name column is the view's spine: it stays,
   tagged so. Each group also orders its own rows: a grip drags a row to a
   new place among its own kind (ordinary or system), the arrows step it.
   Search narrows the list; Reset shows them all. While the list is
   filtered the grip and the arrows rest — a row's place there is not the
   order it would write. */

/** The id a dragged column carries on its drag, apart from the sort
 *  panel's — one never drops into the other. */
const COLUMN_DRAG = "text/x-notes-column";

export function ColumnsPanel({
  hidden,
  titleLabel,
  titleIcon,
  properties,
  readOnly,
  onChange,
  onReorder,
}: {
  /** The property ids the view does not draw. */
  hidden: readonly string[];
  titleLabel: string;
  titleIcon: string | undefined;
  properties: readonly DatabaseProperty[];
  readOnly: boolean;
  onChange(hidden: string[]): void;
  /** A column moved to `index` among its own kind's (its group as drawn). */
  onReorder(propertyId: string, index: number): void;
}) {
  const [query, setQuery] = useState("");
  /** The row being dragged: its id, and which group it belongs to. */
  const [drag, setDrag] = useState<{ id: string; meta: boolean } | null>(null);
  /** Where a drop would land: a group and the place in it (length = end). */
  const [spot, setSpot] = useState<{ meta: boolean; index: number } | null>(null);
  const hiding = new Set(hidden);
  const typed = query.trim().toLocaleLowerCase();
  const named = (property: DatabaseProperty) => propertyName(property).toLocaleLowerCase();
  const shown = typed ? properties.filter((property) => named(property).includes(typed)) : properties;
  const own = shown.filter((property) => !isMetaType(property.type));
  const system = shown.filter((property) => isMetaType(property.type));
  const reorderable = !readOnly && !typed && Boolean(onReorder);

  /** A keyboard step: `index` is where the row lands among its own kind
   *  once it is out of the list — the index `moveProperty` counts on. */
  const move = (list: readonly DatabaseProperty[], from: number, to: number) => {
    if (from < 0 || to < 0 || to > list.length - 1) return;
    onReorder(list[from].id, to);
  };

  const over = (event: DragEvent<HTMLElement>, meta: boolean, index: number) => {
    if (!drag || drag.meta !== meta) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const box = event.currentTarget.getBoundingClientRect();
    const next = event.clientY < box.top + box.height / 2 ? index : index + 1;
    setSpot((current) => (current?.meta === meta && current.index === next ? current : { meta, index: next }));
  };

  const drop = (event: DragEvent<HTMLElement>, meta: boolean) => {
    if (!drag || drag.meta !== meta) return;
    event.preventDefault();
    const list = meta ? system : own;
    const from = list.findIndex((property) => property.id === drag.id);
    if (from < 0) { setDrag(null); setSpot(null); return; }
    if (spot && spot.meta === meta) {
      const to = spot.index > from ? spot.index - 1 : spot.index;
      if (to !== from) onReorder(drag.id, to);
    }
    setDrag(null);
    setSpot(null);
  };

  const row = (property: DatabaseProperty, index: number, list: readonly DatabaseProperty[], meta: boolean) => {
    const off = hiding.has(property.id);
    const before = spot?.meta === meta && spot.index === index;
    const after = spot?.meta === meta && spot.index === list.length && index === list.length - 1;
    return (
      <div
        key={property.id}
        className={`cols-panel__row ${off ? "is-hidden" : ""} ${drag?.id === property.id ? "is-dragging" : ""} ${before ? "is-drop-before" : ""} ${after ? "is-drop-after" : ""}`}
        data-column={property.id}
        onDragOver={(event) => over(event, meta, index)}
      >
        {reorderable ? (
          <span
            className="cols-panel__grip"
            aria-hidden="true"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(COLUMN_DRAG, property.id);
              setDrag({ id: property.id, meta });
            }}
            onDragEnd={() => { setDrag(null); setSpot(null); }}
          >
            <GripVertical size={14} />
          </span>
        ) : null}
        <span className="cols-panel__mark" aria-hidden="true"><PropertyIcon property={property} /></span>
        <span className="cols-panel__name">{propertyName(property)}</span>
        {meta ? <span className="cols-panel__tag">Auto</span> : null}
        {reorderable ? (
          <>
            <button
              type="button"
              className="icon-btn icon-btn--sm cols-panel__step"
              aria-label={`Move ${propertyName(property)} up`}
              disabled={index === 0}
              onClick={() => move(list, index, index - 1)}
            >
              <ArrowUp size={13} />
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--sm cols-panel__step"
              aria-label={`Move ${propertyName(property)} down`}
              disabled={index === list.length - 1}
              onClick={() => move(list, index, index + 1)}
            >
              <ArrowDown size={13} />
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="icon-btn icon-btn--sm cols-panel__eye"
          aria-label={`${off ? "Show" : "Hide"} ${propertyName(property)}`}
          aria-pressed={off}
          onClick={() => onChange(off ? hidden.filter((id) => id !== property.id) : [...hidden, property.id])}
        >
          {off ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    );
  };

  return (
    <div className="cols-panel">
      <input
        className="cols-panel__search"
        value={query}
        autoFocus
        placeholder="Search columns…"
        aria-label="Search columns"
        spellCheck={false}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="cols-panel__rows" onDragEnd={() => { setDrag(null); setSpot(null); }}>
        {/* The name column is not the view's to hide or to move: a database
            without a name is a table without a spine. */}
        <div className="cols-panel__row is-locked">
          <span className="cols-panel__mark" aria-hidden="true"><TitleIcon icon={titleIcon} /></span>
          <span className="cols-panel__name">{titleLabel}</span>
          <span className="cols-panel__tag">Title</span>
        </div>
        <div
          className="cols-panel__group"
          onDragOver={(event) => { if (drag && !drag.meta) event.preventDefault(); }}
          onDrop={(event) => drop(event, false)}
        >
          {own.map((property, index) => row(property, index, own, false))}
        </div>
        {system.length ? (
          <>
            <div className="cols-panel__section">System</div>
            <div
              className="cols-panel__group"
              onDragOver={(event) => { if (drag?.meta) event.preventDefault(); }}
              onDrop={(event) => drop(event, true)}
            >
              {system.map((property, index) => row(property, index, system, true))}
            </div>
          </>
        ) : null}
        {typed && !shown.length ? <div className="cols-panel__none">No matching columns</div> : null}
      </div>
      <MenuList label="Columns">
        <MenuItem
          icon={<RotateCcw size={16} />}
          label="Show all columns"
          disabled={!hidden.length}
          onSelect={() => onChange([])}
        />
      </MenuList>
    </div>
  );
}
