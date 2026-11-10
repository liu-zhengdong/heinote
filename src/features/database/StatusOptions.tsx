import { ChevronLeft, ChevronRight, GripVertical, Plus, Star, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type MutableRefObject } from "react";
import { MenuDivider, MenuItem, MenuList } from "../../components/Menu";
import { Popover } from "../../components/Popover";
import { imeComposing } from "../../core/keyboard";
import type { AnchorRect } from "../../hooks/useAnchoredPosition";
import type { DatabaseProperty, OptionColor, StatusGroup, StatusOption } from "../../core/types";
import { defaultStatus, OPTION_COLORS, STATUS_GROUPS, statusNameTaken, statusOptions } from "./database-model";
import { OptionTag } from "./properties";
import { capitalized } from "../../core/title";

/** What editing a status's options does to the database: each is one step
 *  of undo, rows included. `add` and `rename` answer false when the name is
 *  refused (blank, or another option's). */
export interface StatusEditing {
  add(group: StatusGroup, name: string): boolean;
  rename(optionId: string, name: string): boolean;
  recolor(optionId: string, color: OptionColor): void;
  move(optionId: string, group: StatusGroup, index: number): void;
  makeDefault(optionId: string): void;
  remove(optionId: string): void;
}

const DRAG_TYPE = "text/x-notes-status";

/** Where a dragged option would land: before the `index`th option of
 *  `group` as drawn (the dragged one still counted), or after its last. */
interface DropSpot {
  group: StatusGroup;
  index: number;
}

/** A status's options — Notion's "Edit property" for a Status: To-do, In
 *  progress and Complete, each with "+" to add an option at its end; every
 *  option its pill, "Default" on the one an unset row reads as, and a
 *  chevron into its own settings (name, default, delete, colour). Options
 *  are dragged by their grip, within a group or into another.
 *
 *  An option's settings take the panel's place, with a way back, rather
 *  than opening a third menu beside the second: a window is 640px wide at
 *  its default size, and a third menu there could only land on top of the
 *  column's own. */
