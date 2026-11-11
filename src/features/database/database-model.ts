import { COLOR_NAMES, PROPERTY_TYPES as DECLARED_PROPERTY_TYPES, VIEW_KINDS } from "../../../schema";
import { normalizeStoredFile } from "../../core/files";
import type {
  DatabaseConfig,
  DatabaseProperty,
  DatabaseView,
  DatabaseViewKind,
  FilterCondition,
  NotePage,
  OptionColor,
  PropertyType,
  StatusGroup,
  StatusOption,
  StoredFile,
  ViewFilter,
  ViewSort,
} from "../../core/types";
import { capitalized } from "../../core/title";

export const PROPERTY_LABELS: Record<PropertyType, string> = {
  text: "Text",
  number: "Number",
  status: "Status",
  person: "Person",
  select: "Select",
  multi_select: "Multi-select",
  date: "Date",
  image: "Image",
  checkbox: "Checkbox",
  url: "URL",
  email: "Email",
  phone: "Phone",
  relation: "Relation",
  created_time: "Created time",
  last_edited_time: "Last edited time",
  created_by: "Created by",
  last_edited_by: "Last edited by",
  id: "ID",
};

/** Every type a property can take, in the order Notion lists them — the
 *  one order both "Add property" and "Change type" offer (schema.ts). */
export const PROPERTY_TYPES: readonly PropertyType[] = DECLARED_PROPERTY_TYPES;

/** The id the row-name column goes by wherever a property id is expected
 *  (a sort, a column's menu). Property ids are `property_…`, so it cannot
 *  meet one. */
export const TITLE_COLUMN = "name";

/** What a property is called. A name typed away to nothing reads as its
 *  type, as a view's does, rather than as a blank column. */
export function propertyName(property: Pick<DatabaseProperty, "name" | "type">): string {
  return property.name.trim() ? property.name : PROPERTY_LABELS[property.type];
}

/** What the row-name column is called: "Name" until someone names it. */
export function titleName(config: Pick<DatabaseConfig, "title_name">): string {
  return config.title_name?.trim() ? config.title_name : "Name";
}

/** What a layout is called: Table, Board, List, Gallery, Calendar. */
export function viewKindLabel(kind: DatabaseViewKind): string {
  return capitalized(kind);
}

function availableName(taken: string[], base: string): string {
  const existing = new Set(taken.map((name) => name.toLowerCase()));
  if (!existing.has(base.toLowerCase())) return base;
  let suffix = 2;
  while (existing.has(`${base} ${suffix}`.toLowerCase())) suffix += 1;
  return `${base} ${suffix}`;
}

/** A new property of `type`. A status starts on Notion's three statuses,
 *  which is what it reads as while it has no options of its own; a select
 *  and a multi-select start with none. */
export function createDatabaseProperty(
  id: string,
  type: PropertyType,
  existing: DatabaseProperty[],
): DatabaseProperty {
  const name = availableName(existing.map((property) => property.name), PROPERTY_LABELS[type]);
  return {
    id,
    name,
    type,
    ...(type === "select" || type === "multi_select" ? { options: [] } : {}),
  };
}

/* ── Statuses ──────────────────────────────────────────────────────────── */

/** Notion's three kinds of status, in the order a task goes through them,
 *  each with the colour an option made in it starts with. */
export const STATUS_GROUPS: ReadonlyArray<{ group: StatusGroup; label: string; color: OptionColor }> = [
  { group: "todo", label: "To-do", color: "default" },
  { group: "progress", label: "In progress", color: "blue" },
  { group: "complete", label: "Complete", color: "green" },
];

/** The colours an option's pill can take, in Notion's order: its default
 *  grey, then the nine. */
export const OPTION_COLORS: readonly OptionColor[] = ["default", ...COLOR_NAMES];

/** What a status offers until it is given options of its own — Notion's. */
export const DEFAULT_STATUS_OPTIONS: readonly StatusOption[] = [
  { id: "not-started", name: "Not started", color: "default", group: "todo" },
  { id: "in-progress", name: "In progress", color: "blue", group: "progress" },
  { id: "done", name: "Done", color: "green", group: "complete" },
];

/** The most options one status holds: every one is a board column and a
 *  line in every menu that lists them. */
export const MAX_STATUS_OPTIONS = 100;

export const OPTION_COLOR_SET: ReadonlySet<string> = new Set(OPTION_COLORS);
const GROUP_RANK: ReadonlyMap<string, number> = new Map(STATUS_GROUPS.map((entry, index) => [entry.group, index]));

function inGroupOrder(options: readonly StatusOption[]): StatusOption[] {
  return options.toSorted((left, right) => GROUP_RANK.get(left.group)! - GROUP_RANK.get(right.group)!);
}

/** A status's options — its own, To-do first, then In progress, then
 *  Complete, as the writers below keep them (schema.ts holds each one's
 *  shape) — or Notion's three until it has some. */
export function statusOptions(property: Pick<DatabaseProperty, "status_options">): readonly StatusOption[] {
  return property.status_options?.length ? property.status_options : DEFAULT_STATUS_OPTIONS;
}

/** The option a row reads as before anyone sets it — Notion's "Default". */
export function defaultStatus(property: Pick<DatabaseProperty, "status_options" | "default_status">): StatusOption {
  const options = statusOptions(property);
  return options.find((option) => option.id === property.default_status)
    ?? options.find((option) => option.group === "todo")
    ?? options[0];
}

/** Whether a stored value names `option`: as written, or with the spaces a
 *  value typed into a Text column (before it was a Status) can carry. */
function names(option: StatusOption, value: unknown): boolean {
  return typeof value === "string" && (value === option.name || value.trim() === option.name);
}

/** The option a stored value names — or, naming none, the default. */
export function statusOf(property: Pick<DatabaseProperty, "status_options" | "default_status">, value: unknown): StatusOption {
  const options = statusOptions(property);
  return options.find((option) => option.name === value)
    ?? options.find((option) => names(option, value))
    ?? defaultStatus(property);
}

/** Whether `name` is already an option's, other than `exceptId`'s. Names
 *  are compared as people read them: "done" is "Done". */
export function statusNameTaken(property: Pick<DatabaseProperty, "status_options">, name: string, exceptId?: string): boolean {
  const wanted = name.trim().toLocaleLowerCase();
  return statusOptions(property).some((option) => option.id !== exceptId && option.name.trim().toLocaleLowerCase() === wanted);
}

/** A value written onto rows: which row, and what it now holds. */
export interface RowWrite {
  rowId: string;
  value: string;
}

function statusProperty(config: DatabaseConfig, propertyId: string): DatabaseProperty | undefined {
  return config.properties.find((property) => property.id === propertyId && property.type === "status");
}

function withStatus(config: DatabaseConfig, property: DatabaseProperty, patch: Partial<DatabaseProperty>): DatabaseConfig {
  return withProperties(config, config.properties.map((item) => (item.id === property.id ? { ...property, ...patch } : item)));
}

/** Adds an option at the end of `group`, in the group's colour. Null when
 *  the name is blank or already an option's, or the status is full. */
export function addStatusOption(
  config: DatabaseConfig,
  propertyId: string,
  group: StatusGroup,
  name: string,
  id: string,
): { config: DatabaseConfig; option: StatusOption } | null {
  const property = statusProperty(config, propertyId);
  const clean = name.trim();
  if (!property || !clean || statusNameTaken(property, clean)) return null;
  const options = statusOptions(property);
  if (options.length >= MAX_STATUS_OPTIONS || options.some((option) => option.id === id)) return null;
  const color = STATUS_GROUPS.find((entry) => entry.group === group)?.color ?? "default";
  const option: StatusOption = { id, name: clean, color, group };
  return { config: withStatus(config, property, { status_options: inGroupOrder([...options, option]) }), option };
}

/** Renames an option. Rows hold the name, so every row holding the old one
 *  is given the new one (`writes`), and a view filtered on it follows. Null
 *  when the name is blank or another option's. */
export function renameStatusOption(
  config: DatabaseConfig,
  propertyId: string,
  optionId: string,
  name: string,
  rows: readonly NotePage[],
): { config: DatabaseConfig; writes: RowWrite[] } | null {
  const property = statusProperty(config, propertyId);
  const options = property ? statusOptions(property) : [];
  const option = options.find((item) => item.id === optionId);
  const clean = name.trim();
  if (!property || !option || !clean || statusNameTaken(property, clean, optionId)) return null;
  if (clean === option.name) return { config, writes: [] };
  const next = withStatus(config, property, {
    status_options: options.map((item) => (item.id === optionId ? { ...item, name: clean } : item)),
  });
  return {
    config: {
      ...next,
      views: next.views.map((view) => mapViewFilters(view, (condition) =>
        condition.property_id === propertyId && condition.value === option.name
          ? { ...condition, value: clean }
          : condition)),
    },
    writes: rows.filter((row) => names(option, row.properties?.[propertyId])).map((row) => ({ rowId: row.id, value: clean })),
  };
}

