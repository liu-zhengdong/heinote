import { Eye, EyeOff, RotateCcw } from "lucide-react";
import { useState } from "react";
import { MenuItem, MenuList } from "../../components/Menu";
import type { DatabaseProperty } from "../../core/types";
import { isMetaType, propertyName } from "./database-model";
import { PropertyIcon, TitleIcon } from "./properties";

/* The columns a view draws, as Notion's Columns tool: every property a row
   — the system's last, under their own head — with the eye that takes it
   out of the view and back. The name column is the view's spine: it stays,
   tagged so. Search narrows the list; Reset shows them all. */

export function ColumnsPanel({
  hidden,
  titleLabel,
  titleIcon,
  properties,
  onChange,
}: {
  /** The property ids the view does not draw. */
  hidden: readonly string[];
  titleLabel: string;
  titleIcon: string | undefined;
  properties: readonly DatabaseProperty[];
  onChange(hidden: string[]): void;
}) {
  const [query, setQuery] = useState("");
  const hiding = new Set(hidden);
  const typed = query.trim().toLocaleLowerCase();
  const named = (property: DatabaseProperty) => propertyName(property).toLocaleLowerCase();
  const shown = typed ? properties.filter((property) => named(property).includes(typed)) : properties;
  const own = shown.filter((property) => !isMetaType(property.type));
  const system = shown.filter((property) => isMetaType(property.type));

  const row = (property: DatabaseProperty) => {
    const off = hiding.has(property.id);
    return (
      <div key={property.id} className={`cols-panel__row ${off ? "is-hidden" : ""}`}>
        <span className="cols-panel__mark" aria-hidden="true"><PropertyIcon property={property} /></span>
        <span className="cols-panel__name">{propertyName(property)}</span>
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
      <div className="cols-panel__rows">
        {/* The name column is not the view's to hide: a database without a
            name is a table without a spine. */}
        <div className="cols-panel__row is-locked">
          <span className="cols-panel__mark" aria-hidden="true"><TitleIcon icon={titleIcon} /></span>
          <span className="cols-panel__name">{titleLabel}</span>
          <span className="cols-panel__tag">Title</span>
        </div>
        {own.map(row)}
        {system.length ? (
          <>
            <div className="cols-panel__section">System</div>
            {system.map(row)}
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