export function StatusOptionsMenu({
  anchor,
  group: popGroup,
  property,
  editing,
  onClose,
}: {
  anchor: AnchorRect;
  /** The popover group of the column menu it opens from. */
  group: string;
  property: DatabaseProperty;
  editing: StatusEditing;
  onClose(): void;
}) {
  const options = statusOptions(property);
  const fallback = defaultStatus(property);
  const [adding, setAdding] = useState<StatusGroup | null>(null);
  const [draft, setDraft] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  // The open option's unsaved name, kept when the menu goes: a press
  // outside or Escape takes the panel away before its field could hear it
  // lose the caret.
  const flush = useRef<(() => void) | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [spot, setSpot] = useState<DropSpot | null>(null);
  const opened = openId ? options.find((option) => option.id === openId) : undefined;
  const draftTaken = Boolean(draft.trim()) && statusNameTaken(property, draft);

  const addDraft = (group: StatusGroup) => {
    if (!draft.trim()) {
      setAdding(null);
      return;
    }
    // Added, the field stays for the next one; refused, it keeps the name.
    if (editing.add(group, draft)) setDraft("");
  };

  /* Dragging: the spot is worked out from the option under the pointer —
     its upper half before it, its lower half after it — or, over a group's
     head or its empty space, the group's start or end. */
  const overOption = (event: DragEvent<HTMLElement>, group: StatusGroup, index: number) => {
    if (!dragId) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    const box = event.currentTarget.getBoundingClientRect();
    const next = { group, index: event.clientY < box.top + box.height / 2 ? index : index + 1 };
    setSpot((current) => (current?.group === next.group && current.index === next.index ? current : next));
  };
  const overGroup = (event: DragEvent<HTMLElement>, group: StatusGroup, index: number) => {
    if (!dragId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setSpot((current) => (current?.group === group && current.index === index ? current : { group, index }));
  };
  const drop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const moving = options.find((option) => option.id === dragId);
    if (moving && spot) {
      // The spot counts the dragged option where it is drawn; the move counts
      // the group without it.
      const from = options.filter((option) => option.group === spot.group).findIndex((option) => option.id === moving.id);
      const index = from >= 0 && from < spot.index ? spot.index - 1 : spot.index;
      if (moving.group !== spot.group || index !== from) editing.move(moving.id, spot.group, index);
    }
    setDragId(null);
    setSpot(null);
  };

  return (
    <Popover
      open
      anchor={anchor}
      placement="right-start"
      label="Edit property"
      group={popGroup}
      onDismiss={() => {
        flush.current?.();
        onClose();
      }}
    >
      {opened ? (
        <OptionSettings
          key={opened.id}
          flush={flush}
          property={property}
          option={opened}
          isDefault={opened.id === fallback.id}
          only={options.length <= 1}
          editing={editing}
          onBack={() => setOpenId(null)}
        />
      ) : (
        <div className="status-menu" onDragEnd={() => { setDragId(null); setSpot(null); }}>
          {STATUS_GROUPS.map(({ group, label }) => {
            const inGroup = options.filter((option) => option.group === group);
            return (
              <section
                key={group}
                className="status-menu__group"
                aria-label={label}
                data-group={group}
                onDragOver={(event) => overGroup(event, group, inGroup.length)}
                onDrop={drop}
              >
                <div className="status-menu__head" onDragOver={(event) => { event.stopPropagation(); overGroup(event, group, 0); }}>
                  <span className={`status-menu__title ${spot?.group === group && spot.index === 0 && !inGroup.length ? "is-drop-after" : ""}`}>
                    {label}
                  </span>
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    aria-label={`Add an option to ${label}`}
                    title="Add an option"
                    onClick={() => {
                      setAdding(group);
                      setDraft("");
                    }}
                  >
                    <Plus size={15} />
                  </button>
                </div>
                {inGroup.map((option, index) => {
                  const before = spot?.group === group && spot.index === index;
                  const after = spot?.group === group && index === inGroup.length - 1 && spot.index === inGroup.length;
                  return (
                    <div
                      key={option.id}
                      className={`status-menu__option ${dragId === option.id ? "is-dragging" : ""} ${before ? "is-drop-before" : ""} ${after ? "is-drop-after" : ""}`}
                      data-option-id={option.id}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData(DRAG_TYPE, option.id);
                        setDragId(option.id);
                      }}
                      onDragOver={(event) => overOption(event, group, index)}
                    >
                      <span className="status-menu__grip" aria-hidden="true"><GripVertical size={14} /></span>
                      <button
                        type="button"
                        className="status-menu__open"
                        aria-label={`${option.name}${option.id === fallback.id ? ", default" : ""}`}
                        onClick={() => setOpenId(option.id)}
                      >
                        <OptionTag property={property} value={option.name} />
                        {option.id === fallback.id ? <span className="status-menu__default">Default</span> : null}
                        <ChevronRight size={14} className="status-menu__chevron" />
                      </button>
                    </div>
                  );
                })}
                {adding === group ? (
                  <div className="status-menu__new">
                    <input
                      autoFocus
                      value={draft}
                      placeholder="Name the option…"
                      aria-label={`New option in ${label}`}
                      aria-invalid={draftTaken || undefined}
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={() => { if (!draft.trim()) setAdding(null); }}
                      onKeyDown={(event) => {
                        if (imeComposing(event) || event.key !== "Enter") return;
                        event.preventDefault();
                        addDraft(group);
                      }}
                    />
                    {draftTaken ? <span className="status-menu__hint">An option has this name.</span> : null}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </Popover>
  );
}

/** One option's settings, in the panel's place: back to the options, its
 *  name typed in place (kept on the way back, on Enter, or when the menu
 *  goes; refused when blank or another option's), Set as default, Delete
 *  (not the last one), and its colour. */
function OptionSettings({
  flush,
  property,
  option,
  isDefault,
  only,
  editing,
  onBack,
}: {
  /** Where the panel leaves a way to keep its name when the menu goes. */
  flush: MutableRefObject<(() => void) | null>;
  property: DatabaseProperty;
  option: StatusOption;
  isDefault: boolean;
  only: boolean;
  editing: StatusEditing;
  onBack(): void;
}) {
  const [name, setName] = useState(option.name);
  // The name last sent, so Enter, the field losing the caret, the way back
  // and the menu going — any two of which can follow each other — rename
  // once.
  const sent = useRef(option.name);
  const taken = Boolean(name.trim()) && statusNameTaken(property, name, option.id);

  const commit = () => {
    const next = name.trim();
    if (next === sent.current) return;
    if (next && editing.rename(option.id, next)) sent.current = next;
    else setName(sent.current);
  };
  useEffect(() => {
    flush.current = commit;
    return () => { flush.current = null; };
  });

  return (
    <div className="status-menu option-menu">
      <button
        type="button"
        className="option-menu__back"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          commit();
          onBack();
        }}
      >
        <ChevronLeft size={16} />
        <span>Options</span>
      </button>
      <input
        className="option-menu__name"
        autoFocus
        value={name}
        aria-label="Option name"
        aria-invalid={taken || undefined}
        spellCheck={false}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setName(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (imeComposing(event) || event.key !== "Enter") return;
          event.preventDefault();
          commit();
          onBack();
        }}
      />
      {taken ? <div className="option-menu__hint">An option has this name.</div> : null}
      <MenuList label="Option">
        {isDefault ? null : (
          <MenuItem icon={<Star size={16} />} label="Set as default" onSelect={() => editing.makeDefault(option.id)} />
        )}
        <MenuItem
          icon={<Trash2 size={16} />}
          label="Delete"
          tone="danger"
          disabled={only}
          onSelect={() => {
            sent.current = name.trim();
            editing.remove(option.id);
            onBack();
          }}
        />
        <MenuDivider />
        <div className="menu__section-title">Colors</div>
        {OPTION_COLORS.map((color) => (
          <MenuItem
            key={color}
            icon={<span className="option-swatch" data-tone={color} />}
            label={capitalized(color)}
            selected={option.color === color}
            onSelect={() => editing.recolor(option.id, color)}
          />
        ))}
      </MenuList>
    </div>
  );
}
