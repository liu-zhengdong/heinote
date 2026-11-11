import { ALargeSmall, ArrowLeftRight, AtSign, Calendar, Check, Clock, Fingerprint, Hash, History, ImageIcon, Link as LinkIcon, ListFilter, Phone, SquareCheckBig, Tags, Text as TextIcon, UserCheck, UserPlus, UserRound } from "lucide-react";
import { Avatar } from "../../components/Avatar";
import { Select } from "../../components/Select";
import { imeComposing } from "../../core/keyboard";
import type { DatabaseProperty, NotePage, OptionColor } from "../../core/types";
import { dateRange, ISO_DAY, isMetaType, OPTION_COLORS as OPTION_COLOR_NAMES, propertyName, propertyOptions, propertyValue, STATUS_GROUPS, statusOf, statusOptions } from "./database-model";
import { ImageProperty } from "./ImageProperty";
import { MultiSelect } from "./MultiSelect";
import { RelationPicker } from "./RelationPicker";
import { useColumnIcon } from "./property-icon-store";

export { ISO_DAY };

/* The pieces every place that shows a database value shares: the table's
   cells, the cards, and the page opened from a row. One module, so a status
   looks like itself wherever it appears. */

/** The colour an option's pill wears: a status's option's own, or a select's
 *  or multi-select's from `option_colors` — grey ("default") until given
 *  one. A colour the palette no longer has reads as default, never breaks. */
export function optionTone(property: DatabaseProperty, value: string): OptionColor {
  if (property.type === "status") return statusOf(property, value).color;
  const stored: unknown = property.option_colors?.[value];
  return typeof stored === "string" && (OPTION_COLOR_NAMES as readonly string[]).includes(stored)
    ? (stored as OptionColor)
    : "default";
}

/** A status, select or multi-select value as a pill. A status wears its
 *  option's colour and a dot; the others wear theirs from `option_colors`,
 *  grey until coloured. */
export function OptionTag({ property, value }: { property: DatabaseProperty; value: string }) {
  const status = property.type === "status";
  return (
    <span className={`tag ${status ? "tag--status" : ""}`} data-tone={optionTone(property, value)}>
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
  if (type === "number") return <Hash size={size} />;
  if (type === "multi_select") return <Tags size={size} />;
  if (type === "checkbox") return <SquareCheckBig size={size} />;
  if (type === "url") return <LinkIcon size={size} />;
  if (type === "email") return <AtSign size={size} />;
  if (type === "phone") return <Phone size={size} />;
  if (type === "created_time") return <Clock size={size} />;
  if (type === "last_edited_time") return <History size={size} />;
  if (type === "created_by") return <UserPlus size={size} />;
  if (type === "last_edited_by") return <UserCheck size={size} />;
  if (type === "id") return <Fingerprint size={size} />;
  if (type === "relation") return <ArrowLeftRight size={size} />;
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

/** "Sep 20" as stored — "Sep 20", or "Sep 20, 2025" outside this year. */
function dayText(value: string): string {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const sameYear = year === new Date().getFullYear();
  return new Intl.DateTimeFormat(undefined, sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" }).format(date);
}

/** "Sep 20", or "Sep 20 → Sep 28" for a range. A value that is not a date
 *  is shown exactly as it was typed rather than hidden. */
export function formatDay(value: string): string {
  const range = dateRange(value);
  if (!range) return value;
  return range.end ? `${dayText(range.start)} → ${dayText(range.end)}` : dayText(range.start);
}

/** A meta column's moment — "Nov 28, 4:32 PM" ("…, 2025" outside this
 *  year) — for created_time and last_edited_time, which hold the row
 *  record's ISO timestamp. Anything else comes back as stored. */
export function formatMoment(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric", minute: "2-digit",
  }).format(date);
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
    // A status uses its default when unset. Options retain their groups.
    const current = statusOf(property, value).name;
    const options = statusOptions(property);
    return (
      <span className="db__cell db__cell--select">
        <Select
          aria-label={propertyName(property)}
          data-history-field={`property:${property.id}`}
          value={current}
          disabled={readOnly}
          onValueChange={onChange}
          variant="cell"
          className="db__cell-select"
          options={STATUS_GROUPS.flatMap(({ group, label }) => options
            .filter((option) => option.group === group)
            .map((option) => ({ value: option.name, label: option.name, group: label, content: <OptionTag property={property} value={option.name} /> })))}
        />
      </span>
    );
  }
  if (property.type === "select") {
    // A select starts genuinely empty, the way an unset Notion property does.
    const options = propertyOptions(property);
    return (
      <span className="db__cell db__cell--select">
        <Select
          aria-label={propertyName(property)}
          data-history-field={`property:${property.id}`}
          value={value}
          disabled={readOnly}
          onValueChange={onChange}
          variant="cell"
          className="db__cell-select"
          options={[{ value: "", label: "Empty" }, ...options.map((option) => ({ value: option, label: option, content: <OptionTag property={property} value={option} /> }))]}
        />
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
  /* A meta column is read-only everywhere: it reads the row's own record —
   *  when it was made, touched, by whom, its id — so nothing writes it. It
   *  is drawn like any value, not an input, so the cells still look alike. */
  if (isMetaType(property.type)) {
    // The value lives on the row's record, not in `properties` — `value`
    // (a stored property value) is only the fallback for callers with no row.
    const meta = row ? propertyValue(row, property) : value;
    const shown = property.type === "created_time" || property.type === "last_edited_time"
      ? formatMoment(meta)
      : meta;
    const who = property.type === "created_by" || property.type === "last_edited_by";
    return (
      <span className={`db__meta ${shown ? "" : "is-empty"}`} data-meta={property.type} title={property.type === "id" ? meta : undefined}>
        {who && shown ? <Avatar name={meta} size={20} /> : null}
        <span className="db__meta-value">{shown}</span>
      </span>
    );
  }
  /* A checkbox is checked ("true") or it is not (""). One click toggles;
   *  the box is the to-do block's, so the app has one kind of tick. */
  if (property.type === "checkbox") {
    const checked = value === "true";
    return (
      <span className="db__check">
        <button
          type="button"
          className={`checkbox ${checked ? "is-checked" : ""}`}
          aria-label={`${propertyName(property)}: ${checked ? "checked" : "unchecked"}`}
          aria-pressed={checked}
          disabled={readOnly}
          onClick={(event) => {
            event.stopPropagation();
            onChange(checked ? "" : "true");
          }}
        >
          {checked ? <Check size={12} strokeWidth={3} /> : null}
        </button>
      </span>
    );
  }
  if (property.type === "multi_select") {
    return (
      <MultiSelect
        property={property}
        value={value}
        readOnly={readOnly}
        onChange={onChange}
      />
    );
  }
  if (property.type === "relation") {
    return (
      <RelationPicker
        property={property}
        value={value}
        readOnly={readOnly}
        onChange={onChange}
      />
    );
  }
  /* url, email and phone type freely — an address cannot tell which kind it
   *  is while being typed; a set one reads as a link, underlined like the
   *  links in the words. Where the cell cannot be typed it is the link, so
   *  it can be followed (and its click stopped before it opens the row).
   *  Number keeps its numerals honest: right-aligned, tabular digits, and
   *  the decimal keypad on touch screens. */
  if (property.type === "number" || property.type === "url" || property.type === "email" || property.type === "phone") {
    const link = property.type !== "number" ? value : "";
    if (readOnly) {
      return link ? <span className="db__line"><PropertyLink property={property} value={value} /></span>
        : <span className="db__line is-empty"><span className="db__meta-value" /></span>;
    }
    return (
      <span className={`db__line ${value ? "" : "is-empty"}`}>
        <input
          type="text"
          className={`db__cell db__cell--line ${link ? "db__cell--link" : ""} ${property.type === "number" ? "db__cell--number" : ""}`}
          value={value}
          inputMode={property.type === "number" ? "decimal" : undefined}
          aria-label={propertyName(property)}
          data-history-field={`property:${property.id}`}
          placeholder="Empty"
          readOnly={readOnly}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || imeComposing(event)) return;
            event.preventDefault();
            event.currentTarget.blur();
          }}
        />
      </span>
    );
  }
  if (property.type === "date") {
    return <DateValue property={property} value={value} readOnly={readOnly} onChange={onChange} />;
  }
  return <TextValue property={property} value={value} readOnly={readOnly} wrap={wrap} onChange={onChange} />;
}