export function recolorStatusOption(config: DatabaseConfig, propertyId: string, optionId: string, color: OptionColor): DatabaseConfig {
  const property = statusProperty(config, propertyId);
  if (!property || !OPTION_COLOR_SET.has(color)) return config;
  return withStatus(config, property, {
    status_options: statusOptions(property).map((option) => (option.id === optionId ? { ...option, color } : option)),
  });
}

/** Moves an option to `index` among `group`'s options (counted without it):
 *  a drag within its group, or into another one. */
export function moveStatusOption(
  config: DatabaseConfig,
  propertyId: string,
  optionId: string,
  group: StatusGroup,
  index: number,
): DatabaseConfig {
  const property = statusProperty(config, propertyId);
  const options = property ? statusOptions(property) : [];
  const moving = options.find((option) => option.id === optionId);
  if (!property || !moving || !GROUP_RANK.has(group)) return config;
  const rest = options.filter((option) => option.id !== optionId);
  const inGroup = rest.filter((option) => option.group === group);
  const at = Math.max(0, Math.min(Math.trunc(index) || 0, inGroup.length));
  // Placed before the option it lands in front of, or after the group's last.
  const before = inGroup[at];
  const position = before ? rest.indexOf(before) : (inGroup.length ? rest.indexOf(inGroup[inGroup.length - 1]) + 1 : rest.length);
  const next = [...rest];
  next.splice(position, 0, { ...moving, group });
  return withStatus(config, property, { status_options: inGroupOrder(next) });
}

export function setDefaultStatus(config: DatabaseConfig, propertyId: string, optionId: string): DatabaseConfig {
  const property = statusProperty(config, propertyId);
  if (!property || !statusOptions(property).some((option) => option.id === optionId)) return config;
  return withStatus(config, property, { status_options: [...statusOptions(property)], default_status: optionId });
}

/** Deletes an option. Rows holding it are cleared (`writes`), so they read
 *  as the default, and a view filtered on it stops filtering — a filter on
 *  a status no row can hold would hide every row. Null for the last option:
 *  a status always has one to read as. */
export function removeStatusOption(
  config: DatabaseConfig,
  propertyId: string,
  optionId: string,
  rows: readonly NotePage[],
): { config: DatabaseConfig; writes: RowWrite[] } | null {
  const property = statusProperty(config, propertyId);
  const options = property ? statusOptions(property) : [];
  const option = options.find((item) => item.id === optionId);
  if (!property || !option || options.length <= 1) return null;
  const kept: DatabaseProperty = { ...property, status_options: options.filter((item) => item.id !== optionId) };
  // The default gone, the first To-do option is the default.
  if (kept.default_status === optionId) delete kept.default_status;
  const next = withProperties(config, config.properties.map((item) => (item.id === propertyId ? kept : item)));
  return {
    config: {
      ...next,
      views: next.views.map((view) => mapViewFilters(view, (condition) =>
        condition.property_id === propertyId && condition.value === option.name ? null : condition)),
    },
    writes: rows.filter((row) => names(option, row.properties?.[propertyId])).map((row) => ({ rowId: row.id, value: "" })),
  };
}

/* ── Select and multi-select options ──────────────────────────────────────
   Both keep their options in `options` (a status's are `status_options`),
   each optionally coloured in `option_colors` by name — a select stores the
   name itself as a row's value, a multi-select a JSON list of them. */

function optionsProperty(config: DatabaseConfig, propertyId: string): DatabaseProperty | undefined {
  return config.properties.find((property) => property.id === propertyId
    && (property.type === "select" || property.type === "multi_select"));
}

/** Whether `name` is already an option's, other than `except`'s. Names are
 *  compared as people read them: "done" is "Done". */
export function optionNameTaken(property: Pick<DatabaseProperty, "options">, name: string, except?: string): boolean {
  const wanted = name.trim().toLocaleLowerCase();
  return (property.options ?? []).some((option) => option !== except && option.trim().toLocaleLowerCase() === wanted);
}

/** A new option at the end of the list. Null when the name is blank or
 *  already an option's. */
export function addSelectOption(
  config: DatabaseConfig,
  propertyId: string,
  name: string,
): { config: DatabaseConfig; option: string } | null {
  const property = optionsProperty(config, propertyId);
  const clean = name.trim();
  if (!property || !clean || optionNameTaken(property, clean)) return null;
  return {
    config: withProperties(config, config.properties.map((item) => (item.id === propertyId ? { ...item, options: [...(item.options ?? []), clean] } : item))),
    option: clean,
  };
}

/** An option's pill colour, unset reading as the default grey. */
export function recolorSelectOption(config: DatabaseConfig, propertyId: string, option: string, color: OptionColor): DatabaseConfig {
  const property = optionsProperty(config, propertyId);
  if (!property || !OPTION_COLOR_SET.has(color)) return config;
  const colors = { ...(property.option_colors ?? {}) };
  if (color === "default") delete colors[option];
  else colors[option] = color;
  return withProperties(config, config.properties.map((item) => (item.id === propertyId ? { ...item, option_colors: colors } : item)));
}

/** Every name a row holds in this property — a select's one, or a
 *  multi-select's list — with the option renamed from `from` to `to`
 *  (null drops it). Only values that held `from` come back. */
function renamedRows(rows: readonly NotePage[], propertyId: string, multi: boolean, from: string, to: string | null): RowWrite[] {
  const writes: RowWrite[] = [];
  for (const row of rows) {
    const value = row.properties?.[propertyId];
    if (typeof value !== "string" || !value) continue;
    if (!multi) {
      if (value === from) writes.push({ rowId: row.id, value: to ?? "" });
      continue;
    }
    const held = multiValues(value);
    if (!held.includes(from)) continue;
    writes.push({ rowId: row.id, value: toMultiValue(held.map((name) => (name === from ? to : name)).filter((name): name is string => Boolean(name))) });
  }
  return writes;
}

/** Renames an option everywhere it appears: the list, its colour's key, a
 *  view filtered on it, and every row holding it (in a multi-select, inside
 *  its list) — as a status's rename does. Null when the name is blank or
 *  another option's. */
export function renameSelectOption(
  config: DatabaseConfig,
  propertyId: string,
  from: string,
  name: string,
  rows: readonly NotePage[],
): { config: DatabaseConfig; writes: RowWrite[] } | null {
  const property = optionsProperty(config, propertyId);
  const clean = name.trim();
  if (!property || !(property.options ?? []).includes(from) || !clean || optionNameTaken(property, clean, from)) return null;
  if (clean === from) return { config, writes: [] };
  const colors = { ...(property.option_colors ?? {}) };
  if (Object.hasOwn(colors, from)) {
    colors[clean] = colors[from];
    delete colors[from];
  }
  const renamed: DatabaseProperty = {
    ...property,
    options: (property.options ?? []).map((option) => (option === from ? clean : option)),
    option_colors: colors,
  };
  const next = withProperties(config, config.properties.map((item) => (item.id === propertyId ? renamed : item)));
  return {
    config: {
      ...next,
      views: next.views.map((view) => mapViewFilters(view, (condition) =>
        condition.property_id === propertyId && condition.value === from
          ? { ...condition, value: clean }
          : condition)),
    },
    writes: renamedRows(rows, propertyId, property.type === "multi_select", from, clean),
  };
}

/** Deletes an option, clearing it from the rows holding it (a multi-select
 *  keeps its other options) and stopping a view filtered on it — nothing
 *  hides rows over a value no row can hold. */
export function removeSelectOption(
  config: DatabaseConfig,
  propertyId: string,
  name: string,
  rows: readonly NotePage[],
): { config: DatabaseConfig; writes: RowWrite[] } | null {
  const property = optionsProperty(config, propertyId);
  if (!property || !(property.options ?? []).includes(name)) return null;
  const colors = { ...(property.option_colors ?? {}) };
  delete colors[name];
  const next = withProperties(config, config.properties.map((item) => (item.id === propertyId ? { ...item, options: (item.options ?? []).filter((option) => option !== name), option_colors: colors } : item)));
  return {
    config: {
      ...next,
      views: next.views.map((view) => mapViewFilters(view, (condition) =>
        condition.property_id === propertyId && condition.value === name ? null : condition)),
    },
    writes: renamedRows(rows, propertyId, property.type === "multi_select", name, null),
  };
}

/* ── Column widths ─────────────────────────────────────────────────────── */

/** How narrow and how wide a column can be dragged, and how wide a property
 *  column and the "Add property" column are until someone drags them. The
 *  row-name column's default follows the table's width (see TableLayout). */
export const COLUMN_WIDTH = { min: 64, max: 1200, property: 180, addProperty: 180 } as const;

/* How a view's stored widths can be wrong — trusted no more than options:
    13. no widths, or not a plain object → every column its default;
    14. a width that is not a finite number → that column's default;
    15. narrower than COLUMN_WIDTH.min or wider than .max → held to them;
    16. a fraction → whole pixels;
    17. a column named like a key of Object.prototype → its default: only
        the object's own keys are widths. */

