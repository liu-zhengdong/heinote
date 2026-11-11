import { ArrowDown, ArrowLeftRight, ArrowLeftToLine, ArrowRightToLine, ArrowUp, ChevronRight, Copy, Repeat, SlidersHorizontal, TextWrap, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MenuDivider, MenuItem, MenuList } from "../../components/Menu";
import { Popover } from "../../components/Popover";
import { Select } from "../../components/Select";
import { imeComposing } from "../../core/keyboard";
import { rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import type { DatabaseProperty, PropertyType } from "../../core/types";
import { PROPERTY_LABELS, PROPERTY_TYPES, sortable, TITLE_COLUMN } from "./database-model";
import { PropertyIcon, TitleIcon, TypeIcon } from "./properties";
import { PropertyIconPicker } from "./PropertyIconPicker";
import { OptionsEditorMenu, StatusOptionsMenu, type SelectEditing, type StatusEditing } from "./StatusOptions";

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
/** What a relation column's menu shows and writes: the database it links
 *  to (fixed at creation, so read-only here), its limit, its mirror on the
 *  target — its switch and its name. */
export interface RelationEditing {
  /** The target database's name — the forward relation's; a mirror's is
   *  the database it points back to. */
  targetName: string;
  /** A mirror (relation_origin set): nothing of its own to edit. */
  mirror: boolean;
  limit: "unlimited" | "1";
  twoWay: boolean;
  backlinkName: string;
  onLimit(limit: "unlimited" | "1"): void;
  onTwoWay(twoWay: boolean): void;
  onBacklinkName(name: string): void;
}

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
  selectEditing,
  relation,
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
  /** A Select's or Multi-select's options, edited; absent otherwise. */
  selectEditing?: SelectEditing;
  /** A relation's fields, edited; absent for every other column. */
  relation?: RelationEditing;
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
  const optionsRef = useRef<HTMLButtonElement | null>(null);
  const relationRef = useRef<HTMLButtonElement | null>(null);
  // One thing opens beside the menu at a time: the mark's picker, the
  // optioned types' options, or the types.
  const [side, setSide] = useState<"icon" | "status" | "options" | "type" | "relation" | null>(null);
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
            {(property?.type === "select" || property?.type === "multi_select") && selectEditing ? (
              <button
                type="button"
                ref={optionsRef}
                data-menu-item
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={side === "options"}
                className={`menu__item ${side === "options" ? "is-active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setSide((open) => (open === "options" ? null : "options"))}
              >
                <span className="menu__icon"><SlidersHorizontal size={16} /></span>
                <span className="menu__copy"><span className="menu__label">Edit property</span></span>
                <span className="menu__hint"><ChevronRight size={14} /></span>
              </button>
            ) : null}
            {relation ? (
              /* A mirror's pairing lives on the forward property — it has
                 nothing of its own to edit. The forward relation's target
                 is fixed once made, so the menu shows it rather than offers
                 it. */
              relation.mirror ? (
                <div className="menu__item is-static">
                  <span className="menu__icon"><ArrowLeftRight size={16} /></span>
                  <span className="menu__copy"><span className="menu__label">From {relation.targetName}</span></span>
                </div>
              ) : (
                <button
                  type="button"
                  ref={relationRef}
                  data-menu-item
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={side === "relation"}
                  className={`menu__item ${side === "relation" ? "is-active" : ""}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setSide((open) => (open === "relation" ? null : "relation"))}
                >
                  <span className="menu__icon"><SlidersHorizontal size={16} /></span>
                  <span className="menu__copy"><span className="menu__label">Edit property</span></span>
                  <span className="menu__hint"><ChevronRight size={14} /></span>
                </button>
              )
            ) : null}
            {property && !relation?.mirror ? (
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

      {side === "options" && (property?.type === "select" || property?.type === "multi_select") && selectEditing && optionsRef.current ? (
        <OptionsEditorMenu
          anchor={rectOf(optionsRef.current)}
          group={GROUP}
          property={property}
          editing={selectEditing}
          onClose={() => setSide(null)}
        />
      ) : null}

      {side === "relation" && relation && !relation.mirror && relationRef.current ? (
        <Popover
          open
          anchor={rectOf(relationRef.current)}
          placement="right-start"
          label="Edit property"
          group={GROUP}
          onDismiss={() => setSide(null)}
        >
          <div className="rel-panel">
            <div className="rel-panel__row">
              <span className="rel-panel__label">Linked to</span>
              <span className="rel-panel__value">{relation.targetName}</span>
            </div>
            <div className="rel-panel__row">
              <span className="rel-panel__label">Limit</span>
              <Select
                size="compact"
                aria-label="Relation limit"
                value={relation.limit}
                onValueChange={(limit) => relation.onLimit(limit as "unlimited" | "1")}
                options={[
                  { value: "unlimited", label: "No limit" },
                  { value: "1", label: "1 page" },
                ]}
              />
            </div>
            <label className="rel-panel__row rel-panel__toggle">
              <input
                type="checkbox"
                checked={relation.twoWay}
                onChange={(event) => relation.onTwoWay(event.target.checked)}
              />
              <span className="rel-panel__label">Show on {relation.targetName}</span>
            </label>
            {relation.twoWay ? (
              <div className="rel-panel__row">
                <span className="rel-panel__label">Backlink name</span>
                <input
                  className="rel-panel__input"
                  defaultValue={relation.backlinkName}
                  placeholder={relation.targetName}
                  aria-label="Backlink property name"
                  spellCheck={false}
                  onBlur={(event) => relation.onBacklinkName(event.target.value)}
                  onKeyDown={(event) => {
                    if (imeComposing(event)) return;
                    if (event.key === "Enter") {
                      event.preventDefault();
                      relation.onBacklinkName(event.currentTarget.value);
                    }
                  }}
                />
              </div>
            ) : null}
          </div>
        </Popover>
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
            {/* A relation is only ever made — never changed into — so the
                list does not offer it: a type cannot pick a database. */}
            {PROPERTY_TYPES.filter((type) => type !== "relation").map((type) => (
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
