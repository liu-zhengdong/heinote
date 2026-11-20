import { Check, FileText, Lock } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { DatabaseProperty, NotePage } from "../../core/types";
import { Avatar } from "../../components/Avatar";
import {
  columnWidth,
  databaseRows,
  groupProperty,
  isMetaType,
  multiValues,
  propertyValue,
  relationIds,
  rowImages,
  TITLE_COLUMN,
  titleName,
  viewGroups,
  viewRows,
  visibleProperties,
} from "../database/database-model";
import { formatDay, formatMoment, OptionTag, PropertyIcon, PropertyLink, TitleIcon } from "../database/properties";

/** What the public database view needs of the reader that hosts it: its
 *  pages for relation names, the link a page opens under, and where a file
 *  path's bytes live. The public share answers with its token and
 *  `/api/public/…` addresses; an export answers with paths inside the zip. */
interface PublicDbContext {
  pages: Map<string, NotePage>;
  pageHref(id: string): string | undefined;
  pageTitle(page: NotePage): string;
  /** Where a stored file path's bytes live for this reader. */
  fileHref(path: string): string;
  /** Renders a page's icon as the reader does (image file or emoji). */
  pageIcon?(page: NotePage): ReactNode;
}

/** A row's name cell: its icon and title as the link to the page. */
function NameCell({ row, context }: { row: NotePage; context: PublicDbContext }) {
  const title = context.pageTitle(row);
  return (
    <a className="db__row-name" href={context.pageHref(row.id)}>
      {context.pageIcon ? <span className="db__row-mark">{context.pageIcon(row)}</span> : null}
      <span className="db__row-title" {...(row.title ? {} : { "data-empty": "" })}>{title}</span>
    </a>
  );
}

/** One property cell, read-only — the table's shapes with nothing to type. */
function PublicCell({ row, property, context }: { row: NotePage; property: DatabaseProperty; context: PublicDbContext }) {
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
            const gone = !linked || linked.archived;
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
      return <div className="db__text"><span className="db__cell">{value}</span></div>;
    }
  }
}

/** The header a group's own kind of value asks for: a tag for optioned
 *  properties, the day for dates, the two states for a checkbox — and the
 *  no-value group reading as the property's name. */
function GroupLabel({ group, property }: { group: { value: string; rows: NotePage[] }; property?: DatabaseProperty }) {
  let label: ReactNode = "No value";
  if (property) {
    if (!group.value) label = <span className="grp-h__none">No {property.name}</span>;
    else if (property.type === "select" || property.type === "status" || property.type === "multi_select") label = <OptionTag property={property} value={group.value} />;
    else if (property.type === "checkbox") label = group.value === "true" ? "Checked" : "Unchecked";
    else if (property.type === "date") label = formatDay(group.value);
    else label = group.value;
  }
  return <span className="grp-h"><span className="grp-h__label">{label}</span><span className="grp-h__count">{group.rows.length}</span></span>;
}

/** A shared database as the public reader shows it: the first view as a
 *  table — its own filters, sorts, groups and hidden columns — every cell
 *  read-only, row names opening the row page under the share. The payload
 *  already carries the whole config and the rows' values, so nothing else
 *  is fetched. */
export function PublicDatabase({ database, pages, context }: {
  database: NotePage;
  /** Every page on the share — the rows come from it. */
  pages: NotePage[];
  context: PublicDbContext;
}) {
  const config = database.database;
  const view = config?.views[0];
  const properties = useMemo(() => (config && view ? visibleProperties(view, config.properties) : []), [config, view]);
  const rows = useMemo(() => {
    if (!config || !view) return [];
    const all = Object.fromEntries(pages.map((page) => [page.id, page]));
    const own = databaseRows(all, database.id);
    return viewRows(own, view, config.properties, "", (pageId) => (all[pageId] ? all[pageId].title : undefined));
  }, [config, view, database.id, pages]);
  const groups = useMemo(() => (view && config ? viewGroups(rows, view, config.properties) : [{ key: "", value: "", seed: null, rows }]), [rows, view, config]);
  const groupedBy = view && config ? groupProperty(view, config.properties) : undefined;
  if (!config || !view) return null;

  const rowTr = (row: NotePage) => (
    <tr key={row.id} data-page-id={row.id}>
      <td className="db__name"><NameCell row={row} context={context} /></td>
      {properties.map((property) => <td key={property.id}><PublicCell row={row} property={property} context={context} /></td>)}
    </tr>
  );

  return (
    <div className="db public-reader__db">
      <div className="db__table-wrap scroller">
        <table className="db__table" aria-label={database.title || "Database"}>
          <colgroup>
            <col className="db__name" style={{ width: columnWidth(view, TITLE_COLUMN) ?? 240 }} />
            {properties.map((property) => <col key={property.id} style={{ width: columnWidth(view, property.id) ?? 180 }} />)}
          </colgroup>
          <thead>
            <tr>
              <th className="db__name"><div className="db__th"><TitleIcon icon={config.title_icon} /><span className="db__th-name">{titleName(config)}</span></div></th>
              {properties.map((property) => (
                <th key={property.id}><div className="db__th"><PropertyIcon property={property} /><span className="db__th-name">{property.name}</span></div></th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.length > 1 || groupedBy ? groups.map((group) => (
              <GroupRows key={group.key || "__none__"} group={group} properties={properties} groupedBy={groupedBy} rowTr={rowTr} />
            )) : groups[0]?.rows.map(rowTr)}
            {!rows.length ? (
              <tr><td className="db__name" colSpan={properties.length + 1}><span className="db__row-name account-muted">Empty</span></td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** One group's header row and its rows — a fragment so the table keeps its
 *  single <tbody>. */
function GroupRows({ group, properties, groupedBy, rowTr }: {
  group: { key: string; value: string; rows: NotePage[] };
  properties: DatabaseProperty[];
  groupedBy?: DatabaseProperty;
  rowTr: (row: NotePage) => ReactNode;
}) {
  return (
    <>
      <tr className="grp-row">
        <td className="db__name"><GroupLabel group={group} property={groupedBy} /></td>
        {properties.map((property) => <td key={property.id} />)}
      </tr>
      {group.rows.map(rowTr)}
    </>
  );
}