/** A width held between the narrowest and the widest, in whole pixels. */
export function clampColumnWidth(width: number): number {
  return Math.round(Math.min(COLUMN_WIDTH.max, Math.max(COLUMN_WIDTH.min, width)));
}

/** The width a view gives a column, when it gives one. */
export function columnWidth(view: Pick<DatabaseView, "widths">, column: string): number | undefined {
  const widths: unknown = view.widths;
  if (!widths || typeof widths !== "object" || Array.isArray(widths) || !Object.hasOwn(widths, column)) return undefined;
  const width = (widths as Record<string, unknown>)[column];
  return typeof width === "number" && Number.isFinite(width) ? clampColumnWidth(width) : undefined;
}

/** The view with `column` dragged to `width`. */
export function withColumnWidth(view: DatabaseView, column: string, width: number): DatabaseView {
  const widths: Record<string, number> = {};
  const stored: unknown = view.widths;
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const key of Object.keys(stored)) {
      const kept = columnWidth(view, key);
      if (kept !== undefined) widths[key] = kept;
    }
  }
  widths[column] = clampColumnWidth(width);
  return { ...view, widths };
}

/* ── Wrapping ──────────────────────────────────────────────────────────── */

/* How a view's stored wrapping can be wrong — trusted no more than widths:
    24. no `wrap`, or not a plain object → every column wraps (Notion's
        default);
    25. an entry that is not `false` (true, "false", 0, null, an object) →
        that column wraps: only a `false` keeps a column to one line;
    26. a column named like a key of Object.prototype → it wraps: only the
        object's own keys count;
    27. a write carries no garbage along — entries that are not `false` are
        dropped — and a column set to wrap again leaves no entry behind (none
        left, no `wrap` at all). */

/** Whether a column's words wrap onto the lines below — the row growing to
 *  hold them — rather than keeping to one line. Only the row-name column and
 *  Text columns have words to wrap; the layout asks for those alone. */
export function columnWraps(view: Pick<DatabaseView, "wrap">, column: string): boolean {
  const wrap: unknown = view.wrap;
  if (!wrap || typeof wrap !== "object" || Array.isArray(wrap) || !Object.hasOwn(wrap, column)) return true;
  return (wrap as Record<string, unknown>)[column] !== false;
}

/** The view with `column`'s words wrapping, or kept to one line. */
export function withColumnWrap(view: DatabaseView, column: string, wraps: boolean): DatabaseView {
  const oneLine: Record<string, boolean> = {};
  const stored: unknown = view.wrap;
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const key of Object.keys(stored)) {
      if (!columnWraps(view, key)) oneLine[key] = false;
    }
  }
  if (wraps) delete oneLine[column];
  else oneLine[column] = false;
  const next: DatabaseView = { ...view };
  if (Object.keys(oneLine).length) next.wrap = oneLine;
  else delete next.wrap;
  return next;
}

/* ── Icons ─────────────────────────────────────────────────────────────── */

/** Gives a column its own mark (a key of `PROPERTY_ICONS`), or — null —
 *  gives it back its type's. `TITLE_COLUMN` is the row-name column. */
export function setPropertyIcon(config: DatabaseConfig, column: string, icon: string | null): DatabaseConfig {
  if (column === TITLE_COLUMN) {
    const next = { ...config };
    if (icon) next.title_icon = icon;
    else delete next.title_icon;
    return next;
  }
  return withProperties(config, config.properties.map((property) => {
    if (property.id !== column) return property;
    const next = { ...property };
    if (icon) next.icon = icon;
    else delete next.icon;
    return next;
  }));
}

/* ── Changing a property ───────────────────────────────────────────────── */

/* Every change below returns a whole new config — the database page's one
   field — and leaves the rows alone. A property deleted takes nothing out of
   the rows: its values stay where they are, so undo brings the column back
   whole, as Notion's deleted properties come back. */

function withProperties(config: DatabaseConfig, properties: DatabaseProperty[]): DatabaseConfig {
  return { ...config, properties };
}

/** A property of `type`, put in at `index` (clamped): Insert left and right. */
export function insertProperty(
  config: DatabaseConfig,
  id: string,
  type: PropertyType,
  index: number,
): { config: DatabaseConfig; property: DatabaseProperty } {
  const property = createDatabaseProperty(id, type, config.properties);
  const properties = [...config.properties];
  properties.splice(Math.max(0, Math.min(index, properties.length)), 0, property);
  return { config: withProperties(config, properties), property };
}

/** Renames a property — or, as `TITLE_COLUMN`, the row-name column. The
 *  name is kept exactly as typed, so the field it is typed in never jumps;
 *  a blank one reads as the default (`propertyName`, `titleName`). */
export function renameProperty(config: DatabaseConfig, propertyId: string, name: string): DatabaseConfig {
  if (propertyId === TITLE_COLUMN) return { ...config, title_name: name };
  return withProperties(config, config.properties.map((property) => (property.id === propertyId ? { ...property, name } : property)));
}

/** A name that is still only the name a type gave it: "Text", "Date 2". */
function isTypeDefault(name: string, type: PropertyType): boolean {
  const label = PROPERTY_LABELS[type];
  return name === label || new RegExp(`^${label} \\d+$`).test(name);
}

/** Turns a property into another type. Every value is a string, so nothing
 *  stored is converted or lost, and turning it back shows what was there.
 *  What changes is what the column means:
 *  - becoming a select, it offers every value its rows already hold (after
 *    the options it had), as Notion's does — a column of typed words turns
 *    into tags you can pick, and a board can group by it;
 *  - becoming a status, every value its rows hold (and every option a
 *    select offered) that is not yet one of its statuses joins To-do, so no
 *    row quietly reads as the default instead of what it says;
 *  - becoming a meta column (Created time and its kin), each row's own
 *    record shows; the values it held stay stored, for when it turns back;
 *  - its mark and a status's own options stay with it, whatever it becomes,
 *    so a Status turned into Text and back is the Status it was;
 *  - named only after its old type ("Text", "Date 2"), it takes the new
 *    type's name; a name someone gave it stays;
 *  - a view filtered on it keeps the filter only while it can still be
 *    filtered (a status or a select) — a filter nothing can show or clear
 *    would hide rows for good. */
export function changePropertyType(
  config: DatabaseConfig,
  propertyId: string,
  type: PropertyType,
  rows: readonly NotePage[],
): DatabaseConfig {
  const current = config.properties.find((property) => property.id === propertyId);
  if (!current || current.type === type) return config;
  const others = config.properties.filter((property) => property.id !== propertyId);
  const name = isTypeDefault(current.name, current.type)
    ? availableName(others.map((property) => property.name), PROPERTY_LABELS[type])
    : current.name;
  const next: DatabaseProperty = { id: current.id, name, type };
  if (current.icon !== undefined) next.icon = current.icon;
  if (current.status_options !== undefined) next.status_options = current.status_options;
  if (current.default_status !== undefined) next.default_status = current.default_status;
  /* The values a column becoming an optioned type brings: a select's each
     *  name as held; a multi-select's lists opened out, so "Backend, Login"
     *  becomes options Backend and Login, not one called "Backend, Login". */
  const held = rows.flatMap((row) => {
    const value = row.properties?.[propertyId];
    if (typeof value !== "string" || !value.trim()) return [];
    const names = current.type === "multi_select" ? multiValues(value) : [value];
    return names.map((name) => name.trim()).filter(Boolean);
  });
  if (type === "select" || type === "multi_select") {
    const options = [...(current.type === "status" ? statusOptions(current).map((option) => option.name) : current.options ?? [])];
    for (const value of held) {
      if (!options.includes(value)) options.push(value);
    }
    next.options = options;
    if (current.option_colors !== undefined) next.option_colors = current.option_colors;
  }
  if (type === "status") {
    const options = [...statusOptions(current)];
    const ids = new Set(options.map((option) => option.id));
    for (const value of [...(current.type === "select" || current.type === "multi_select" ? current.options ?? [] : []), ...held]) {
      if (options.length >= MAX_STATUS_OPTIONS) break;
      if (typeof value !== "string" || !value.trim() || options.some((option) => option.name === value)) continue;
      let id = `status-${options.length}`;
      for (let suffix = 2; ids.has(id); suffix += 1) id = `status-${options.length}-${suffix}`;
      ids.add(id);
      options.push({ id, name: value, color: "default", group: "todo" });
    }
    if (options.length !== statusOptions(current).length) next.status_options = inGroupOrder(options);
  }
  return {
    ...config,
    properties: config.properties.map((property) => (property.id === propertyId ? next : property)),
    // A condition survives only if the new type can still take its
    // operator — and its value goes only when the empties don't need one.
    views: config.views.map((view) => {
      const mapped = mapViewFilters(view, (condition) => {
        if (condition.property_id !== propertyId) return condition;
        const ops = FILTER_OPS[type];
        if (!ops.length) return null;
        const op = condition.op && ops.includes(condition.op) ? condition.op : defaultFilterOp(type);
        const kept: FilterCondition = { property_id: propertyId, op };
        if (filterNeedsValue(op)) kept.value = condition.value ?? "";
        return kept;
      });
      /* The old single `filter` only ever named a select or a status; on
         another type it cannot mean anything — it goes, as it always did. A
         `filters` condition on the property keeps whatever the new type
         still takes. */
      if (mapped.filter && type !== "select" && type !== "status") {
        const moved: DatabaseView = { ...mapped };
        delete moved.filter;
        return moved;
      }
      return mapped;
    }),
  };
}

