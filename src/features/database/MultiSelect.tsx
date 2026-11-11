import { useState } from "react";
import { Check, Plus, X } from "lucide-react";
import { Popover } from "../../components/Popover";
import { rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import { imeComposing } from "../../core/keyboard";
import type { DatabaseProperty } from "../../core/types";
import { multiValues, toMultiValue } from "./database-model";
import { OptionTag } from "./properties";

/* A multi-select's cell: the chosen options as its own pills, and the rest
 *  one click away in a small list — Notion's. Each pick is written at once
 *  (one step of history each), the way the Select cell writes its choice. */

export function MultiSelect({
  property,
  value,
  readOnly,
  onChange,
}: {
  property: DatabaseProperty;
  value: string;
  readOnly: boolean;
  onChange(next: string): void;
}) {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const selected = multiValues(value);
  const options = property.options ?? [];
  const typed = query.trim().toLocaleLowerCase();
  const shown = typed ? options.filter((option) => option.toLocaleLowerCase().includes(typed)) : options;
  const open = Boolean(anchor);

  const pick = (name: string) => {
    onChange(toMultiValue(selected.includes(name) ? selected.filter((option) => option !== name) : [...selected, name]));
  };
  const close = () => {
    setAnchor(null);
    setQuery("");
    setActive(0);
  };

  /* The pills, or "Empty" — the cell every read-only view of it gets. In an
   *  editable cell each carries a small remove, so a single pick can be
   *  dropped without opening the list at all. */
  const pills = selected.length ? (
    <span className="db__multi-pills">
      {selected.map((name) => (
        <span key={name} className="db__multi-pill">
          <OptionTag property={property} value={name} />
          {readOnly ? null : (
            <button
              type="button"
              className="db__multi-remove"
              aria-label={`Remove ${name}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                onChange(toMultiValue(selected.filter((option) => option !== name)));
              }}
            >
              <X size={10} />
            </button>
          )}
        </span>
      ))}
    </span>
  ) : (
    <span className="db__multi-empty">Empty</span>
  );

  if (readOnly) return <span className="db__multi">{pills}</span>;

  /* The list: what's offered, minus what the filter hides, with the picked
   *  ones marked. Enter takes the row under the highlight; Tab, as Notion's,
   *  walks it. */
  const rows = [
    ...shown.map((name) => ({ kind: "option" as const, name })),
    ...(selected.length && !typed ? [{ kind: "empty" as const, name: "" }] : []),
  ];
  const activate = (index: number) => {
    const row = rows[index];
    if (!row) return;
    if (row.kind === "empty") {
      onChange("");
      close();
      return;
    }
    pick(row.name);
  };

  return (
    <span className="db__multi">
      <div
        role="button"
        tabIndex={0}
        className="db__multi-cell"
        aria-label={property.name}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setAnchor(open ? null : rectOf(event.currentTarget));
        }}
        onKeyDown={(event) => {
          if (imeComposing(event) || open || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          setAnchor(rectOf(event.currentTarget));
        }}
      >
        {pills}
      </div>
      <input
        type="hidden"
        aria-hidden="true"
        value={value}
        data-history-field={`property:${property.id}`}
        readOnly
      />
      <Popover
        open={open}
        anchor={anchor}
        placement="bottom-start"
        label="Options"
        role="listbox"
        onDismiss={close}
      >
        <div className="db-multi-menu">
          <input
            className="db-multi-menu__search"
            autoFocus
            value={query}
            placeholder="Search…"
            aria-label="Search options"
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (imeComposing(event)) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (rows.length) setActive((index) => (index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
              } else if (event.key === "Enter") {
                event.preventDefault();
                activate(active);
              } else if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
            }}
          />
          <div className="db-multi-menu__list" role="group" aria-label="Options">
            {rows.length ? rows.map((row, index) => row.kind === "empty" ? (
              <button
                key="empty"
                type="button"
                role="option"
                aria-selected={false}
                className={`db-multi-menu__option ${index === active ? "is-active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => activate(index)}
              >
                <span className="db-multi-menu__empty">Empty</span>
              </button>
            ) : (
              <button
                key={row.name}
                type="button"
                role="option"
                aria-selected={selected.includes(row.name)}
                className={`db-multi-menu__option ${index === active ? "is-active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => activate(index)}
              >
                <OptionTag property={property} value={row.name} />
                {selected.includes(row.name) ? <Check size={14} /> : null}
              </button>
            )) : (
              <div className="db-multi-menu__none">No options</div>
            )}
          </div>
          <div className="db-multi-menu__hint">
            <span><Plus size={11} /> Options are added in the column's menu</span>
            <span><X size={11} /> A pill removes itself</span>
          </div>
        </div>
      </Popover>
    </span>
  );
}
