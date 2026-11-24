import "../database/database.css";
import { Check, ChevronLeft, ChevronRight, FileText, Lock, Search } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { EMPTY_TREE, orderedBlocks } from "../../core/block-tree";
import { inlinePlainText, isoDate } from "../../core/inline-content";
import { imeComposing } from "../../core/keyboard";
import { inTrash } from "../../core/page-tree";
import type { DatabaseProperty, DatabaseView as View, NotePage } from "../../core/types";
import { Avatar } from "../../components/Avatar";
import { pageCover } from "../editor/page-decoration";
import {
  boardProperty,
  CALC_LABELS,
  calendarProperty,
  calcValue,
  cardPreview,
  cardProperties,
  COLUMN_WIDTH,
  columnWidth,
  columnWraps,
  databaseRows,
  dateRange,
  groupProperty,
  isMetaType,
  localeWeekStart,
  monthGrid,
  multiValues,
  propertyName,
  propertyOptions,
  propertyValue,
  relationIds,
  rowImages,
  TITLE_COLUMN,
  titleName,
  viewGroups,
  viewKindLabel,
  viewRows,
  visibleProperties,
  type CardPreview,
  type ViewGroup,
} from "../database/database-model";
import { formatDay, formatMoment, OptionTag, PropertyIcon, PropertyLink, TitleIcon } from "../database/properties";
import { tableEdges } from "../database/table-edges";
import { ViewIcon } from "../database/view-icons";

/** Match TableLayout's default title column width so shared databases size
 *  identically to edit mode inside the `.dbv` inline-size container. */
const TITLE_DEFAULT_WIDTH = "max(168px, min(440px, 48cqi))";

/** What the public database view needs of the reader that hosts it: its
 *  pages for relation names, the link a page opens under, and where a file
 *  path's bytes live. The public share answers with its token and
 *  `/api/public/…` addresses; an export answers with paths inside the zip. */
export interface PublicDbContext {
  pages: Map<string, NotePage>;
  pageHref(id: string): string | undefined;
  pageTitle(page: NotePage): string;
  /** Where a stored file path's bytes live for this reader. */
  fileHref(path: string): string;
  /** Renders a page's icon as the reader does (image file or emoji). */
  pageIcon?(page: NotePage): ReactNode;
}

function previewLines(row: NotePage, lines: number): string[] {
  return orderedBlocks(row.block_tree ?? EMPTY_TREE)
    .map((block) => inlinePlainText(block.content).trim())
    .filter(Boolean)
    .slice(0, lines);
}

/** A row's name cell: its icon and title as the link to the page. An unnamed
 *  row's resolved name is its first line or "无标题" — data-empty's "Untitled"
 *  prefix is only for a row with no name at all, never before a fallback. */
function NameCell({ row, wrap, context }: { row: NotePage; wrap: boolean; context: PublicDbContext }) {
  const title = context.pageTitle(row);
  return (
    <a className={`db__row-name ${wrap ? "is-wrapped" : ""}`} href={context.pageHref(row.id)}>
      {context.pageIcon ? <span className="db__row-icon db__row-mark">{context.pageIcon(row)}</span> : null}
      <span className="db__row-title" {...(title ? {} : { "data-empty": "" })}>{title}</span>
    </a>
  );
}

