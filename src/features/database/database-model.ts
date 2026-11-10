import { COLOR_NAMES, PROPERTY_TYPES as DECLARED_PROPERTY_TYPES, VIEW_KINDS } from "../../../schema";
import { normalizeStoredFile } from "../../core/files";
import type {
  DatabaseConfig,
  DatabaseProperty,
  DatabaseView,
  DatabaseViewKind,
  NotePage,
  OptionColor,
  PropertyType,
  StatusGroup,
  StatusOption,
  StoredFile,
  ViewSort,
} from "../../core/types";
import { capitalized } from "../../core/title";

export const PROPERTY_LABELS: Record<PropertyType, string> = {
  text: "Text",
  status: "Status",
  person: "Person",
  select: "Select",
  date: "Date",
  image: "Image",
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
 *  which is what it reads as while it has no options of its own. */
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
    ...(type === "select" ? { options: [] } : {}),
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

const OPTION_COLOR_SET: ReadonlySet<string> = new Set(OPTION_COLORS);
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
      views: next.views.map((view) => (view.filter?.property_id === propertyId && view.filter.value === option.name
        ? { ...view, filter: { property_id: propertyId, value: clean } }
        : view)),
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
      views: next.views.map((view) => {
        if (view.filter?.property_id !== propertyId || view.filter.value !== option.name) return view;
        const unfiltered = { ...view };
        delete unfiltered.filter;
        return unfiltered;
      }),
    },
    writes: rows.filter((row) => names(option, row.properties?.[propertyId])).map((row) => ({ rowId: row.id, value: "" })),
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
  const held = rows.flatMap((row) => {
    const value = row.properties?.[propertyId];
    return typeof value === "string" && value.trim() ? [value.trim()] : [];
  });
  if (type === "select") {
    const options = [...(current.type === "status" ? statusOptions(current).map((option) => option.name) : current.options ?? [])];
    for (const value of held) {
      if (!options.includes(value)) options.push(value);
    }
    next.options = options;
  }
  if (type === "status") {
    const options = [...statusOptions(current)];
    const ids = new Set(options.map((option) => option.id));
    for (const value of [...(current.type === "select" ? current.options ?? [] : []), ...held]) {
      if (options.length >= MAX_STATUS_OPTIONS) break;
      if (typeof value !== "string" || !value.trim() || options.some((option) => option.name === value)) continue;
      let id = `status-${options.length}`;
      for (let suffix = 2; ids.has(id); suffix += 1) id = `status-${options.length}-${suffix}`;
      ids.add(id);
      options.push({ id, name: value, color: "default", group: "todo" });
    }
    if (options.length !== statusOptions(current).length) next.status_options = inGroupOrder(options);
  }
  const filterable = type === "status" || type === "select";
  return {
    ...config,
    properties: config.properties.map((property) => (property.id === propertyId ? next : property)),
    views: filterable ? config.views : config.views.map((view) => {
      if (view.filter?.property_id !== propertyId) return view;
      const next: DatabaseView = { ...view };
      delete next.filter;
      return next;
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
      const next: DatabaseView = { ...view };
      if (next.filter?.property_id === propertyId) delete next.filter;
      if (Array.isArray(next.sorts) && next.sorts.some((sort) => sort?.property_id === propertyId)) {
        next.sorts = next.sorts.filter((sort) => sort?.property_id !== propertyId);
      }
      if (next.group_by === propertyId) delete next.group_by;
      if (next.date_by === propertyId) delete next.date_by;
      if (next.card_preview === propertyId) delete next.card_preview;
      if (next.card_properties) next.card_properties = next.card_properties.filter((id) => id !== propertyId);
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

/** The options a status or select property offers, in their own order. A
 *  status's go To-do, In progress, Complete; a select has whatever was added. */
export function propertyOptions(property: DatabaseProperty): string[] {
  return property.type === "status" ? statusOptions(property).map((option) => option.name) : property.options ?? [];
}

/** What a row shows for a property. A status always shows one of its
 *  options — unset (or holding a name no option has), its default — because
 *  a board has to put the card SOMEWHERE, and the default is what an
 *  untouched task is. Every other property reads as exactly what is stored. */
export function propertyValue(row: NotePage, property: DatabaseProperty): string {
  const raw = row.properties?.[property.id];
  const value = typeof raw === "string" ? raw : "";
  return property.type === "status" ? statusOf(property, value).name : value;
}

/* ── Choosing what a layout hangs on ───────────────────────────────────── */

/** Properties a board can be grouped by: a status always has columns, and a
 *  select has them once it has options. Text and dates would make a column per
 *  distinct value, which is a list with extra steps. */
export function groupableProperties(properties: DatabaseProperty[]): DatabaseProperty[] {
  return properties.filter(
    (property) => property.type === "status" || (property.type === "select" && (property.options?.length ?? 0) > 0),
  );
}

export function boardProperty(view: DatabaseView, properties: DatabaseProperty[]): DatabaseProperty | undefined {
  const groupable = groupableProperties(properties);
  return groupable.find((property) => property.id === view.group_by) ?? groupable[0];
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
    let group = groupableProperties(properties)[0];
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

/* ── Rows as a view sees them ──────────────────────────────────────────── */

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
 *  `view` asks. */
export function viewRows(
  rows: readonly NotePage[],
  view: DatabaseView,
  properties: DatabaseProperty[],
  query: string,
): NotePage[] {
  let next = [...rows];

  const needle = query.trim().toLowerCase();
  if (needle) next = next.filter((page) => page.title.toLowerCase().includes(needle));

  const filter = view.filter;
  const filtered = filter ? properties.find((property) => property.id === filter.property_id) : undefined;
  if (filter && filtered) next = next.filter((page) => propertyValue(page, filtered) === filter.value);

  // Rows alike on every key keep the order they were added in: toSorted is
  // stable.
  const keys = viewSorts(view, properties).map((sort) => {
    const property = properties.find((item) => item.id === sort.property_id);
    return {
      property,
      read: (page: NotePage) => (property ? propertyValue(page, property) : page.title),
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
        if (!a && b) return 1;
        if (a && !b) return -1;
        const order = sign * compareValues(property, a, b);
        if (order) return order;
      }
      return 0;
    });
  }
  return next;
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
