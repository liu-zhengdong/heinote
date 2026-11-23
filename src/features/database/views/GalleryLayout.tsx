import { EyeOff, FileText, PanelTop, Plus } from "lucide-react";
import { useRef, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import { MenuItem } from "../../../components/Menu";
import type { DatabaseProperty, DatabaseView as View, NotePage } from "../../../core/types";
import {
  cardPreview,
  cardProperties,
  propertyName,
  toggleCardProperty,
  type CardPreview,
} from "../database-model";
import { PropertyIcon } from "../properties";
import {
  CardRename,
  CardTitle,
  CardTop,
  RowChips,
  RowGrip,
  type CardEditing,
  type LayoutProps,
} from "./shared";

export function GalleryLayout({
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
  reorderable,
  onReorderRow,
}: LayoutProps & CardEditing & { preview: CardPreview }) {
  /* The flat list's drag, card for card: the spot is a vertical edge marked
     on the card it would land beside. */
  const cardDrag = useRef<string | null>(null);
  const cardSpot = useRef<{ el: HTMLElement; rowId: string; place: "before" | "after" } | null>(null);
  const clearCardSpot = () => {
    cardSpot.current?.el.classList.remove("is-rdrop-before", "is-rdrop-after");
    cardSpot.current = null;
  };
  const cardOver = (row: NotePage) => (event: ReactDragEvent<HTMLElement>) => {
    if (!cardDrag.current || cardDrag.current === row.id) return;
    event.preventDefault();
    const el = event.currentTarget;
    const place: "before" | "after" = event.clientX < el.getBoundingClientRect().left + el.offsetWidth / 2 ? "before" : "after";
    if (cardSpot.current?.rowId === row.id && cardSpot.current.place === place) return;
    clearCardSpot();
    el.classList.add(place === "before" ? "is-rdrop-before" : "is-rdrop-after");
    cardSpot.current = { el, rowId: row.id, place };
  };
  const cardOut = () => { if (cardDrag.current) clearCardSpot(); };
  const cardDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (!cardDrag.current) return;
    event.preventDefault();
    const spot = cardSpot.current;
    onReorderRow(cardDrag.current, spot?.rowId ?? null, spot?.place ?? "after");
    clearCardSpot();
    cardDrag.current = null;
  };
  const stepRow = (row: NotePage, step: -1 | 1) => {
    const at = rows.findIndex((item) => item.id === row.id);
    const neighbour = rows[at + step];
    if (at < 0 || !neighbour) return;
    onReorderRow(row.id, neighbour.id, step < 0 ? "before" : "after");
  };

  return (
    <div className={`db-gallery ${preview.kind === "none" ? "db-gallery--bare" : ""}`}>
      {rows.map((row) => {
        const renaming = row.id === renamingId;
        return (
          <div
            key={row.id}
            className={`db-card ${peekId === row.id ? "is-peeked" : ""} ${renaming ? "is-renaming" : ""}`}
            data-page-id={row.id}
            onDragOver={reorderable ? cardOver(row) : undefined}
            onDragLeave={reorderable ? cardOut : undefined}
            onDrop={reorderable ? cardDrop : undefined}
          >
            {reorderable && !renaming ? (
              <RowGrip
                row={row}
                ghost=".db-card"
                onDragStart={() => { cardDrag.current = row.id; }}
                onDragEnd={() => { cardDrag.current = null; clearCardSpot(); }}
                onMove={(step) => stepRow(row, step)}
              />
            ) : null}
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

/** A gallery view's own settings, in its view menu (Notion's "Card preview"
 *  and "Properties"): what each card shows on top, and which properties it
 *  lists. Choosing leaves the menu open, so the cards can be seen change. */
export function GallerySettings({
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