/** One property cell, read-only — the table's shapes with nothing to type. */
function PublicCell({ row, property, wrap, context }: { row: NotePage; property: DatabaseProperty; wrap: boolean; context: PublicDbContext }) {
  const value = propertyValue(row, property);
  switch (property.type) {
    case "image": {
      const files = rowImages(row, property.id);
      if (!files.length) return null;
      return (
        <span className="db__images" aria-label={property.name}>
          <span className="img-thumbs">{files.map((file) => (
            <span key={file.path} className="img-thumb">
              <img src={context.fileHref(file.preview ?? file.path)} alt={file.name} loading="lazy" />
            </span>
          ))}</span>
        </span>
      );
    }
    case "status":
    case "select":
      return value ? <span className="db__cell db__cell--select"><OptionTag property={property} value={value} /></span> : null;
    case "multi_select": {
      const names = multiValues(value);
      if (!names.length) return null;
      return (
        <span className="db__multi"><span className="db__multi-pills">
          {names.map((name) => <span key={name} className="db__multi-pill"><OptionTag property={property} value={name} /></span>)}
        </span></span>
      );
    }
    case "checkbox":
      return (
        <span className="db__check">
          <span className={`checkbox ${value === "true" ? "is-checked" : ""}`} role="img" aria-label={value === "true" ? "Checked" : "Unchecked"}>
            {value === "true" ? <Check size={12} strokeWidth={3} /> : null}
          </span>
        </span>
      );
    case "person":
      return value ? <span className="db__person"><Avatar name={value} size={20} /><span>{value}</span></span> : null;
    case "relation": {
      const ids = relationIds(value);
      if (!ids.length) return null;
      return (
        <span className="db-rel__list">
          {ids.map((id) => {
            const linked = context.pages.get(id);
            const gone = !linked || inTrash(context.pages, id);
            return gone ? (
              <span key={id} className="db-rel db-rel--ghost"><Lock size={10} aria-hidden="true" /><span className="db-rel__name">No access</span></span>
            ) : (
              <a key={id} className="db-rel" href={context.pageHref(id)}><FileText size={10} aria-hidden="true" /><span className="db-rel__name">{context.pageTitle(linked)}</span></a>
            );
          })}
        </span>
      );
    }
    case "url":
    case "email":
    case "phone":
      return value ? <span className="db__line"><PropertyLink property={property} value={value} /></span> : null;
    case "date":
      return value ? <span className="db__cell db__cell--line">{formatDay(value)}</span> : null;
    case "number":
      return value ? <span className="db__cell db__cell--line db__cell--number">{value}</span> : null;
    default: {
      if (isMetaType(property.type)) {
        const shown = property.type === "created_time" || property.type === "last_edited_time" ? formatMoment(value) : value;
        const who = property.type === "created_by" || property.type === "last_edited_by";
        return (
          <span className="db__meta" data-meta={property.type} title={property.type === "id" ? value : undefined}>
            {who && shown ? <Avatar name={value} size={20} /> : null}
            <span className="db__meta-value">{shown}</span>
          </span>
        );
      }
      return (
        <div className={`db__text ${wrap ? "" : "is-one-line"}`} data-value={value}>
          <span className="db__cell">{value}</span>
        </div>
      );
    }
  }
}

/** Compact property chips for Board / List / Gallery cards — mirrors RowChips
 *  in `views/shared.tsx` without depending on workspace context. */
function PublicRowChips({ row, properties, exclude, limit, context }: {
  row: NotePage;
  properties: DatabaseProperty[];
  exclude?: string;
  limit: number;
  context: PublicDbContext;
}) {
  const chips = properties
    .filter((property) => property.id !== exclude)
    .map((property) => ({ property, value: propertyValue(row, property) }))
    .filter((chip) => (chip.property.type === "image" ? rowImages(row, chip.property.id).length > 0 : Boolean(chip.value)))
    .slice(0, limit);
  if (!chips.length) return null;
  return (
    <span className="db-chips">
      {chips.map(({ property, value }) => {
        if (property.type === "image") {
          const files = rowImages(row, property.id);
          return (
            <span key={property.id} className="img-thumbs">
              {files.slice(0, 3).map((file) => (
                <span key={file.path} className="img-thumb">
                  <img src={context.fileHref(file.preview ?? file.path)} alt={file.name} loading="lazy" />
                </span>
              ))}
              {files.length > 3 ? <span className="img-thumbs__more">+{files.length - 3}</span> : null}
            </span>
          );
        }
        if (property.type === "status" || property.type === "select") {
          return <OptionTag key={property.id} property={property} value={value} />;
        }
        if (property.type === "multi_select") {
          return (
            <span key={property.id} className="db-chip db-chip--multi">
              {multiValues(value).map((name) => <OptionTag key={name} property={property} value={name} />)}
            </span>
          );
        }
        if (property.type === "checkbox") {
          return (
            <span key={property.id} className={`db-chip db-chip--check ${value === "true" ? "is-checked" : ""}`} aria-label={value === "true" ? "Checked" : "Unchecked"}>
              <span className={`checkbox ${value === "true" ? "is-checked" : ""}`}>{value === "true" ? <Check size={11} strokeWidth={3} /> : null}</span>
              {propertyName(property)}
            </span>
          );
        }
        if (property.type === "relation") {
          const ids = relationIds(value);
          return (
            <span key={property.id} className="db-chip db-chip--relation">
              {ids.slice(0, 3).map((id) => {
                const linked = context.pages.get(id);
                const gone = !linked || inTrash(context.pages, id);
                return gone ? (
                  <span key={id} className="db-rel db-rel--ghost"><Lock size={10} aria-hidden="true" /><span className="db-rel__name">No access</span></span>
                ) : (
                  <a key={id} className="db-rel" href={context.pageHref(id)}><FileText size={10} aria-hidden="true" /><span className="db-rel__name">{context.pageTitle(linked)}</span></a>
                );
              })}
              {ids.length > 3 ? <span className="db-rel__name">+{ids.length - 3}</span> : null}
            </span>
          );
        }
        if (property.type === "url" || property.type === "email" || property.type === "phone") {
          return <span key={property.id} className="db-chip"><PropertyLink property={property} value={value} /></span>;
        }
        if (property.type === "created_time" || property.type === "last_edited_time") {
          return <span key={property.id} className="db-chip">{formatMoment(value)}</span>;
        }
        if (property.type === "created_by" || property.type === "last_edited_by" || property.type === "person") {
          return <span key={property.id} className="db-chip"><Avatar name={value} size={16} />{value}</span>;
        }
        return <span key={property.id} className="db-chip">{property.type === "date" ? formatDay(value) : value}</span>;
      })}
    </span>
  );
}