/** A copy of a property beside it, named "<name> 2", as wide in every view
 *  as the original and wrapping as it does. Its values are the caller's to
 *  copy — they live on the rows. */
export function duplicateProperty(
  config: DatabaseConfig,
  propertyId: string,
  newId: string,
): { config: DatabaseConfig; property: DatabaseProperty } | null {
  const index = config.properties.findIndex((property) => property.id === propertyId);
  if (index < 0) return null;
  const source = config.properties[index];
  const property: DatabaseProperty = {
    ...structuredClone(source),
    id: newId,
    name: availableName(config.properties.map((item) => item.name), propertyName(source)),
  };
  const properties = [...config.properties];
  properties.splice(index + 1, 0, property);
  return {
    config: {
      ...withProperties(config, properties),
      views: config.views.map((view) => {
        const width = columnWidth(view, propertyId);
        const sized = width === undefined ? view : withColumnWidth(view, newId, width);
        return columnWraps(view, propertyId) ? sized : withColumnWrap(sized, newId, false);
      }),
    },
    property,
  };
}

/** Takes a property out of the database, and out of every view that hangs
 *  on it: a sort or a filter on it goes (a filter left behind would hide rows
 *  with nothing on screen to say why), a board or a calendar placing rows
 *  by it falls back to the next property that can, and its width and its
 *  wrapping go. */
export function removeProperty(config: DatabaseConfig, propertyId: string): DatabaseConfig {
  return {
    ...config,
    properties: config.properties.filter((property) => property.id !== propertyId),
    views: config.views.map((view) => {
      const next: DatabaseView = mapViewFilters(view, (condition) =>
        condition.property_id === propertyId ? null : condition);
      if (Array.isArray(next.sorts) && next.sorts.some((sort) => sort?.property_id === propertyId)) {
        next.sorts = next.sorts.filter((sort) => sort?.property_id !== propertyId);
      }
      if (next.group_by === propertyId) delete next.group_by;
      if (next.date_by === propertyId) delete next.date_by;
      if (next.card_preview === propertyId) delete next.card_preview;
      if (next.card_properties) next.card_properties = next.card_properties.filter((id) => id !== propertyId);
      if (next.hidden) {
        next.hidden = next.hidden.filter((id) => id !== propertyId);
        if (!next.hidden.length) delete next.hidden;
      }
      if (next.calcs && Object.hasOwn(next.calcs, propertyId)) {
        const calcs = { ...next.calcs };
        delete calcs[propertyId];
        if (Object.keys(calcs).length) next.calcs = calcs;
        else delete next.calcs;
      }
      if (columnWidth(next, propertyId) !== undefined) {
        const widths = { ...next.widths };
        delete widths[propertyId];
        next.widths = widths;
      }
      return columnWraps(next, propertyId) ? next : withColumnWrap(next, propertyId, true);
    }),
  };
}

/* ── Pictures ──────────────────────────────────────────────────────────── */

/** The most pictures one cell holds — Notion's Files & media takes many, and
 *  fifty references stay well inside a row's record (see `fitsRow`). */
export const MAX_ROW_IMAGES = 50;

/** A row's pictures in an Image property, each checked where it is used —
 *  a file reference in a record was written by someone's client. */
export function rowImages(row: Pick<NotePage, "property_files"> | undefined, propertyId: string): StoredFile[] {
  const stored = row?.property_files?.[propertyId];
  if (!Array.isArray(stored)) return [];
  const files: StoredFile[] = [];
  for (const item of stored.slice(0, MAX_ROW_IMAGES)) {
    const file = normalizeStoredFile(item);
    if (file) files.push(file);
  }
  return files;
}

/** Whether a view can be sorted by a property: pictures have no order. */
export function sortable(property: Pick<DatabaseProperty, "type">): boolean {
  return property.type !== "image";
}

/* ── Gallery cards ─────────────────────────────────────────────────────── */

export type CardPreview =
  | { kind: "image"; property: DatabaseProperty }
  | { kind: "cover" | "content" | "none" };

/** What a gallery's cards show above their names. A chosen Image property
 *  that has since gone, or stopped being one, gives way to the default: the
 *  first Image property, else the page's first lines. */
export function cardPreview(view: DatabaseView, properties: DatabaseProperty[]): CardPreview {
  const chosen = view.card_preview;
  if (chosen === "cover" || chosen === "content" || chosen === "none") return { kind: chosen };
  const images = properties.filter((property) => property.type === "image");
  const image = images.find((property) => property.id === chosen) ?? images[0];
  return image ? { kind: "image", property: image } : { kind: "content" };
}

/** The properties a gallery's cards show, in the database's order. */
export function cardProperties(view: DatabaseView, properties: DatabaseProperty[]): DatabaseProperty[] {
  const shown = view.card_properties;
  return shown ? properties.filter((property) => shown.includes(property.id)) : properties;
}

/** Shows a property on the cards, or stops showing it. The first change
 *  turns "every one" into the list it was. */
export function toggleCardProperty(view: DatabaseView, properties: DatabaseProperty[], propertyId: string): DatabaseView {
  const shown = new Set(cardProperties(view, properties).map((property) => property.id));
  if (shown.has(propertyId)) shown.delete(propertyId);
  else shown.add(propertyId);
  return { ...view, card_properties: properties.map((property) => property.id).filter((id) => shown.has(id)) };
}

/* ── Reading a row ─────────────────────────────────────────────────────── */

/** A day written `YYYY-MM-DD` — a Date value, or the day half of a range. */
export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A day that is real, not just shaped like one: 2026-02-30 is not. */
export function isDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

/** A Date value's start and end. `YYYY-MM-DD` is a single day (`end` empty);
 *  `YYYY-MM-DD/YYYY-MM-DD` is a range, as Notion's — held as one string so a
 *  value stays a string everywhere. Null when it is neither. */
export function dateRange(value: string): { start: string; end: string } | null {
  if (ISO_DAY.test(value)) return { start: value, end: "" };
  const split = value.indexOf("/");
  if (split < 0) return null;
  const start = value.slice(0, split);
  const end = value.slice(split + 1);
  return ISO_DAY.test(start) && ISO_DAY.test(end) ? { start, end } : null;
}

/** The names a multi-select's value holds. It is stored as a JSON list so a
 *  name with a comma survives; a stored name that is not JSON — written
 *  before multi-selects, or by hand — reads as one value, which is how a
 *  Select's value still means something when the column turns multi. */
export function multiValues(value: string): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((name): name is string => typeof name === "string" && Boolean(name));
  } catch {
    // Not JSON: one stored name.
  }
  return [value];
}

export function toMultiValue(names: readonly string[]): string {
  return names.length ? JSON.stringify(names) : "";
}

/* ── Relations ─────────────────────────────────────────────────────────── */

/* A relation property links a row to pages of another database, stored as a
 *  JSON list of page ids (the multi-select's convention). `relation_database`
 *  names the target on every relation property. A forward property also
 *  carries `relation_two_way`, `relation_limit` and `relation_backlink_name`;
 *  the mirror a two-way relation makes on the target carries `relation_origin`
 *  — the forward property's id — instead. */

/** The database a relation property points at ("" — nothing — for a mirror
 *  whose origin is gone). */
export function relationTarget(property: Pick<DatabaseProperty, "relation_database">): string {
  return property.relation_database ?? "";
}

/** The page ids a relation cell holds, in the order they were picked. A
 *  value that is not a JSON list reads as one id, as a multi-select reads a
 *  plain stored name — a limit-1 cell may hold one. */
export function relationIds(value: string): string[] {
  return multiValues(value).filter((id) => id.trim());
}

/** The property a relation writes back to, on the database its values point
 *  at. A one-way relation has none. The forward property's peer is the
 *  mirror its target holds — the property whose `relation_origin` is this
 *  one's id; a mirror's peer is the forward property its `relation_origin`
 *  names. */
export function relationPeer(property: DatabaseProperty, other: DatabaseConfig | undefined): DatabaseProperty | undefined {
  if (!other) return undefined;
  if (property.relation_origin) {
    const peer = other.properties.find((item) => item.id === property.relation_origin);
    return peer?.type === "relation" ? peer : undefined;
  }
  if (!property.relation_two_way) return undefined;
  return other.properties.find((item) => item.type === "relation" && item.relation_origin === property.id);
}

/** The mirror writes a relation cell change owes the other database's rows:
 *  this row's id added under the peer property on every row newly linked,
 *  removed from every one dropped — the two sides written together. `other`
 *  is the database `next` ids belong to. Null for a one-way relation, or a
 *  mirror the other side no longer holds. */