/** A Date cell: a real day, stored `YYYY-MM-DD`, because a calendar has to
 *  be able to find it — or a range, `YYYY-MM-DD/YYYY-MM-DD`, as Notion's
 *  "End date": the second day shown after an "→". Clearing the end folds
 *  the range back to one day; an end before the start swaps into order.
 *  A value typed before dates were dates still shows in every other view;
 *  the picker simply starts empty for it.
 *  The native field cannot hold a placeholder of its own, so an unset date
 *  says "Empty" the way every other unset Notion property does, from the
 *  wrapper — never "mm/dd/yyyy". */
function DateValue({
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
  const range = dateRange(value);
  const set = range !== null;
  const put = (start: string, end: string) => {
    // A cleared start gives its end the start's place — "/2026-11-28"
    // alone is no date. A range stores start/end in order either way.
    if (!start) [start, end] = [end, ""];
    if (start && end && end < start) [start, end] = [end, start];
    onChange(end ? `${start}/${end}` : start);
  };
  return (
    <span className={`db__date ${set ? "" : "is-empty"} ${range?.end ? "is-range" : ""}`}>
      <input
        type="date"
        className="db__cell db__cell--date"
        value={set ? range.start : ""}
        readOnly={readOnly}
        aria-label={propertyName(property)}
        data-history-field={`property:${property.id}`}
        onChange={(event) => put(event.target.value, range?.end ?? "")}
      />
      {set ? (
        <>
          <span className="db__date-arrow" aria-hidden="true">→</span>
          <input
            type="date"
            className="db__cell db__cell--date db__cell--date-end"
            value={range?.end ?? ""}
            readOnly={readOnly}
            aria-label={`${propertyName(property)} end`}
            onChange={(event) => put(range?.start ?? "", event.target.value)}
          />
        </>
      ) : null}
    </span>
  );
}

/** The address behind a url, email or phone value: as stored for a url,
 *  mailto: and tel: for the others, so the chips and cards can be followed.
 *  A url kept without a scheme is opened as https — what a person means. */
export function propertyLink(type: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (type === "email") return `mailto:${trimmed}`;
  if (type === "phone") return `tel:${trimmed.replace(/[\s()-]/g, "")}`;
  if (type === "url") return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return null;
}

/** A set url/email/phone value, drawn as the link it is. The click opens it
 *  — stopped, so it never opens the row instead; and outside a card's own
 *  drag or menu, the way a link in the words would behave. Read-only cells
 *  show it instead of the input (which would stop the click). */
export function PropertyLink({ property, value }: { property: DatabaseProperty; value: string }) {
  const href = propertyLink(property.type, value);
  if (!href) return null;
  return (
    <a
      className="db__link"
      href={href}
      target={property.type === "url" ? "_blank" : undefined}
      rel={property.type === "url" ? "noreferrer" : undefined}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {value}
    </a>
  );
}