/** The header a group's own kind of value asks for: a tag for optioned
 *  properties, the day for dates, the two states for a checkbox — and the
 *  no-value group reading as the property's name. */
function GroupHead({ group, property, folded, onToggle }: {
  group: ViewGroup;
  property?: DatabaseProperty;
  folded: boolean;
  onToggle?: () => void;
}) {
  let label: ReactNode = "No value";
  if (property) {
    if (!group.value) label = <span className="grp-h__none">No {propertyName(property)}</span>;
    else if (property.type === "select" || property.type === "status" || property.type === "multi_select") label = <OptionTag property={property} value={group.value} />;
    else if (property.type === "checkbox") label = group.value === "true" ? "Checked" : "Unchecked";
    else if (property.type === "person") label = <><Avatar name={group.value} size={16} />{group.value}</>;
    else if (property.type === "date") label = formatDay(group.value);
    else label = group.value;
  }
  if (!onToggle) {
    return <span className="grp-h"><span className="grp-h__label">{label}</span><span className="grp-h__count">{group.rows.length}</span></span>;
  }
  return (
    <div className="grp-h">
      <button
        type="button"
        className="grp-h__toggle"
        aria-expanded={!folded}
        aria-label={`${folded ? "Expand" : "Collapse"} group ${group.value || "No value"}`}
        onClick={onToggle}
      >
        <ChevronRight className={`grp-h__chev ${folded ? "is-closed" : ""}`} size={14} />
        <span className="grp-h__label">{label}</span>
        <span className="grp-h__count">{group.rows.length}</span>
      </button>
    </div>
  );
}

function PublicCalcCell({ column, property, view, rows }: {
  column: string;
  property?: DatabaseProperty;
  view: View;
  rows: readonly NotePage[];
}) {
  const kind = view.calcs?.[column];
  if (!kind) return null;
  const value = calcValue(rows, column, property, kind);
  return (
    <div className="db__th">
      <span className="db__calc">
        <span className="db__calc-fn">{CALC_LABELS[kind] ?? kind}</span>
        <span className={`db__calc-val ${value === null ? "is-empty" : ""}`}>{value ?? "—"}</span>
      </span>
    </div>
  );
}