export function relationPeerWrites(
  property: DatabaseProperty,
  other: DatabaseConfig | undefined,
  otherRows: readonly NotePage[],
  rowId: string,
  previous: readonly string[],
  next: readonly string[],
): { peerId: string; writes: RowWrite[] } | null {
  const peer = relationPeer(property, other);
  if (!peer) return null;
  const writes: RowWrite[] = [];
  const linked = new Set(next);
  for (const id of new Set([...previous, ...next])) {
    const row = otherRows.find((item) => item.id === id);
    if (!row) continue;
    const held = relationIds(row.properties?.[peer.id] ?? "");
    const has = held.includes(rowId);
    if (linked.has(id) && !has) writes.push({ rowId: id, value: toMultiValue([...held, rowId]) });
    else if (!linked.has(id) && has) writes.push({ rowId: id, value: toMultiValue(held.filter((item) => item !== rowId)) });
  }
  return { peerId: peer.id, writes };
}

/** The mirror property a two-way relation adds to its target's config —
 *  named `relation_backlink_name`, else the database it points back at. */
export function relationMirrorProperty(
  forward: DatabaseProperty,
  sourceDatabaseId: string,
  sourceTitle: string,
  id: string,
): DatabaseProperty {
  const name = forward.relation_backlink_name?.trim() || sourceTitle.trim() || "Relation";
  return { id, name, type: "relation", relation_database: sourceDatabaseId, relation_origin: forward.id };
}

/* A meta column is read from the row's own record — when it was made and
 *  last touched, by whom, and its id — never from `properties`: there is no
 *  value to write, which is why writing one is refused. (Notion draws the
 *  same columns, equally read-only.) */
export const META_PROPERTY_FIELDS = {
  created_time: "created_at",
  last_edited_time: "updated_at",
  created_by: "created_by",
  last_edited_by: "updated_by",
  id: "id",
} as const;

export type MetaPropertyType = keyof typeof META_PROPERTY_FIELDS;

export function isMetaType(type: string): type is MetaPropertyType {
  return Object.hasOwn(META_PROPERTY_FIELDS, type);
}

export function isMetaProperty(property: Pick<DatabaseProperty, "type">): boolean {
  return isMetaType(property.type);
}

/** The row record's value behind a meta property; "" for any other type. */
function metaValue(row: NotePage, type: MetaPropertyType): string {
  const raw: unknown = row[META_PROPERTY_FIELDS[type]];
  return typeof raw === "string" ? raw : "";
}

/** The options a status, select or multi-select property offers, in their
 *  own order. A status's go To-do, In progress, Complete; a select's and a
 *  multi-select's are whatever was added. */
export function propertyOptions(property: DatabaseProperty): string[] {
  return property.type === "status" ? statusOptions(property).map((option) => option.name) : property.options ?? [];
}

/** What a row shows for a property. A status always shows one of its
 *  options — unset (or holding a name no option has), its default — because
 *  a board has to put the card SOMEWHERE, and the default is what an
 *  untouched task is. A meta property reads the row's record. Every other
 *  property reads as exactly what is stored. */
export function propertyValue(row: NotePage, property: DatabaseProperty): string {
  if (isMetaType(property.type)) return metaValue(row, property.type);
  const raw = row.properties?.[property.id];
  const value = typeof raw === "string" ? raw : "";
  return property.type === "status" ? statusOf(property, value).name : value;
}

/* ── Choosing what a layout hangs on ───────────────────────────────────── */

/** Properties a board can be grouped by: a status always has columns, and a
 *  select has them once it has options. Text and dates would make a column per
 *  distinct value, which is a list with extra steps. */
export function boardGroupableProperties(properties: DatabaseProperty[]): DatabaseProperty[] {
  return properties.filter(
    (property) => property.type === "status" || (property.type === "select" && (property.options?.length ?? 0) > 0),
  );
}

/** Properties a table or list can group its rows by: the board's two, plus
 *  the types whose values come in a small set — a multi-select's options, a
 *  person's, a checkbox's two states and a date's days. Words would make a
 *  group per distinct value. */
export function groupableProperties(properties: DatabaseProperty[]): DatabaseProperty[] {
  return properties.filter((property) => {
    switch (property.type) {
      case "status": return true;
      case "select":
      case "multi_select": return (property.options?.length ?? 0) > 0;
      case "person":
      case "checkbox":
      case "date": return true;
      default: return false;
    }
  });
}

export function boardProperty(view: DatabaseView, properties: DatabaseProperty[]): DatabaseProperty | undefined {
  const groupable = boardGroupableProperties(properties);
  return groupable.find((property) => property.id === view.group_by) ?? groupable[0];
}

/** The property a table or list groups by — the view's choice, when the
 *  database still has it and it still groups. */
export function groupProperty(view: DatabaseView, properties: DatabaseProperty[]): DatabaseProperty | undefined {
  if (view.kind !== "table" && view.kind !== "list") return undefined;
  const property = properties.find((item) => item.id === view.group_by);
  return property && groupableProperties(properties).includes(property) ? property : undefined;
}

export function calendarProperty(view: DatabaseView, properties: DatabaseProperty[]): DatabaseProperty | undefined {
  const dates = properties.filter((property) => property.type === "date");
  return dates.find((property) => property.id === view.date_by) ?? dates[0];
}

/* ── Views ─────────────────────────────────────────────────────────────── */

/** The view a person has open: the one they last chose if it still exists,
 *  otherwise the first. A database always has at least one view. */
export function activeView(config: DatabaseConfig, preferredId?: string): DatabaseView {
  return config.views.find((view) => view.id === preferredId)
    ?? config.views[0]
    ?? { id: "table", name: "Table", kind: "table" };
}

/** A new view of `kind`, plus any property the layout cannot work without.
 *  A board with nothing to group by gets a Status and a calendar with nothing
 *  to place rows by gets a Date — what Notion does, so a new view is never an
 *  empty frame explaining what it needs. */
export function createView(
  id: string,
  kind: DatabaseViewKind,
  config: DatabaseConfig,
  propertyId: () => string,
): { config: DatabaseConfig; view: DatabaseView } {
  let properties = config.properties;
  const view: DatabaseView = {
    id,
    name: availableName(config.views.map((item) => item.name), viewKindLabel(kind)),
    kind,
  };
  if (kind === "board") {
    let group = boardGroupableProperties(properties)[0];
    if (!group) {
      group = createDatabaseProperty(propertyId(), "status", properties);
      properties = [...properties, group];
    }
    view.group_by = group.id;
  }
  if (kind === "calendar") {
    let date = properties.find((property) => property.type === "date");
    if (!date) {
      date = createDatabaseProperty(propertyId(), "date", properties);
      properties = [...properties, date];
    }
    view.date_by = date.id;
  }
  return { config: { ...config, properties, views: [...config.views, view] }, view };
}

/** Turns an existing view into another layout, keeping its name only if the
 *  person had renamed it — a view still called "Table" that is now a board
 *  should say Board. */
export function changeViewKind(
  view: DatabaseView,
  kind: DatabaseViewKind,
  config: DatabaseConfig,
  propertyId: () => string,
): { config: DatabaseConfig; view: DatabaseView } {
  const fresh = createView(view.id, kind, { ...config, views: config.views.filter((item) => item.id !== view.id) }, propertyId);
  const renamed = !VIEW_KINDS.map(viewKindLabel).some((label) => view.name === label || view.name.startsWith(`${label} `));
  const changed: DatabaseView = {
    ...view,
    kind,
    name: renamed ? view.name : fresh.view.name,
    group_by: fresh.view.group_by ?? view.group_by,
    date_by: fresh.view.date_by ?? view.date_by,
  };
  return { config: withView({ ...config, properties: fresh.config.properties }, changed), view: changed };
}

/** A row with values set, over the values it has. */
export function rowValues(row: Pick<NotePage, "properties">, values: Record<string, string>): Pick<NotePage, "properties"> {
  return { properties: { ...(row.properties ?? {}), ...values } };
}

/** What a copy of a column writes on each row that has something in the
 *  original: the same value, or the same pictures, under the copy's id —
 *  as Notion's copy carries its column's values. */
export function copiedColumn(rows: readonly NotePage[], sourceId: string, copy: DatabaseProperty): Array<{ id: string; patch: Partial<Pick<NotePage, "properties" | "property_files">> }> {
  /* A meta column holds nothing to copy — every row already reads its own
   *  record; copying its source's values would freeze each row's moment
   *  into a made-up field. */
  if (isMetaProperty(copy)) return [];
  return rows.flatMap((row): Array<{ id: string; patch: Partial<Pick<NotePage, "properties" | "property_files">> }> => {
    if (copy.type === "image") {
      const files = row.property_files?.[sourceId];
      return files?.length ? [{ id: row.id, patch: { property_files: { ...(row.property_files ?? {}), [copy.id]: files } } }] : [];
    }
    const value = row.properties?.[sourceId];
    return value ? [{ id: row.id, patch: rowValues(row, { [copy.id]: value }) }] : [];
  });
}

