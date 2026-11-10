import { ALargeSmall, Calendar, Hash, ImageIcon, ListFilter, Text as TextIcon, UserRound } from "lucide-react";
import { Avatar } from "../../components/Avatar";
import { imeComposing } from "../../core/keyboard";
import type { DatabaseProperty, NotePage } from "../../core/types";
import { propertyName, propertyOptions, STATUS_GROUPS, statusOf, statusOptions } from "./database-model";
import { ImageProperty } from "./ImageProperty";
import { useColumnIcon } from "./property-icon-store";

/* The pieces every place that shows a database value shares: the table's
   cells, the cards, and the page opened from a row. One module, so a status
   looks like itself wherever it appears. */

/** A status or select value as a pill. A status wears its option's colour
 *  and a dot; a select is grey until its options have colours of their own. */
export function OptionTag({ property, value }: { property: DatabaseProperty; value: string }) {
  const status = property.type === "status";
  return (
    <span className={`tag ${status ? "tag--status" : ""}`} data-tone={status ? statusOf(property, value).color : "default"}>
      <span className="tag__label">{value}</span>
    </span>
  );
}

/** The type's own mark: what a column wears until it is given one. */
export function TypeIcon({ type, size = 14 }: { type: DatabaseProperty["type"]; size?: number }) {
  if (type === "person") return <UserRound size={size} />;
  if (type === "date") return <Calendar size={size} />;
  if (type === "status") return <ListFilter size={size} />;
  if (type === "select") return <Hash size={size} />;
  if (type === "image") return <ImageIcon size={size} />;
  return <TextIcon size={size} />;
}

/** A column's mark: the one it was given, else its type's. */
export function PropertyIcon({ property, size = 14 }: { property: Pick<DatabaseProperty, "type" | "icon">; size?: number }) {
  const Chosen = useColumnIcon(property.icon);
  return Chosen ? <Chosen size={size} /> : <TypeIcon type={property.type} size={size} />;
}

/** The row-name column's mark — the one it was given, else Notion's "Aa",
 *  so it never reads as one more Text column. */
export function TitleIcon({ icon, size = 14 }: { icon?: string; size?: number }) {
  const Chosen = useColumnIcon(icon);
  return Chosen ? <Chosen size={size} /> : <ALargeSmall size={size} />;
}

export const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;

/** "Sep 20", or "Sep 20, 2025" outside this year. A value that is not a date
 *  is shown exactly as it was typed rather than hidden. */
export function formatDay(value: string): string {
  if (!ISO_DAY.test(value)) return value;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const sameYear = year === new Date().getFullYear();
  return new Intl.DateTimeFormat(undefined, sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" }).format(date);
}

/** A Text value, as Notion's is: its words wrap onto the lines below and the
 *  row grows to hold them — unless its column keeps to one line (`wrap`
 *  false), where they are cut off at the column's edge. A textarea cannot
 *  grow to its words in every browser (`field-sizing` is Chromium's alone),
 *  so it stands in one grid cell with an unseen copy of them (`data-value`),
 *  and the copy is what makes the cell as tall as the words. Enter puts the
 *  value down, as in Notion; Shift+Enter is a new line in it. */
function TextValue({
  property,
  value,
  onChange,
  readOnly,
  wrap,
}: {
  property: DatabaseProperty;
  value: string;
  onChange(next: string): void;
  readOnly: boolean;
  wrap: boolean;
}) {
  return (
    <span className={`db__text ${wrap ? "" : "is-one-line"}`} data-value={value}>
      <textarea
        className="db__cell db__cell--text"
        rows={1}
        value={value}
        aria-label={propertyName(property)}
        data-history-field={`property:${property.id}`}
        placeholder="Empty"
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || imeComposing(event)) return;
          event.preventDefault();
          event.currentTarget.blur();
        }}
      />
    </span>
  );
}

export function PropertyEditor({
  property,
  value,
  onChange,
  readOnly = false,
  row,
  wrap = true,
}: {
  property: DatabaseProperty;
  value: string;
  onChange(next: string): void;
  readOnly?: boolean;
  /** The row the value is on: an Image property reads and writes its
   *  pictures there, not through `value`. */
  row?: NotePage;
  /** A Text value's words wrap onto more lines (a page's properties, and a
   *  table column that wraps) or keep to one (a column set not to). */
  wrap?: boolean;
}) {
  if (property.type === "image") {
    return row ? <ImageProperty row={row} property={property} readOnly={readOnly} /> : null;
  }
  if (property.type === "status") {
    // A status always reads as one of its options — unset, its default —
    // because the board groups by it. The platform's own picker lists them
    // under their groups, as Notion's does.
    const current = statusOf(property, value).name;
    const options = statusOptions(property);
    return (
      <span className="db__cell db__cell--select">
        <OptionTag property={property} value={current} />
        <select
          aria-label={propertyName(property)}
          data-history-field={`property:${property.id}`}
          value={current}
          disabled={readOnly}
          onChange={(event) => onChange(event.target.value)}
          className="db__cell-select-input"
        >
          {STATUS_GROUPS.map(({ group, label }) => {
            const inGroup = options.filter((option) => option.group === group);
            return inGroup.length ? (
              <optgroup key={group} label={label}>
                {inGroup.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}
              </optgroup>
            ) : null;
          })}
        </select>
      </span>
    );
  }
  if (property.type === "select") {
    // A select starts genuinely empty, the way an unset Notion property does.
    const options = propertyOptions(property);
    return (
      <span className="db__cell db__cell--select">
        {value ? <OptionTag property={property} value={value} /> : null}
        <select
          aria-label={propertyName(property)}
          data-history-field={`property:${property.id}`}
          value={value}
          disabled={readOnly}
          onChange={(event) => onChange(event.target.value)}
          className="db__cell-select-input"
        >
          <option value="">Empty</option>
          {options.map((option) => <option key={option}>{option}</option>)}
        </select>
      </span>
    );
  }
  if (property.type === "person") {
    return (
      <label className="db__person">
        {value ? <Avatar name={value} size={20} /> : null}
        <input
          value={value}
          aria-label={propertyName(property)}
          data-history-field={`property:${property.id}`}
          placeholder="Empty"
          readOnly={readOnly}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    );
  }
  if (property.type === "date") {
    // A real date, stored as `YYYY-MM-DD`, because a calendar has to be able
    // to find the day. A value typed before dates were dates still shows in
    // every other view; the picker simply starts empty for it.
    // The native field cannot hold a placeholder of its own, so an unset date
    // says "Empty" the way every other unset Notion property does, from the
    // wrapper — never "mm/dd/yyyy".
    const set = ISO_DAY.test(value);
    return (
      <span className={`db__date ${set ? "" : "is-empty"}`}>
        <input
          type="date"
          className="db__cell db__cell--date"
          value={set ? value.slice(0, 10) : ""}
          readOnly={readOnly}
          aria-label={propertyName(property)}
          data-history-field={`property:${property.id}`}
          onChange={(event) => onChange(event.target.value)}
        />
      </span>
    );
  }
  return <TextValue property={property} value={value} readOnly={readOnly} wrap={wrap} onChange={onChange} />;
}