function PublicTableLayout({ database, view, properties, rows, groups, groupedBy, interactive, context }: {
  database: NotePage;
  view: View;
  properties: DatabaseProperty[];
  rows: NotePage[];
  groups: readonly ViewGroup[];
  groupedBy?: DatabaseProperty;
  interactive: boolean;
  context: PublicDbContext;
}) {
  const config = database.database!;
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const toggleFold = (key: string) => setFolded((held) => {
    const next = new Set(held);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const titleWidth = columnWidth(view, TITLE_COLUMN);
  const title = titleWidth === undefined ? TITLE_DEFAULT_WIDTH : `${titleWidth}px`;
  const widths = properties.map((property) => columnWidth(view, property.id) ?? COLUMN_WIDTH.property);
  const fixed = widths.reduce((sum, width) => sum + width, 0);
  const tableWidth = `max(100%, calc(${title} + ${fixed}px))`;
  const namesWrap = columnWraps(view, TITLE_COLUMN);
  const hasCalcs = Boolean(view.calcs && Object.keys(view.calcs).length);

  const rowTr = (row: NotePage, hidden = false) => (
    <tr key={row.id} data-page-id={row.id} className={hidden ? "is-folded" : undefined}>
      <td className="db__name"><NameCell row={row} wrap={namesWrap} context={context} /></td>
      {properties.map((property) => (
        <td key={property.id}>
          <PublicCell row={row} property={property} wrap={columnWraps(view, property.id)} context={context} />
        </td>
      ))}
    </tr>
  );

  return (
    <div ref={tableEdges} className="db__table-wrap" role="region" tabIndex={0} aria-label={database.title || "Database table"}>
      <table className="db__table" style={{ width: tableWidth }} aria-label={database.title || "Database"}>
        <colgroup>
          <col className="db__name" style={{ width: title }} />
          {properties.map((property, index) => <col key={property.id} style={{ width: widths[index] }} />)}
        </colgroup>
        <thead>
          <tr>
            <th className="db__name"><div className="db__th"><TitleIcon icon={config.title_icon} /><span className="db__th-name">{titleName(config)}</span></div></th>
            {properties.map((property) => (
              <th key={property.id}><div className="db__th"><PropertyIcon property={property} /><span className="db__th-name">{propertyName(property)}</span></div></th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.length > 1 || groupedBy ? groups.map((group) => {
            const isFolded = interactive && folded.has(group.key);
            return (
              <Fragment key={`${groupedBy?.id ?? ""}~${group.key}`}>
                <tr className="grp-row">
                  <td className="db__name">
                    <GroupHead
                      group={group}
                      property={groupedBy}
                      folded={isFolded}
                      onToggle={interactive ? () => toggleFold(group.key) : undefined}
                    />
                  </td>
                  {properties.map((property) => {
                    const kind = view.calcs?.[property.id];
                    const value = kind ? calcValue(group.rows, property.id, property, kind) : null;
                    return <td key={property.id} className={value !== null ? "grp-sum" : undefined}>{value !== null ? <span className="grp-sum__val">{value}</span> : null}</td>;
                  })}
                </tr>
                {group.rows.map((row) => rowTr(row, isFolded))}
              </Fragment>
            );
          }) : rows.map((row) => rowTr(row))}
          {!rows.length ? (
            <tr><td className="db__name" colSpan={properties.length + 1}><span className="db__row-name account-muted">Empty</span></td></tr>
          ) : null}
        </tbody>
        {hasCalcs ? (
          <tfoot>
            <tr>
              <td className="db__name"><PublicCalcCell column={TITLE_COLUMN} view={view} rows={rows} /></td>
              {properties.map((property) => (
                <td key={property.id}><PublicCalcCell column={property.id} property={property} view={view} rows={rows} /></td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

function PublicBoardLayout({ rows, properties, property, context }: {
  rows: NotePage[];
  properties: DatabaseProperty[];
  property: DatabaseProperty;
  context: PublicDbContext;
}) {
  const options = propertyOptions(property);
  const unset = property.type === "select" ? rows.filter((row) => !propertyValue(row, property)) : [];
  const columns = unset.length ? ["", ...options] : options;
  return (
    <div className="board">
      {columns.map((value) => {
        const items = rows.filter((row) => propertyValue(row, property) === value);
        const label = value || `No ${propertyName(property)}`;
        return (
          <section key={value || "none"} className="board__column" aria-label={label}>
            <header className="board__column-head">
              {value ? <OptionTag property={property} value={value} /> : <span className="tag">{label}</span>}
              <span className="board__count">{items.length}</span>
            </header>
            {items.map((row) => {
              const preview = previewLines(row, 1)[0];
              const title = context.pageTitle(row);
              return (
                <div key={row.id} className="board__card" data-page-id={row.id}>
                  <a className="board__card-title" href={context.pageHref(row.id)}>
                    {title || "Untitled"}
                  </a>
                  <PublicRowChips row={row} properties={properties} exclude={property.id} limit={3} context={context} />
                  {preview ? <p>{preview}</p> : null}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

function PublicListLayout({ rows, properties, groups, groupedBy, interactive, context }: {
  rows: NotePage[];
  properties: DatabaseProperty[];
  groups: readonly ViewGroup[];
  groupedBy?: DatabaseProperty;
  interactive: boolean;
  context: PublicDbContext;
}) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const toggleFold = (key: string) => setFolded((held) => {
    const next = new Set(held);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const listRow = (row: NotePage) => {
    const title = context.pageTitle(row);
    return (
      <div key={row.id} className="db-list__row" data-page-id={row.id}>
        <span className="db-list__name">
          {context.pageIcon ? <span className="db-list__icon db__row-mark">{context.pageIcon(row)}</span> : null}
          <a className="db-list__title" href={context.pageHref(row.id)} {...(title ? {} : { "data-empty": "" })}>{title}</a>
        </span>
        <PublicRowChips row={row} properties={properties} limit={properties.length} context={context} />
      </div>
    );
  };

  return (
    <div className="db-list">
      {groups.length > 1 || groupedBy ? groups.map((group) => {
        const isFolded = interactive && folded.has(group.key);
        return (
          <Fragment key={`${groupedBy?.id ?? ""}~${group.key}`}>
            <div className="db-list__group">
              <GroupHead
                group={group}
                property={groupedBy}
                folded={isFolded}
                onToggle={interactive ? () => toggleFold(group.key) : undefined}
              />
            </div>
            {isFolded ? null : group.rows.map(listRow)}
          </Fragment>
        );
      }) : rows.map(listRow)}
      {!rows.length ? <div className="db-list__row"><span className="db-list__name account-muted">Empty</span></div> : null}
    </div>
  );
}

function PublicCardTop({ row, preview, context }: { row: NotePage; preview: CardPreview; context: PublicDbContext }) {
  if (preview.kind === "none") return null;
  if (preview.kind === "image") {
    const files = rowImages(row, preview.property.id);
    const first = files[0];
    return (
      <span className={`db-card__preview ${first ? "db-card__preview--cover" : "is-blank"}`} aria-hidden="true">
        {first ? (
          <img className="db-card__cover-image" src={context.fileHref(first.preview ?? first.path)} alt="" loading="lazy" />
        ) : (
          <span className="db-card__glyph">{context.pageIcon ? context.pageIcon(row) : <FileText size={22} strokeWidth={1.5} />}</span>
        )}
      </span>
    );
  }
  const blank = <span className="db-card__glyph">{context.pageIcon ? context.pageIcon(row) : <FileText size={22} strokeWidth={1.5} />}</span>;
  if (preview.kind === "cover") {
    const cover = pageCover(row);
    if (cover?.kind === "image") {
      return (
        <span className="db-card__preview db-card__preview--cover" aria-hidden="true">
          <img className="db-card__cover-image" src={context.fileHref(cover.file.preview ?? cover.file.path)} alt="" loading="lazy" />
        </span>
      );
    }
    const background = cover?.background;
    return (
      <span className={`db-card__preview ${background ? "db-card__preview--cover" : "is-blank"}`} style={background ? { background } : undefined} aria-hidden="true">
        {background ? null : blank}
      </span>
    );
  }
  const lines = previewLines(row, 4);
  return (
    <span className={`db-card__preview ${lines.length ? "" : "is-blank"}`} aria-hidden="true">
      {lines.length ? lines.map((line, index) => <span key={index}>{line}</span>) : blank}
    </span>
  );
}

function PublicGalleryLayout({ rows, properties, preview, context }: {
  rows: NotePage[];
  properties: DatabaseProperty[];
  preview: CardPreview;
  context: PublicDbContext;
}) {
  return (
    <div className={`db-gallery ${preview.kind === "none" ? "db-gallery--bare" : ""}`}>
      {rows.map((row) => {
        const title = context.pageTitle(row);
        return (
          <div key={row.id} className="db-card" data-page-id={row.id}>
            <PublicCardTop row={row} preview={preview} context={context} />
            <span className="db-card__body">
              <a className="db-card__title" href={context.pageHref(row.id)}>
                {title || "Untitled"}
              </a>
              <PublicRowChips
                row={row}
                properties={properties}
                exclude={preview.kind === "image" ? preview.property.id : undefined}
                limit={properties.length}
                context={context}
              />
            </span>
          </div>
        );
      })}
      {!rows.length ? <p className="account-muted">Empty</p> : null}
    </div>
  );
}

function PublicCalendarLayout({ rows, property, interactive, context }: {
  rows: NotePage[];
  property: DatabaseProperty;
  interactive: boolean;
  context: PublicDbContext;
}) {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const lang = typeof navigator !== "undefined" ? navigator.language : "en";
  const weekStart = useMemo(() => localeWeekStart(lang), [lang]);
  const days = monthGrid(cursor.year, cursor.month, weekStart);
  const today = isoDate(new Date());

  const byDay = useMemo(() => {
    const map = new Map<string, NotePage[]>();
    for (const row of rows) {
      const value = propertyValue(row, property);
      const start = dateRange(value)?.start;
      if (!start) continue;
      map.set(start, [...(map.get(start) ?? []), row]);
    }
    return map;
  }, [property, rows]);

  const month = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" })
    .format(new Date(cursor.year, cursor.month, 1));
  const weekdays = days.slice(0, 7).map((day) => new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(day));
  const step = (delta: number) => setCursor(({ year, month: current }) => {
    const next = new Date(year, current + delta, 1);
    return { year: next.getFullYear(), month: next.getMonth() };
  });

  return (
    <div className="db-cal">
      <div className="db-cal__bar">
        <strong className="db-cal__month">{month}</strong>
        {interactive ? (
          <span className="db-cal__nav">
            <button type="button" className="icon-btn icon-btn--sm" aria-label="Previous month" onClick={() => step(-1)}>
              <ChevronLeft size={15} />
            </button>
            <button
              type="button"
              className="btn db-cal__today"
              onClick={() => {
                const now = new Date();
                setCursor({ year: now.getFullYear(), month: now.getMonth() });
              }}
            >
              Today
            </button>
            <button type="button" className="icon-btn icon-btn--sm" aria-label="Next month" onClick={() => step(1)}>
              <ChevronRight size={15} />
            </button>
          </span>
        ) : null}
      </div>
      <div className="db-cal__grid" role="grid" aria-label={month}>
        {weekdays.map((weekday) => <span key={weekday} className="db-cal__weekday" role="columnheader">{weekday}</span>)}
        {days.map((day) => {
          const key = isoDate(day);
          const items = byDay.get(key) ?? [];
          const outside = day.getMonth() !== cursor.month;
          const label = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric" }).format(day);
          return (
            <div
              key={key}
              role="gridcell"
              aria-label={label}
              className={`db-cal__day ${outside ? "is-outside" : ""} ${key === today ? "is-today" : ""}`}
            >
              <span className="db-cal__date">{day.getDate()}</span>
              {items.slice(0, 3).map((row) => (
                <a key={row.id} className="db-cal__item" data-page-id={row.id} href={context.pageHref(row.id)}>
                  {context.pageTitle(row) || "Untitled"}
                </a>
              ))}
              {items.length > 3 ? <span className="db-cal__more">+{items.length - 3} more</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A shared database as the public reader (and HTML export) shows it: every
 *  view — table, board, list, gallery and calendar — rendered with the same
 *  `.db` / `.dbv` layout furniture, column widths, wrap rules and summary
 *  calculations as edit mode, all read-only, row names opening their page
 *  under the share. */
export function PublicDatabase({ database, pages, context, interactive = true }: {
  database: NotePage;
  /** Every page on the share — the rows come from it. */
  pages: NotePage[];
  context: PublicDbContext;
  /** False in static HTML exports where no client runtime hydrates controls. */
  interactive?: boolean;
}) {
  const config = database.database;
  const views = config?.views ?? [];
  const [selectedViewId, setSelectedViewId] = useState<string>(() => views[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);

  const view = views.find((item) => item.id === selectedViewId) ?? views[0];

  useEffect(() => {
    if (!interactive || !tabsRef.current) return;
    const activeTab = tabsRef.current.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest", container: "nearest" } as ScrollIntoViewOptions);
  }, [interactive, view?.id]);

  const properties = useMemo(() => (config && view ? visibleProperties(view, config.properties) : []), [config, view]);
  const rows = useMemo(() => {
    if (!config || !view) return [];
    const all = Object.fromEntries(pages.map((page) => [page.id, page]));
    const own = databaseRows(all, database.id);
    return viewRows(own, view, config.properties, query, (pageId) => (all[pageId] ? all[pageId].title : undefined));
  }, [config, view, database.id, pages, query]);
  const groups = useMemo(() => (view && config ? viewGroups(rows, view, config.properties) : [{ key: "", value: "", seed: null, rows }]), [rows, view, config]);
  const groupedBy = view && config ? groupProperty(view, config.properties) : undefined;
  if (!config || !view) return null;

  const board = boardProperty(view, config.properties);
  const dates = calendarProperty(view, config.properties);
  const showTabs = views.length > 1;
  const showToolbar = showTabs || interactive;

  const onTabKeyDown = (index: number) => (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (imeComposing(event)) return;
    const next = event.key === "ArrowRight" ? (index + 1) % views.length
      : event.key === "ArrowLeft" ? (index + views.length - 1) % views.length
      : event.key === "Home" ? 0
      : event.key === "End" ? views.length - 1
      : null;
    if (next === null) return;
    event.preventDefault();
    setSelectedViewId(views[next].id);
    tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  let layout: ReactNode;
  if (view.kind === "board" && board) {
    layout = <PublicBoardLayout rows={rows} properties={properties} property={board} context={context} />;
  } else if (view.kind === "list") {
    layout = (
      <PublicListLayout
        rows={rows}
        properties={properties}
        groups={groups}
        groupedBy={groupedBy}
        interactive={interactive}
        context={context}
      />
    );
  } else if (view.kind === "gallery") {
    layout = (
      <PublicGalleryLayout
        rows={rows}
        properties={cardProperties(view, config.properties).filter((property) => !view.hidden?.includes(property.id))}
        preview={cardPreview(view, config.properties)}
        context={context}
      />
    );
  } else if (view.kind === "calendar" && dates) {
    layout = <PublicCalendarLayout rows={rows} property={dates} interactive={interactive} context={context} />;
  } else {
    layout = (
      <PublicTableLayout
        database={database}
        view={view}
        properties={properties}
        rows={rows}
        groups={groups}
        groupedBy={groupedBy}
        interactive={interactive}
        context={context}
      />
    );
  }

  return (
    <div className="db public-reader__db">
      <div className="dbv dbv--page dbv--readonly">
        {showToolbar ? (
          <div className="db__toolbar">
            {showTabs ? (
              <div className="db__tabs">
                <div className="db__views" role="tablist" aria-label="Views" ref={tabsRef}>
                  {views.map((item, index) => {
                    const active = item.id === view.id;
                    return (
                      <button
                        type="button"
                        role="tab"
                        key={item.id}
                        aria-selected={active}
                        tabIndex={active ? 0 : -1}
                        className={`view-tab ${active ? "is-active" : ""}`}
                        onClick={() => setSelectedViewId(item.id)}
                        onKeyDown={onTabKeyDown(index)}
                      >
                        <ViewIcon kind={item.kind} />
                        <span className="view-tab__name">{item.name || viewKindLabel(item.kind)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : <div className="db__tabs" />}
            {interactive ? (
              <div className="db__tools">
                <input
                  ref={searchRef}
                  className={`db__search ${searchOpen ? "is-open" : ""}`}
                  value={query}
                  aria-label="Search this database"
                  placeholder="Search…"
                  tabIndex={searchOpen ? 0 : -1}
                  onChange={(event) => setQuery(event.target.value)}
                  onBlur={() => { if (!query) setSearchOpen(false); }}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape" || imeComposing(event)) return;
                    setQuery("");
                    setSearchOpen(false);
                  }}
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Search this database"
                  title="Search"
                  onClick={() => {
                    setSearchOpen((open) => !open);
                    window.setTimeout(() => searchRef.current?.focus(), 60);
                  }}
                >
                  <Search size={16} />
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {layout}
      </div>
    </div>
  );
}