export function withView(config: DatabaseConfig, view: DatabaseView): DatabaseConfig {
  return { ...config, views: config.views.map((item) => (item.id === view.id ? view : item)) };
}

/** Removes a view, or returns null when it is the last one: a database with
 *  no view has no way to be looked at, and nothing in the UI could add one. */
export function removeView(config: DatabaseConfig, viewId: string): DatabaseConfig | null {
  if (config.views.length <= 1) return null;
  return { ...config, views: config.views.filter((view) => view.id !== viewId) };
}

export function duplicateView(
  config: DatabaseConfig,
  viewId: string,
  newId: string,
): { config: DatabaseConfig; view: DatabaseView } | null {
  const index = config.views.findIndex((view) => view.id === viewId);
  if (index < 0) return null;
  const source = config.views[index];
  const view: DatabaseView = {
    ...structuredClone(source),
    id: newId,
    name: availableName(config.views.map((item) => item.name), source.name),
  };
  const views = [...config.views];
  views.splice(index + 1, 0, view);
  return { config: { ...config, views }, view };
}

/* ── Sorts ─────────────────────────────────────────────────────────────── */

/** A view's sorts, first key first: those by the row name or by a property
 *  the database still has and can sort by — a property turned into an Image
 *  leaves its sorts in place, sorting nothing. */
export function viewSorts(view: Pick<DatabaseView, "sorts">, properties: readonly DatabaseProperty[]): ViewSort[] {
  return (view.sorts ?? []).filter((sort) => sort.property_id === TITLE_COLUMN
    || properties.some((property) => property.id === sort.property_id && sortable(property)));
}

/** The view ordered by `sorts` (none: in the order rows were added). */
export function withSorts(view: DatabaseView, sorts: readonly ViewSort[]): DatabaseView {
  const next: DatabaseView = { ...view };
  if (sorts.length) next.sorts = sorts.map((sort) => ({ property_id: sort.property_id, direction: sort.direction }));
  else delete next.sorts;
  return next;
}

/** A column's own Sort ascending / descending, from its head (Notion's
 *  shortcut): the column becomes the view's one sort. `null` — the sort the
 *  column is already in, chosen again — takes just that key away. */
export function sortByColumn(
  view: DatabaseView,
  properties: readonly DatabaseProperty[],
  column: string,
  direction: ViewSort["direction"] | null,
): DatabaseView {
  if (direction) return withSorts(view, [{ property_id: column, direction }]);
  return withSorts(view, viewSorts(view, properties).filter((sort) => sort.property_id !== column));
}

/* ── Filters ─────────────────────────────────────────────────────────────
   A view's `filters` are the conditions — and at most one group of them —
   AND-ed together, as Notion's panel builds them: the group keeps its own
   and/or inside. `filter`, the single equality a view held before, stays
   readable as one `is` condition; a write saves `filters` and drops it.
   The operators are each type's own, named as Notion's are. */

const TEXT_OPS = ["contains", "not_contains", "is", "is_not", "is_empty", "is_not_empty"] as const;
const NUMBER_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "is_empty", "is_not_empty"] as const;
const DATE_OPS = ["before", "after", "on_or_before", "on_or_after", "is", "is_empty", "is_not_empty"] as const;
const CHECKBOX_OPS = ["is"] as const;
const OPTION_OPS = ["is", "is_not", "is_empty", "is_not_empty"] as const;
const MULTI_OPS = ["contains", "not_contains", "is_empty", "is_not_empty"] as const;

/** The operators each property type takes a condition with. An Image holds
 *  no words to match — its values live in `property_files` — so it is never
 *  offered. */
export const FILTER_OPS: Record<PropertyType, readonly string[]> = {
  text: TEXT_OPS, url: TEXT_OPS, email: TEXT_OPS, phone: TEXT_OPS,
  person: TEXT_OPS, created_by: TEXT_OPS, last_edited_by: TEXT_OPS, id: TEXT_OPS,
  number: NUMBER_OPS,
  date: DATE_OPS, created_time: DATE_OPS, last_edited_time: DATE_OPS,
  checkbox: CHECKBOX_OPS,
  select: OPTION_OPS, status: OPTION_OPS,
  multi_select: MULTI_OPS,
  relation: MULTI_OPS,
  image: [],
};

/** The operator names as the panel lists them. */
export const FILTER_OP_LABELS: Record<string, string> = {
  contains: "Contains", not_contains: "Does not contain",
  is: "Is", is_not: "Is not",
  is_empty: "Is empty", is_not_empty: "Is not empty",
  eq: "=", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤",
  before: "Before", after: "After", on_or_before: "On or before", on_or_after: "On or after",
};

/** The operators whose condition also takes a value: all but the empties. */
export function filterNeedsValue(op: string): boolean {
  return op !== "is_empty" && op !== "is_not_empty";
}

/** The operator a condition on `type` starts on, as Notion's does. */
export function defaultFilterOp(type: PropertyType): string {
  return FILTER_OPS[type][0];
}

/** Whether a property can take a filter condition at all. */
export function filterable(property: Pick<DatabaseProperty, "type">): boolean {
  return FILTER_OPS[property.type].length > 0;
}

/* A stored `filters` is read no more carefully than a stored `sorts`: items
   that are not conditions or groups fall out. */
function filterItems(view: Pick<DatabaseView, "filter" | "filters">): ViewFilter[] {
  const items: unknown = view.filters;
  if (Array.isArray(items) && items.length) {
    return items.filter((item): item is ViewFilter => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const record = item as { property_id?: unknown; logic?: unknown; conditions?: unknown };
      if (typeof record.property_id === "string") return true;
      return (record.logic === "and" || record.logic === "or") && Array.isArray(record.conditions);
    });
  }
  // A view saved before filters — one equality — is one `is` condition.
  if (view.filter && typeof view.filter.property_id === "string") {
    return [{ property_id: view.filter.property_id, op: "is", value: view.filter.value }];
  }
  return [];
}

/** Every condition a view's filters hold, the group's among them. */
export function filterConditions(view: Pick<DatabaseView, "filter" | "filters">): FilterCondition[] {
  return filterItems(view).flatMap((item) =>
    "conditions" in item && Array.isArray(item.conditions)
      ? item.conditions.filter((condition): condition is FilterCondition => Boolean(condition) && typeof condition.property_id === "string")
      : [item as FilterCondition]);
}

/** How many conditions the filter chip counts. */
export function filterCount(view: Pick<DatabaseView, "filter" | "filters">): number {
  return filterConditions(view).length;
}

/** The view with `map` applied to each of its conditions — the legacy
 *  `filter` among them. A condition `map` drops goes; a group left empty
 *  goes with it, and a view left with nothing stops filtering. Views never
 *  holding either come back untouched. */
export function mapViewFilters(view: DatabaseView, map: (condition: FilterCondition) => FilterCondition | null): DatabaseView {
  const next: DatabaseView = { ...view };
  if (next.filter) {
    const mapped = map({ property_id: next.filter.property_id, op: "is", value: next.filter.value });
    if (mapped) next.filter = { property_id: mapped.property_id, value: mapped.value ?? "" };
    else delete next.filter;
  }
  if (Array.isArray(next.filters)) {
    const items = next.filters.flatMap((item): ViewFilter[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      if ("conditions" in item && Array.isArray(item.conditions)) {
        const conditions = item.conditions.flatMap((condition) => {
          const kept = condition && typeof condition.property_id === "string" ? map(condition) : null;
          return kept ? [kept] : [];
        });
        return conditions.length ? [{ ...item, conditions }] : [];
      }
      const kept = map(item as FilterCondition);
      return kept ? [kept] : [];
    });
    if (items.length) next.filters = items;
    else delete next.filters;
  }
  return next;
}

/** The day a condition compares a cell by: a Date's own day — its range's
 *  start — or the date half of a meta column's timestamp. "" when there is
 *  none, so a value that is no day never compares as one. */
function dayOf(property: DatabaseProperty, value: string): string {
  if (property.type === "date") return dateRange(value)?.start ?? "";
  return value.slice(0, 10);
}

/** Whether `row` passes one condition. A condition whose property is gone
 *  — or cannot take its operator — fails closed: it may have outlived its
 *  meaning, and silently passing it would let rows the filter meant to hide
 *  through with nothing on screen to say so. */
