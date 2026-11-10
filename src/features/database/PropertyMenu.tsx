import { ArrowDown, ArrowLeftToLine, ArrowRightToLine, ArrowUp, ChevronRight, Copy, Repeat, SlidersHorizontal, TextWrap, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MenuDivider, MenuItem, MenuList } from "../../components/Menu";
import { Popover } from "../../components/Popover";
import { imeComposing } from "../../core/keyboard";
import { rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import type { DatabaseProperty, PropertyType } from "../../core/types";
import { PROPERTY_LABELS, PROPERTY_TYPES, sortable, TITLE_COLUMN } from "./database-model";
import { PropertyIcon, TitleIcon, TypeIcon } from "./properties";
import { PropertyIconPicker } from "./PropertyIconPicker";
import { StatusOptionsMenu, type StatusEditing } from "./StatusOptions";

const GROUP = "property-menu";

/** A column's menu, opened from its header — Notion's "Edit property": the
 *  column's mark (pressed, the icon picker) and its name typed straight into
 *  its top (the text is selected, so a new name is simply typed over the old
 *  one); a Status's options one step to the side ("Edit property"), its type
 *  another, then what the column can do in this view — a sort, and for words
 *  whether they wrap — and in the database.
 *
 *  `property` is null for the row-name column: it can be named, given a
 *  mark and sorted and have a column put to its right, but its type is the
 *  rows' names — it cannot change, be copied, or go. */
export function PropertyMenu({
  anchor,
  databaseId,
  property,
  name,
  placeholder,
  icon,
  sort,
  wrap,
  statusEditing,
  onRename,
  onIcon,
  onChangeType,
  onSort,
  onWrap,
  onInsert,
  onDuplicate,
  onDelete,
  onClose,
}: {
  anchor: AnchorRect;
  databaseId: string;
  property: DatabaseProperty | null;
  /** The name as stored — blank while someone has typed it away. */
  name: string;
  /** What the column reads as while its name is blank. */
  placeholder: string;
  /** The mark the column was given, if it was given one. */
  icon: string | undefined;
  /** How this view is sorted by this column, if it is. */
  sort: "asc" | "desc" | undefined;
  /** Whether the column's words wrap in this view — the row-name column's
   *  and a Text column's; absent for a column with no words to wrap. */
  wrap?: boolean;
  /** A Status's options, edited; absent for every other column. */
  statusEditing?: StatusEditing;
  onRename(name: string): void;
  /** A mark for the column, or null for its type's own. */
  onIcon(icon: string | null): void;
  onChangeType(type: PropertyType): void;
  /** A direction to sort by, or null to stop sorting by this column. */
  onSort(direction: "asc" | "desc" | null): void;
  /** The column's words to wrap onto more lines, or to keep to one. */
  onWrap(wraps: boolean): void;
  onInsert(side: "left" | "right"): void;
  onDuplicate(): void;
  onDelete(): void;
  onClose(): void;
}) {
  const nameRef = useRef<HTMLInputElement | null>(null);
  const glyphRef = useRef<HTMLButtonElement | null>(null);
  const typeRef = useRef<HTMLButtonElement | null>(null);
  const statusRef = useRef<HTMLButtonElement | null>(null);
  // One thing opens beside the menu at a time: the mark's picker, the
  // status's options, or the types.
  const [side, setSide] = useState<"icon" | "status" | "type" | null>(null);
  const column = property?.id ?? TITLE_COLUMN;
  const typeOpen = side === "type";

  useEffect(() => {
    const field = nameRef.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    field.select();
  }, [column]);

  const sortBy = (direction: "asc" | "desc") => {
    onSort(sort === direction ? null : direction);
    onClose();
  };

  return (
    <>
      <Popover open anchor={anchor} placement="bottom-start" label="Edit property" group={GROUP} onDismiss={onClose}>
        <div className="prop-menu">
          <div className="prop-menu__head">
            <button
              type="button"
              ref={glyphRef}
              className={`prop-menu__glyph ${side === "icon" ? "is-open" : ""}`}
              aria-label="Change icon"
              aria-haspopup="dialog"
              aria-expanded={side === "icon"}
              title="Change icon"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setSide((open) => (open === "icon" ? null : "icon"))}
            >
              {property ? <PropertyIcon property={property} size={16} /> : <TitleIcon icon={icon} size={16} />}
            </button>
            <input
              ref={nameRef}
              className="prop-menu__name"
              value={name}
              placeholder={placeholder}
              aria-label="Property name"
              data-history-field={`property-name:${column}`}
              data-page-id={databaseId}
              spellCheck={false}
              onChange={(event) => onRename(event.target.value)}
              onKeyDown={(event) => {
                if (imeComposing(event)) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  onClose();
                } else if (event.key === "ArrowDown") {
                  // Down from the name walks into the menu, as it would from
                  // any menu's first item.
                  event.preventDefault();
                  event.currentTarget.closest(".prop-menu")?.querySelector<HTMLElement>(".menu")?.focus();
                }
              }}
            />
          </div>
          <MenuList label="Property">
            {property?.type === "status" && statusEditing ? (
              <button
                type="button"
                ref={statusRef}
                data-menu-item
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={side === "status"}
                className={`menu__item ${side === "status" ? "is-active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setSide((open) => (open === "status" ? null : "status"))}
              >
                <span className="menu__icon"><SlidersHorizontal size={16} /></span>
                <span className="menu__copy"><span className="menu__label">Edit property</span></span>
                <span className="menu__hint"><ChevronRight size={14} /></span>
              </button>
            ) : null}
            {property ? (
              <>
                <button
                  type="button"
                  ref={typeRef}
                  data-menu-item
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={typeOpen}
                  className={`menu__item ${typeOpen ? "is-active" : ""}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setSide((open) => (open === "type" ? null : "type"))}
                >
                  <span className="menu__icon"><Repeat size={16} /></span>
                  <span className="menu__copy"><span className="menu__label">Change type</span></span>
                  <span className="menu__hint prop-menu__type">
                    {PROPERTY_LABELS[property.type]}
                    <ChevronRight size={14} />
                  </span>
                </button>
                <MenuDivider />
              </>
            ) : null}
            {/* Pictures have no order to sort by. */}
            {!property || sortable(property) ? (
              <>
                <MenuItem icon={<ArrowUp size={16} />} label="Sort ascending" selected={sort === "asc"} onSelect={() => sortBy("asc")} />
                <MenuItem icon={<ArrowDown size={16} />} label="Sort descending" selected={sort === "desc"} onSelect={() => sortBy("desc")} />
                {/* Notion's "Wrap text": on until it is turned off. The menu
                    stays open, so the column can be seen change. */}
                {wrap === undefined ? null : (
                  <MenuItem icon={<TextWrap size={16} />} label="Wrap text" selected={wrap} onSelect={() => onWrap(!wrap)} />
                )}
                <MenuDivider />
              </>
            ) : null}
            {property ? (
              <MenuItem icon={<ArrowLeftToLine size={16} />} label="Insert left" onSelect={() => onInsert("left")} />
            ) : null}
            <MenuItem icon={<ArrowRightToLine size={16} />} label="Insert right" onSelect={() => onInsert("right")} />
            {property ? (
              <>
                <MenuItem icon={<Copy size={16} />} label="Duplicate property" onSelect={() => { onClose(); onDuplicate(); }} />
                <MenuItem icon={<Trash2 size={16} />} label="Delete property" tone="danger" onSelect={() => { onClose(); onDelete(); }} />
              </>
            ) : null}
          </MenuList>
        </div>
      </Popover>

      {side === "icon" && glyphRef.current ? (
        <PropertyIconPicker
          anchor={rectOf(glyphRef.current)}
          current={icon}
          group={GROUP}
          onPick={(picked) => {
            onIcon(picked);
            setSide(null);
            nameRef.current?.focus({ preventScroll: true });
          }}
          onRemove={() => {
            onIcon(null);
            setSide(null);
            nameRef.current?.focus({ preventScroll: true });
          }}
          onClose={() => setSide(null)}
        />
      ) : null}

      {side === "status" && property?.type === "status" && statusEditing && statusRef.current ? (
        <StatusOptionsMenu
          anchor={rectOf(statusRef.current)}
          group={GROUP}
          property={property}
          editing={statusEditing}
          onClose={() => setSide(null)}
        />
      ) : null}

      {property ? (
        <Popover
          open={typeOpen}
          anchor={typeOpen && typeRef.current ? rectOf(typeRef.current) : null}
          placement="right-start"
          label="Change type"
          group={GROUP}
          onDismiss={() => setSide(null)}
        >
          <MenuList label="Change type" autoFocus>
            <div className="menu__section-title">Type</div>
            {PROPERTY_TYPES.map((type) => (
              <MenuItem
                key={type}
                icon={<TypeIcon type={type} />}
                label={PROPERTY_LABELS[type]}
                selected={property.type === type}
                onSelect={() => {
                  setSide(null);
                  onChangeType(type);
                  // The menu stays open on the column, now of its new type;
                  // the caret goes back to its name, where it started.
                  nameRef.current?.focus({ preventScroll: true });
                }}
              />
            ))}
          </MenuList>
        </Popover>
      ) : null}
    </>
  );
}
