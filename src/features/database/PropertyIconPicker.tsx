import { Search, Shuffle } from "lucide-react";
import { useMemo, useState } from "react";
import { Popover } from "../../components/Popover";
import { Tooltip } from "../../components/Tooltip";
import { imeComposing } from "../../core/keyboard";
import type { AnchorRect } from "../../hooks/useAnchoredPosition";
import { findPropertyIcons, PROPERTY_ICON_KEYS, propertyIcon } from "./property-icons";

/** "arrow-up-right" → "Arrow up right", for the cell's name. */
function iconLabel(key: string): string {
  const words = key.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A column's mark, chosen — Notion's property icon picker: a filter with a
 *  shuffle and Remove (back to the type's own mark), and the marks in a
 *  grid. Picking one puts the picker away and leaves the column's menu open,
 *  its mark and the head already wearing the choice. */
export function PropertyIconPicker({
  anchor,
  current,
  group,
  onPick,
  onRemove,
  onClose,
}: {
  anchor: AnchorRect;
  /** The mark the column wears now, when it was given one. */
  current: string | undefined;
  /** The popover group of the menu it opens from. */
  group: string;
  onPick(icon: string): void;
  onRemove(): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const keys = useMemo(() => findPropertyIcons(query), [query]);

  return (
    <Popover open anchor={anchor} placement="bottom-start" role="dialog" label="Property icon" group={group} onDismiss={onClose}>
      <div className="picker picker--icons">
        <div className="picker__head">
          <label className="picker__filter">
            <Search size={14} aria-hidden="true" />
            <input
              autoFocus
              value={query}
              placeholder="Filter…"
              aria-label="Filter icons"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // Enter takes the first mark the filter found.
                if (event.key !== "Enter" || imeComposing(event) || !keys.length) return;
                event.preventDefault();
                onPick(keys[0]);
              }}
            />
          </label>
          <Tooltip label="Random">
            <button
              type="button"
              className="icon-btn picker__shuffle"
              aria-label="Random icon"
              onClick={() => onPick(PROPERTY_ICON_KEYS[Math.floor(Math.random() * PROPERTY_ICON_KEYS.length)])}
            >
              <Shuffle size={15} />
            </button>
          </Tooltip>
          {current && propertyIcon(current) ? (
            <button type="button" className="picker__remove" onClick={onRemove}>Remove</button>
          ) : null}
        </div>
        <div className="picker__body">
          <div className="picker__grid picker__grid--icons">
            {keys.map((key) => {
              const Icon = propertyIcon(key)!;
              return (
                <button
                  type="button"
                  key={key}
                  className={`picker__cell ${key === current ? "is-selected" : ""}`}
                  aria-label={iconLabel(key)}
                  aria-pressed={key === current}
                  title={iconLabel(key)}
                  data-icon={key}
                  onClick={() => onPick(key)}
                >
                  <Icon size={18} />
                </button>
              );
            })}
          </div>
          {keys.length ? null : <div className="slash__empty">No icons match “{query}”</div>}
        </div>
      </div>
    </Popover>
  );
}