function conditionMatches(row: NotePage, condition: FilterCondition, properties: readonly DatabaseProperty[]): boolean {
  const property = properties.find((item) => item.id === condition.property_id);
  if (!property) return false;
  const op = condition.op ?? defaultFilterOp(property.type);
  if (!FILTER_OPS[property.type].includes(op)) return false;
  const cell = propertyValue(row, property);
  const empty = property.type === "multi_select" ? !multiValues(cell).length
    : property.type === "relation" ? !relationIds(cell).length
    : property.type === "checkbox" ? false // a box is always checked or not
    : !cell;
  if (op === "is_empty") return empty;
  if (op === "is_not_empty") return !empty;
  const operand = condition.value ?? "";
  // An operand-less condition — a row still being built — matches nothing.
  if (!operand) return false;
  // An absent value satisfies an absent operator: "is not" and "does not
  // contain" keep the empty rows, as Notion's do; everything else needs a
  // value to stand against.
  if (empty) return op === "is_not" || op === "not_contains" || op === "neq";
  switch (property.type) {
    case "number": {
      const left = Number(cell);
      const right = Number(operand);
      // A number compares as a number or not at all: "soon" is never 5, and
      // never fails to be ≠ 5 either — only the truly empty are empty.
      if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
      switch (op) {
        case "eq": return left === right;
        case "neq": return left !== right;
        case "gt": return left > right;
        case "gte": return left >= right;
        case "lt": return left < right;
        case "lte": return left <= right;
      }
      return false;
    }
    case "date":
    case "created_time":
    case "last_edited_time": {
      const left = dayOf(property, cell);
      const right = dayOf(property, operand);
      if (!isDay(left) || !isDay(right)) return false;
      switch (op) {
        case "before": return left < right;
        case "after": return left > right;
        case "on_or_before": return left <= right;
        case "on_or_after": return left >= right;
        case "is": return left === right;
      }
      return false;
    }
    case "checkbox":
      // An unchecked box reads "" where the condition's false says it.
      return op === "is" && (cell === "true" ? "true" : "false") === operand;
    case "select":
    case "status":
      return op === "is" ? cell === operand : cell !== operand;
    case "multi_select": {
      const held = multiValues(cell).includes(operand);
      return op === "contains" ? held : !held;
    }
    case "relation": {
      // The operand is a page id, the way the picker writes it.
      const held = relationIds(cell).includes(operand);
      return op === "contains" ? held : !held;
    }
    default: {
      // Words: contains is loose — case aside — and is is exact.
      const lower = cell.toLocaleLowerCase();
      const needle = operand.toLocaleLowerCase();
      switch (op) {
        case "contains": return lower.includes(needle);
        case "not_contains": return !lower.includes(needle);
        case "is": return cell === operand;
        case "is_not": return cell !== operand;
      }
      return false;
    }
  }
}

/** The view's filters, conditions and the group alike — the legacy `filter`
 *  as one `is`. What the filter panel edits. */
export function viewFilters(view: Pick<DatabaseView, "filter" | "filters">): ViewFilter[] {
  return filterItems(view);
}

/** The view's filters as a row test: conditions and groups, all AND-ed. */
export function filtersMatch(row: NotePage, view: Pick<DatabaseView, "filter" | "filters">, properties: readonly DatabaseProperty[]): boolean {
  return filterItems(view).every((item) =>
    "conditions" in item && Array.isArray(item.conditions)
      ? (item.logic === "or"
        ? item.conditions.some((condition) => conditionMatches(row, condition as FilterCondition, properties))
        : item.conditions.every((condition) => conditionMatches(row, condition as FilterCondition, properties)))
      : conditionMatches(row, item as FilterCondition, properties));
}

/** The view filtering by `items` — nothing when empty — its old `filter`
 *  gone either way. */
export function withFilters(view: DatabaseView, items: readonly ViewFilter[]): DatabaseView {
  const next: DatabaseView = { ...view };
  delete next.filter;
  if (items.length) next.filters = items.map((item) => "conditions" in item
    ? { logic: item.logic, conditions: item.conditions.map((condition) => ({ ...condition })) }
    : { ...item });
  else delete next.filters;
  return next;
}

/* ── Rows as a view sees them ──────────────────────────────────────────── */

/* Each type sorts by what it means, not by the string that holds it: a
 *  Number as a number, a Date by its start day, a Checkbox by checked —
 *  unchecked first, so ascending reads the open items first, as Notion's
 *  does — a Multi-select by its first option, the rest by their words.
 *  (Number formats, multi-value rules and grouped types arrive later; this
 *  keeps the order honest in the meantime.) */
function compareValues(property: DatabaseProperty | undefined, left: string, right: string): number {
  if (property && (property.type === "status" || property.type === "select")) {
    // Options sort in the order they are offered, not alphabetically: a status
    // sorted A–Z puts Done before In progress before Not started.
    const options = propertyOptions(property);
    const rank = (value: string) => {
      const index = options.indexOf(value);
      return index < 0 ? options.length : index;
    };
    return rank(left) - rank(right);
  }
  if (property?.type === "number") {
    // The caller sinks what is not a number; numbers compare numerically.
    return Number(left) - Number(right);
  }
  if (property?.type === "checkbox") {
    return (left === "true" ? 1 : 0) - (right === "true" ? 1 : 0);
  }
  if (property?.type === "multi_select") {
    left = multiValues(left)[0] ?? "";
    right = multiValues(right)[0] ?? "";
  } else if (property?.type === "date") {
    // A range sorts from the day it starts.
    left = dateRange(left)?.start ?? left;
    right = dateRange(right)?.start ?? right;
  }
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

/* ── Rows ──────────────────────────────────────────────────────────────── */

/** Where a row stands among its database's rows. */
export function rowKey(page: Pick<NotePage, "row_order" | "created_at">): number {
  return page.row_order ?? (Date.parse(page.created_at) || 0);
}

/* Every database's rows from one pass over the workspace, kept for as long
   as the pages map is — a write makes a new one — so each database drawn
   reads its rows in constant time. */
const rowIndexes = new WeakMap<Record<string, NotePage>, Map<string, NotePage[]>>();

/** A database's rows — the pages it holds, not in the trash — in the order
 *  they were added (`row_order`); ties, by id, the same for everyone. */
export function databaseRows(pages: Record<string, NotePage>, databaseId: string): readonly NotePage[] {
  let index = rowIndexes.get(pages);
  if (!index) {
    index = new Map();
    for (const page of Object.values(pages)) {
      if (!page?.parent_id || page.archived || pages[page.parent_id]?.kind !== "database") continue;
      const rows = index.get(page.parent_id);
      if (rows) rows.push(page);
      else index.set(page.parent_id, [page]);
    }
    for (const rows of index.values()) {
      rows.sort((left, right) => rowKey(left) - rowKey(right) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    }
    rowIndexes.set(pages, index);
  }
  return index.get(databaseId) ?? [];
}

/** Where a copy of `row` goes: right after it, before the row that follows
 *  it — or, the last row, now. */
export function rowOrderAfter(rows: readonly NotePage[], rowId: string, now: number): number {
  const at = rows.findIndex((row) => row.id === rowId);
  if (at < 0) return now;
  const next = rows[at + 1];
  const key = rowKey(rows[at]);
  return next ? (key + rowKey(next)) / 2 : Math.max(now, key + 1);
}

/** Search, filter and sort a database's rows (`databaseRows`) the way
 *  `view` asks. `pageTitle` gives a page's name by id — a relation sorts by
 *  the title of its first link, the way a multi-select sorts by its first
 *  option. */
export function viewRows(
  rows: readonly NotePage[],
  view: DatabaseView,
  properties: DatabaseProperty[],
  query: string,
  pageTitle?: (pageId: string) => string | undefined,
): NotePage[] {
  let next = [...rows];

  const needle = query.trim().toLowerCase();
  if (needle) next = next.filter((page) => page.title.toLowerCase().includes(needle));

  if (filterCount(view)) next = next.filter((page) => filtersMatch(page, view, properties));

  // Rows alike on every key keep the order they were added in: toSorted is
  // stable.
  const keys = viewSorts(view, properties).map((sort) => {
    const property = properties.find((item) => item.id === sort.property_id);
    return {
      property,
      read: (page: NotePage) => {
        if (!property) return page.title;
        const value = propertyValue(page, property);
        // A relation's order is its first link's name — not the stored list
        // of ids, which would read as gibberish sorted or not.
        if (property.type === "relation") return pageTitle?.(relationIds(value)[0] ?? "") ?? "";
        return value;
      },
      sign: sort.direction === "desc" ? -1 : 1,
    };
  });
  if (keys.length) {
    next = next.toSorted((left, right) => {
      for (const { property, read, sign } of keys) {
        const a = read(left);
        const b = read(right);
        // Empty values sink in BOTH directions. An unset date heading an
        // ascending sort is noise, and heading a descending one is worse.
        // A checkbox's "" is not empty, it is unchecked — which sorts FIRST.
        // A number's non-numeric stragglers sink with the empties.
        const empties = property?.type === "checkbox" ? () => false
          : property?.type === "number" ? (value: string) => !value.trim() || Number.isNaN(Number(value))
          : (value: string) => !value;
        if (empties(a) || empties(b)) {
          if (empties(a) !== empties(b)) return empties(a) ? 1 : -1;
          if (empties(a)) continue;
        }
        const order = sign * compareValues(property, a, b);
        if (order) return order;
      }
      return 0;
    });
  }
  return next;
}

/* ── Grouping ──────────────────────────────────────────────────────────── */

/** A group of rows under one group header, as a table or list draws it. */
export interface ViewGroup {
  /** The group's stable key — its value, or "" for the no-value group. */
  key: string;
  /** The value the header shows: an option's name, a day, "true"/"false",
   *  or "" — which the layout renders as "No <property>". */
  value: string;
  /** What a new row in this group should hold in the grouped property, or
   *  null when adding there seeds nothing (the no-value group). */
  seed: string | null;
  rows: NotePage[];
}

/** `rows` — already filtered and sorted — under the headers `view.group_by`
 *  names. Groups follow the property's own order: an optioned type's options
 *  in their order, a checkbox's unchecked first as its sort goes, a date's
 *  days ascending, a person's names sorted. A multi-select row belongs to
 *  every option it holds; a row holding nothing — or a value the property
 *  no longer knows — lands in the last, no-value group. */
export function viewGroups(rows: readonly NotePage[], view: DatabaseView, properties: DatabaseProperty[]): ViewGroup[] {
  const property = groupProperty(view, properties);
  if (!property) return [{ key: "", value: "", seed: null, rows: [...rows] }];

  const bucket = new Map<string, NotePage[]>();
  const add = (key: string, row: NotePage) => {
    const list = bucket.get(key);
    if (list) list.push(row);
    else bucket.set(key, [row]);
  };
  for (const row of rows) {
    const value = propertyValue(row, property);
    if (property.type === "multi_select") {
      const held = multiValues(value);
      // A multi-select row is in every group it names — Notion's own rule,
      // the one place a row shows twice.
      if (held.length) for (const name of held) add(name, row);
      else add("", row);
    } else if (property.type === "checkbox") {
      add(value === "true" ? "true" : "false", row);
    } else if (property.type === "date") {
      add(dateRange(value)?.start ?? "", row);
    } else {
      add(value, row);
    }
  }

  const optioned = property.type === "select" || property.type === "status" || property.type === "multi_select";
  const order: string[] = [];
  if (property.type === "checkbox") order.push("false", "true");
  else if (optioned) order.push(...propertyOptions(property));
  else if (property.type === "date") order.push(...[...bucket.keys()].filter(isDay).sort());
  else order.push(...[...bucket.keys()].filter((key) => key !== "").sort((a, b) => a.localeCompare(b)));
  // Keys the property's own order does not know — an option since renamed
  // away — keep their rows, just ahead of the no-value group.
  for (const key of bucket.keys()) if (key !== "" && !order.includes(key)) order.push(key);
  order.push("");

  return order.flatMap((key) => {
    const held = bucket.get(key) ?? [];
    // The no-value group exists only for the rows that need it; a person's
    // or a date's groups are only those the rows make. An optioned type's
    // stay — empty ones are where a new row is added.
    if (!held.length && (key === "" || !optioned && property.type !== "checkbox")) return [];
    return [{
      key,
      value: key,
      seed: key === "" ? null : property.type === "multi_select" ? toMultiValue([key]) : key,
      rows: held,
    }];
  });
}

/* ── Footer calculations ─────────────────────────────────────────────────
   A table's `calcs` name, per column, which summary runs over the filtered
   rows — the view's own rows, search and filter applied, sorted or not. */

const COUNT_OPS = ["count", "count_unique", "count_empty", "count_not_empty"] as const;

/** The properties a view draws — all but `hidden` names (the row-name
 *  column is not a property, so it can never be hidden). */
export function visibleProperties(view: Pick<DatabaseView, "hidden">, properties: DatabaseProperty[]): DatabaseProperty[] {
  const hidden = new Set(Array.isArray(view.hidden) ? view.hidden : []);
  return properties.filter((property) => !hidden.has(property.id));
}

/** The view with `column` running `kind` in its footer — or nothing, null. */
export function withCalc(view: DatabaseView, column: string, kind: string | null): DatabaseView {
  const calcs: Record<string, string> = { ...(view.calcs ?? {}) };
  if (kind) calcs[column] = kind;
  else delete calcs[column];
  const next: DatabaseView = { ...view };
  if (Object.keys(calcs).length) next.calcs = calcs;
  else delete next.calcs;
  return next;
}

/** The calculation names as the footer menu lists them. */
export const CALC_LABELS: Record<string, string> = {
  count: "Count", count_unique: "Unique", count_empty: "Empty", count_not_empty: "Not empty",
  sum: "Sum", avg: "Average", min: "Min", max: "Max",
  checked: "Checked", unchecked: "Unchecked", percent_checked: "% checked",
  earliest: "Earliest", latest: "Latest",
};

/** The calculations a column offers. The row-name column counts only, and
 *  an Image's values are files — it has none. */
export function calcKinds(column: string, property: DatabaseProperty | undefined): readonly string[] {
  if (column === TITLE_COLUMN || !property) return ["count"];
  switch (property.type) {
    case "number": return ["count", "sum", "avg", "min", "max"];
    case "checkbox": return ["count", "checked", "unchecked", "percent_checked"];
    case "select":
    case "status":
    case "multi_select": return COUNT_OPS;
    case "relation": return ["count", "count_unique"];
    case "date":
    case "created_time":
    case "last_edited_time": return ["count", "earliest", "latest"];
    case "image": return [];
    default: return COUNT_OPS;
  }
}

/** `kind` run over `rows`' cells in `column`: a number's digits, a count, a
 *  day or a timestamp — the footer's words. Null when there is nothing to
 *  say (an average of no numbers), which the footer draws as a dash. */
export function calcValue(
  rows: readonly NotePage[],
  column: string,
  property: DatabaseProperty | undefined,
  kind: string,
): string | null {
  const cells = rows.map((row) => column === TITLE_COLUMN ? row.title : property ? propertyValue(row, property) : "");
  const empty = (value: string) => property?.type === "multi_select" ? !multiValues(value).length
    : property?.type === "checkbox" ? false
    : !value;
  switch (kind) {
    case "count": return String(rows.length);
    case "count_unique": {
      // A multi-select's uniques are its options, a relation's its linked
      // pages, each counted once; a plain column's are its distinct words.
      if (property?.type === "multi_select") {
        const names = new Set<string>();
        for (const cell of cells) for (const name of multiValues(cell)) names.add(name);
        return String(names.size);
      }
      if (property?.type === "relation") {
        const ids = new Set<string>();
        for (const cell of cells) for (const id of relationIds(cell)) ids.add(id);
        return String(ids.size);
      }
      return String(new Set(cells.filter((cell) => !empty(cell))).size);
    }
    case "count_empty": return String(cells.filter(empty).length);
    case "count_not_empty": return String(cells.filter((cell) => !empty(cell)).length);
    case "checked": return String(cells.filter((cell) => cell === "true").length);
    case "unchecked": return String(cells.filter((cell) => cell !== "true").length);
    case "percent_checked": {
      if (!rows.length) return null;
      const checked = cells.filter((cell) => cell === "true").length;
      return `${Math.round((checked / rows.length) * 100)}%`;
    }
    case "sum":
    case "avg":
    case "min":
    case "max": {
      const numbers = cells.map(Number).filter(Number.isFinite);
      if (!numbers.length) return null;
      const value = kind === "sum" ? numbers.reduce((a, b) => a + b, 0)
        : kind === "avg" ? numbers.reduce((a, b) => a + b, 0) / numbers.length
        : kind === "min" ? Math.min(...numbers)
        : Math.max(...numbers);
      // A sum of 1.5 + 2.05 is 3.55, not 3.5500000000000003 — and 4.00 is 4.
      return String(Number(value.toFixed(2)));
    }
    case "earliest":
    case "latest": {
      let best = "";
      for (const cell of cells) {
        if (empty(cell)) continue;
        const key = property?.type === "date" ? dateRange(cell)?.start ?? "" : cell;
        if (!key) continue;
        if (!best || (kind === "earliest" ? key < best : key > best)) best = key;
      }
      return best || null;
    }
  }
  return null;
}

/* ── Calendar arithmetic ───────────────────────────────────────────────── */

/** The days a month view draws: whole weeks, starting on `weekStartsOn`
 *  (0 = Sunday), from the week holding the 1st to the week holding the last
 *  day. Five rows when the month fits in five, six when it does not — a sixth
 *  row of next month's days is 60px a 460px window cannot spare. */
export function monthGrid(year: number, month: number, weekStartsOn = 0): Date[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() - weekStartsOn + 7) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells = Math.ceil((offset + days) / 7) * 7;
  return Array.from({ length: cells }, (_, index) => new Date(year, month, 1 - offset + index));
}

/** The reader's first day of the week, from their locale where the runtime
 *  can say — Monday for most of the world, Sunday for the US. */
export function localeWeekStart(locale: string): number {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const firstDay = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay;
    return typeof firstDay === "number" ? firstDay % 7 : 0;
  } catch {
    return 0;
  }
}

/** A new database whose first view is `kind`, with whatever that layout needs
 *  to be more than an empty frame. `/board` should arrive as a board. */
export function newDatabaseConfig(
  kind: DatabaseViewKind,
  viewId: string,
  propertyId: () => string,
): DatabaseConfig {
  return createView(viewId, kind, { properties: [], views: [] }, propertyId).config;
}
