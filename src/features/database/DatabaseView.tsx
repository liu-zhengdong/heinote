import "./database.css";
import {
  ArrowDown,
  ArrowDownAZ,
  ArrowUp,
  ArrowUpRight,
  ChevronDown,
  Copy,
  Eye,
  Filter,
  Layers,
  List,
  MoreHorizontal,
  Maximize2,
  Minimize2,
  Plus,
  Search,
  SlidersHorizontal,
  Table,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { MenuDivider, MenuItem, MenuList } from "../../components/Menu";
import { Popover } from "../../components/Popover";
import { Tooltip } from "../../components/Tooltip";
import { imeComposing } from "../../core/keyboard";
import { pointRect, rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import { pageName } from "../../core/block-tree";
import { createId } from "../../core/ids";
import { isoDate } from "../../core/inline-content";
import { titleFields } from "../../core/title";
import type { WorkspaceMutation } from "../../platform/workspace-document";
import type {
  DatabaseConfig,
  DatabaseProperty,
  DatabaseView as View,
  DatabaseViewKind,
  InlineContent,
  NotePage,
  PropertyType,
  ViewFilter,
  ViewSort,
} from "../../core/types";
import { useWorkspace, type PagePatch } from "../../app/workspace-context";
import { useUi } from "../../app/ui-context";
import {
  activeView,
  addSelectOption,
  addStatusOption,
  boardGroupableProperties,
  boardProperty,
  calendarProperty,
  cardPreview,
  cardProperties,
  changePropertyType,
  changeViewKind,
  columnWraps,
  copiedColumn,
  createView,
  databaseRows,
  duplicateProperty,
  duplicateView,
  filterable as columnFilterable,
  filterConditions,
  filterCount,
  groupableProperties,
  groupProperty,
  insertProperty,
  isMetaType,
  moveProperty,
  moveRowOrder,
  moveStatusOption,
  PROPERTY_LABELS,
  PROPERTY_TYPES,
  propertyName,
  recolorSelectOption,
  recolorStatusOption,
  removeProperty,
  removeSelectOption,
  removeStatusOption,
  removeView,
  relationMirrorProperty,
  renameProperty,
  renameSelectOption,
  renameStatusOption,
  rowValues,
  setDefaultStatus,
  setPropertyIcon,
  sortable,
  sortByColumn,
  TITLE_COLUMN,
  titleName,
  toMultiValue,
  viewFilters,
  viewGroups,
  viewKindLabel,
  viewRows,
  viewSorts,
  visibleProperties,
  withCalc,
  withColumnWidth,
  withColumnWrap,
  withFilters,
  withSorts,
  withView,
  type RowWrite,
} from "./database-model";
import { PropertyIcon, TitleIcon, TypeIcon } from "./properties";
import { PropertyMenu, type RelationEditing } from "./PropertyMenu";
import type { SelectEditing, StatusEditing } from "./StatusOptions";
import { SortPanel, type SortColumn } from "./SortPanel";
import { FilterPanel, type FilterColumn } from "./FilterPanel";
import { ColumnsPanel } from "./ColumnsPanel";
import * as columnIcons from "./property-icons";
import { provideIcons } from "./property-icon-store";
import { useHomedImages } from "./ImageProperty";
import { databaseConvertible, databaseToBlocks } from "./convert";
import { ordersBetween } from "../editor/editor-commands";
import { RemoteCarets } from "../editor/RemoteCarets";
import { inTrash, isBareRow, isPurging, spaceOfPage } from "../../core/page-tree";
import { relationPeerMutations } from "./relation";
import { pagePatchMutations } from "../../app/page-mutations";
import { useHomedCovers } from "../editor/CoverImage";
import { useHomedIcons } from "../editor/PageIcon";
import { sameItems, usePage, useWorkspaceState } from "../../app/workspace-store";
import { VIEW_KINDS } from "../../../schema";
import { BoardLayout } from "./views/BoardLayout";
import { CalendarLayout } from "./views/CalendarLayout";
import { GalleryLayout, GallerySettings } from "./views/GalleryLayout";
import { ListLayout } from "./views/ListLayout";
import { TableLayout } from "./views/TableLayout";
import type { CardEditing, LayoutProps, RenameCaret, RowRenaming } from "./views/shared";

// The marks columns can wear come with the database, drawn from its first table.
provideIcons(columnIcons);

/* The view marks live in a module of their own, so a menu that only names
   views does not pull this file into its chunk; re-exported for the places
   that found them here. */
import { ViewIcon } from "./view-icons";
export { ViewIcon };

/* ── The database ──────────────────────────────────────────────────────── */

type MenuState =
  | { kind: "filter" | "sort" | "group" | "columns" | "property" | "add-view" | "views"; anchor: AnchorRect }
  /* The database a new relation column links to, picked before it is made. */
  | { kind: "relation-target"; anchor: AnchorRect; index: number }
  | { kind: "view"; anchor: AnchorRect; viewId: string }
  /* A row's menu, opened where it was right-clicked in any view. */
  | { kind: "row"; anchor: AnchorRect; rowId: string }
  /* A column's menu: a property's id, or TITLE_COLUMN. With no anchor yet it
     is for a column just made, opened under its head once the head is drawn. */
  | { kind: "column"; column: string; anchor: AnchorRect | null };

/** Scrolls the table sideways, when it must, so a column's head is in full
 *  view beside the name column that stays put — a column put at the far end
 *  of a wide table is opened where it can be seen. The table only: never the
 *  page around it. */
function revealColumn(head: HTMLElement): void {
  const wrap = head.closest<HTMLElement>(".db__table-wrap");
  if (!wrap) return;
  const pinned = wrap.querySelector<HTMLElement>("th.db__name")?.offsetWidth ?? 0;
  const left = head.offsetLeft;
  const right = left + head.offsetWidth;
  if (left < wrap.scrollLeft + pinned) wrap.scrollLeft = Math.max(0, left - pinned);
  else if (right > wrap.scrollLeft + wrap.clientWidth) wrap.scrollLeft = right - wrap.clientWidth;
}

/** A database, drawn the same way wherever it appears: as a page of its own,
 *  or inline inside a document. Everything below the title is this component,
 *  so the two can never drift into two different databases.
 *
 *  Views are the database's (shared); which one is open is the reader's
 *  (personal, remembered per database); the search box is this instance's. */
export function DatabaseView({
  databaseId,
  variant,
  readOnly: heldReadOnly = false,
  title,
  pinnedViewId,
}: {
  databaseId: string;
  variant: "page" | "inline";
  /** Nothing changed from here, even for someone who may change it: shown
   *  "Read only here", or in an old version of the page. */
  readOnly?: boolean;
  /** An inline database's name, drawn at the start of its toolbar's row; on
   *  its own page the name is the page's. */
  title?: ReactNode;
  /** A linked view's one view, by id: drawn always, pinned on the link —
   *  no tabs to switch with, and nothing here is changed. */
  pinnedViewId?: string;
}) {
  const { document, preferences, setPreference, updatePage: writePage, createPage, selectPage, archivePage, canEdit, commitWrites, platform, loadPages } = useWorkspace();
  const { peekPageId, openPeek, closePeek, toast } = useUi();
  /* Someone who can only view a shared database reads it, switches between
     its views (which view is open is theirs), filters nothing and changes
     nothing: every write it would send would be refused. A database shown
     "Read only here" is read the same way, whoever reads it. A linked view
     is drawn read-only for everyone — the link shows the database, it does
     not offer it for editing. */
  const readOnly = heldReadOnly || Boolean(pinnedViewId) || !canEdit(databaseId);
  const updatePage = (pageId: string, patch: PagePatch) => { if (!readOnly) writePage(pageId, patch); };
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // The row whose name is being typed — a table's or a list's row, or a card.
  const [renaming, setRenaming] = useState<{ id: string; caret: RenameCaret } | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  /* The database and its rows, each redrawn only when it changes: typing in
     a page elsewhere leaves every database as it is. */
  const database = usePage(databaseId);
  const allRows = useWorkspaceState((state) => databaseRows(state.pages, databaseId), sameItems);
  /* A database's visible rows load immediately; deeper slices pull on demand
     when opened, peeked, or exported (UC-56). */
  useEffect(() => { if (allRows.length) loadPages(allRows.slice(0, 40).map((row) => row.id)); }, [allRows, loadPages]);
  // The rows that are their values alone, which show no page mark.
  const bareIds = useWorkspaceState((state) => databaseRows(state.pages, databaseId).filter((row) => isBareRow(state.pages, row)).map((row) => row.id), sameItems);
  const bare = useMemo(() => new Set(bareIds), [bareIds]);
  // The row open in the side peek, when it is one of these.
  const peeked = useWorkspaceState((state) => {
    const row = peekPageId ? state.pages[peekPageId] : undefined;
    return row && row.parent_id === databaseId && !row.archived && !isPurging(state.pages, row.id) ? row.id : null;
  });
  const config = database?.database;
  /* A linked view pins its view on the link — which it is belongs to the
     page that carries it, never to the reader's remembered view. */
  const view = config
    ? (pinnedViewId ? config.views.find((item) => item.id === pinnedViewId) ?? null
      : activeView(config, preferences.database_views[databaseId]))
    : null;
  const properties = useMemo(() => config?.properties ?? [], [config]);
  /* Every row's pictures are where the database's readers can reach them,
     whichever view is open: shared from here or from any page above, the
     database's space changes, and the pictures follow. */
  const space = useWorkspaceState((state) => spaceOfPage(state.pages, databaseId));
  useHomedImages(allRows, properties, space);
  useHomedCovers(allRows, space);
  useHomedIcons(allRows, space);

  const rows = useMemo(() => {
    if (!config || !view) return [];
    // A relation's sort key is the first linked page's title.
    return viewRows(allRows, view, properties, deferredQuery, (pageId) => document?.state.pages[pageId]?.title);
  }, [allRows, config, deferredQuery, document, properties, view]);

  // What the view hides: the columns table, list and gallery never draw.
  const shown = useMemo(() => (view ? visibleProperties(view, properties) : properties), [view, properties]);
  /* The groups a table or list draws — one unnamed group when it groups by
     nothing, so the layouts draw plainly either way. */
  const groupedBy = view ? groupProperty(view, properties) : undefined;
  const groups = useMemo(() => (view ? viewGroups(rows, view, properties) : []), [rows, view, properties]);

  const viewId = view?.id;
  useEffect(() => {
    // Scroll the strip by hand rather than `scrollIntoView`, which would also
    // scroll the document to bring an inline database into view — moving the
    // page under the reader because someone else switched a view.
    const strip = tabsRef.current;
    const tab = strip?.querySelector<HTMLElement>(".view-tab.is-active");
    if (!strip || !tab) return;
    const left = tab.offsetLeft - strip.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < strip.scrollLeft) strip.scrollLeft = left - 8;
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth + 8;
  }, [viewId, config?.views.length]);

  /* A column just made — added, or put in beside another — opens its menu
     with its name ready to type over, as Notion's does. Its head is drawn
     only once the write that made it has come back as state, so the menu is
     anchored here, after that render, rather than where it was asked for. */
  const pendingColumn = menu?.kind === "column" && !menu.anchor ? menu.column : null;
  useLayoutEffect(() => {
    if (!pendingColumn) return;
    const head = rootRef.current?.querySelector<HTMLElement>(`th[data-column="${CSS.escape(pendingColumn)}"]`);
    if (head) {
      revealColumn(head);
      setMenu({ kind: "column", column: pendingColumn, anchor: rectOf(head) });
    } else if (properties.some((property) => property.id === pendingColumn)) {
      // Made, but not drawn as a column here (not a table): nothing to open under.
      setMenu(null);
    }
  }, [pendingColumn, properties]);

  /* A column's menu stays only as long as its column: one someone else
     deleted, or that undo took back, closes. */
  const columnMenu = menu?.kind === "column" && menu.anchor ? { column: menu.column, anchor: menu.anchor } : null;
  const menuColumn = columnMenu?.column ?? null;
  const columnGone = Boolean(menuColumn && menuColumn !== TITLE_COLUMN && !properties.some((property) => property.id === menuColumn));
  useEffect(() => {
    if (columnGone) setMenu(null);
  }, [columnGone]);

  /* A linked view's view gone (deleted since the link named it) keeps its
     place as a named absence, where the view was drawn — the database's own
     "no view" stays silent, as before. */
  if (!database || !config) return null;
  if (!view) {
    return pinnedViewId ? (
      <div className="dbv dbv--inline dbv--readonly">
        <div className="dbv-missing"><Table2 size={15} />This view no longer exists</div>
      </div>
    ) : null;
  }

  /* The properties a condition can name — everything but pictures — and the
     count the filter chip wears. */
  const filterable = properties.filter(columnFilterable);
  const filterColumns: FilterColumn[] = filterable.map((property) => ({ id: property.id, label: propertyName(property), icon: <PropertyIcon property={property} /> }));
  const filters = filterCount(view);
  const hiddenColumns = Array.isArray(view.hidden) ? view.hidden.length : 0;
  const groupable = groupableProperties(properties);
  const titleLabel = titleName(config);
  /* The columns a view can be sorted by — the row names first, as in its
     table — and the keys it is sorted by now, first key first. */
  const sortColumns: SortColumn[] = [
    { id: TITLE_COLUMN, label: titleLabel, icon: <TitleIcon icon={config.title_icon} /> },
    ...properties.filter(sortable).map((property) => ({ id: property.id, label: propertyName(property), icon: <PropertyIcon property={property} /> })),
  ];
  const sorts = viewSorts(view, properties);
  const sortNames = sorts.map((sort) => sortColumns.find((column) => column.id === sort.property_id)?.label ?? "");
  // One key names its column, as Notion's chip does; several say how many.
  const sortLabel = sorts.length > 1 ? `${sorts.length} sorts` : sortNames[0];
  const sortTitle = sorts.length ? `Sorted by ${sortNames.join(", then ")}` : "Sort";
  const menuView = menu?.kind === "view" ? config.views.find((item) => item.id === menu.viewId) : undefined;
  const menuProperty = menuColumn && menuColumn !== TITLE_COLUMN ? properties.find((property) => property.id === menuColumn) : undefined;
  const newPropertyId = () => createId("property");
  /* Minimal is a table's way of being drawn; the same view turned into a
     board keeps the setting for when it is a table again. */
  const minimal = view.kind === "table" && Boolean(view.minimal);
  /* Inline in a document, a minimal table's toolbar keeps to the view's name
     until the table is approached, so at rest the page reads as words and a
     table. It stays up while anything in it is in use — a menu, a search — or
     while a filter hides rows, which nothing else on screen would say. */
  const quiet = minimal && variant === "inline" && !menu && !searchOpen && !query && !filters;

  const saveConfig = (next: DatabaseConfig) => updatePage(databaseId, { database: next });
  const saveView = (next: View) => saveConfig(withView(config, next));
  const openView = (viewId: string) => setPreference("database_views", { ...preferences.database_views, [databaseId]: viewId });

  /* A panel row and a table head both report a reorder as a column landing
     at a neighbour's side. The index moveProperty counts — inside the
     dragged column's own kind, the dragged column already out — follows
     from the boundary among what stays, so a hidden column a head never
     drew is found for it here, not by the layout that saw only the view. */
  const reorderProperty = (propertyId: string, boundaryId: string, place: "before" | "after") => {
    const moving = config.properties.find((property) => property.id === propertyId);
    const boundary = config.properties.find((property) => property.id === boundaryId);
    if (!moving || !boundary) return;
    const meta = isMetaType(moving.type);
    const rest = config.properties.filter((property) => property.id !== propertyId && isMetaType(property.type) === meta);
    const at = rest.findIndex((property) => property.id === boundaryId);
    if (at < 0) return;
    saveConfig(moveProperty(config, propertyId, at + (place === "after" ? 1 : 0)));
  };

  /* A dragged row lands between two neighbours: its `row_order` takes the
     gap's midpoint — the whole database's rows bound the gap, so a row the
     view hides still counts. A drop into a group — a board's column, or a
     table's or list's group — writes the group's value to the row in the
     same commit, so the move and the reseeding are one undo. */
  const reorderRow = (rowId: string, boundaryId: string | null, place: "before" | "after", seed?: { propertyId: string; value: string }) => {
    if (readOnly) return;
    const moved = moveRowOrder(allRows, rowId, boundaryId, place, Date.now());
    if (!moved && !seed) return;
    const pages = document?.state.pages ?? {};
    const patch: PagePatch = {};
    if (seed) Object.assign(patch, rowValues(allRows.find((row) => row.id === rowId)!, { [seed.propertyId]: seed.value }));
    if (moved) patch.row_order = moved.row_order;
    const mutations = pagePatchMutations(pages, author, rowId, patch);
    if (moved?.rewrite) {
      for (const [id, order] of Object.entries(moved.rewrite)) {
        if (id !== rowId) mutations.push(...pagePatchMutations(pages, author, id, { row_order: order }));
      }
    }
    if (mutations.length) commitWrites(mutations);
  };
  /* A row may be dragged into order only while the view draws them all in
     their own order: no sort to overrule it, no filter or search to hide
     part of the sequence it would be dropped into. */
  const reorderable = !readOnly && sorts.length === 0 && filters === 0 && !deferredQuery;

  const addView = (kind: DatabaseViewKind) => {
    const created = createView(createId("view"), kind, config, newPropertyId);
    saveConfig(created.config);
    openView(created.view.id);
    setMenu(null);
  };

  const changeLayout = (target: View, kind: DatabaseViewKind) => {
    saveConfig(changeViewKind(target, kind, config, newPropertyId).config);
  };

  /* A relation cell's write is two-sided: its own row's value, and the
     mirror cells its picks gain or lose on the target database — one commit
     for both, so an undo takes the pair back together. The mirror side is
     written only where this person may write it. */
  const author = platform?.bootstrap.user.displayName ?? "";
  const relationPeersOf = (property: DatabaseProperty, rowId: string, previous: string, next: string) => {
    const pages = document?.state.pages ?? {};
    const peer = relationPeerMutations(pages, author, property, rowId, previous, next);
    return peer && (peer.target.id === databaseId || canEdit(peer.target.id)) ? peer.mutations : [];
  };
  const setProperty = (row: NotePage, propertyId: string, value: string) => {
    const property = properties.find((item) => item.id === propertyId);
    if (property?.type !== "relation") {
      updatePage(row.id, rowValues(row, { [propertyId]: value }));
      return;
    }
    const pages = document?.state.pages ?? {};
    const mutations = pagePatchMutations(pages, author, row.id, rowValues(row, { [propertyId]: value }));
    mutations.push(...relationPeersOf(property, row.id, row.properties?.[propertyId] ?? "", value));
    commitWrites(mutations);
  };
  /** A new row's seeded values, with the same two-sided write for a
   *  relation the filter seeded it with. */
  const setSeeded = (created: NotePage, seeded: Record<string, string>) => {
    const pages = document?.state.pages ?? {};
    const mutations = pagePatchMutations(pages, author, created.id, rowValues(created, seeded));
    for (const [propertyId, value] of Object.entries(seeded)) {
      const property = properties.find((item) => item.id === propertyId);
      if (property?.type === "relation") mutations.push(...relationPeersOf(property, created.id, "", value));
    }
    commitWrites(mutations);
  };

  /* A new row is born matching the view it was made in: inside a filter it
     takes the filtered value, so it does not vanish the moment it exists; in a
     calendar it lands on today; in a board column, in that column. A table
     or a list gives you the new row's name to type where it stands; a board,
     a gallery or a calendar opens it beside, in the side peek, name first. */
  const addRow = (values: Record<string, string> = {}, open: "peek" | "cell" | "card" = view.kind === "table" || view.kind === "list" ? "cell" : "peek") => {
    if (readOnly) return;
    const id = createPage(databaseId, "document", { select: false });
    if (!id) return;
    const seeded: Record<string, string> = { ...values };
    /* One plain `is` condition — or a multi-select's `contains`, or a
       checkbox's — hands its value to the row, so it does not vanish from
       the filtered view the moment it exists. */
    const conditions = filterConditions(view);
    const seed = conditions.length === 1 ? conditions[0] : undefined;
    const seedProperty = seed ? properties.find((property) => property.id === seed.property_id) : undefined;
    if (seed && seedProperty && seed.value !== undefined && !(seed.property_id in seeded)) {
      if ((seedProperty.type === "select" || seedProperty.type === "status") && seed.op === "is") seeded[seed.property_id] = seed.value;
      else if ((seedProperty.type === "multi_select" || seedProperty.type === "relation") && seed.op === "contains") seeded[seed.property_id] = toMultiValue([seed.value]);
      else if (seedProperty.type === "checkbox" && seed.op === "is") seeded[seed.property_id] = seed.value;
    }
    if (view.kind === "calendar") {
      const date = calendarProperty(view, properties);
      if (date && !(date.id in seeded)) seeded[date.id] = isoDate(new Date());
    }
    const created = document?.state.pages[id];
    if (created && Object.keys(seeded).length) {
      setSeeded(created, seeded);
    }
    if (open === "cell" || open === "card") setRenaming({ id, caret: "end" });
    else openPeek(id);
  };

  /* A column made — at the end, from "Add property", or beside another,
     from its menu — opens its own menu next, its name selected. */
  const addColumn = (type: PropertyType, index: number, anchor?: AnchorRect) => {
    if (readOnly) return;
    // A relation is made only with the database it links to — its target is
    // fixed for the column's life, so it is picked first.
    if (type === "relation" && anchor) {
      setMenu({ kind: "relation-target", anchor, index });
      return;
    }
    const made = insertProperty(config, newPropertyId(), type, index);
    saveConfig(made.config);
    setMenu({ kind: "column", column: made.property.id, anchor: null });
  };

  const addRelationColumn = (targetId: string, index: number) => {
    if (readOnly) return;
    const made = insertProperty(config, newPropertyId(), "relation", index);
    made.property.relation_database = targetId;
    saveConfig(made.config);
    setMenu({ kind: "column", column: made.property.id, anchor: null });
  };

  /* The databases a relation may link to: every one this person can reach —
     itself included, a self-relation being as valid as Notion's. */
  const databaseChoices = useWorkspaceState((state) => Object.values(state.pages)
    .filter((page): page is NotePage => Boolean(page) && page.kind === "database" && !page.archived && !inTrash(state.pages, page.id))
    .sort((a, b) => pageName(a).localeCompare(pageName(b))), sameItems);

  const insertColumn = (column: string, side: "left" | "right") => {
    const at = column === TITLE_COLUMN ? 0 : properties.findIndex((property) => property.id === column);
    if (at < 0) return;
    addColumn("text", column === TITLE_COLUMN || side === "left" ? at : at + 1);
  };

  /* A copy carries its column's values, as Notion's does: they live on the
     rows, so each row that has one is written — one step to undo. */
  const duplicateColumn = (propertyId: string) => {
    if (readOnly) return;
    const copied = duplicateProperty(config, propertyId, newPropertyId());
    if (!copied) return;
    saveConfig(copied.config);
    for (const { id, patch } of copiedColumn(allRows, propertyId, copied.property)) updatePage(id, patch);
  };

  const saveSorts = (next: ViewSort[]) => {
    saveView(withSorts(view, next));
    // The last key taken away, the panel has nothing left to show.
    if (!next.length) setMenu(null);
  };

  const saveFilters = (items: ViewFilter[]) => saveView(withFilters(view, items));
  const saveHidden = (ids: string[]) => saveView({ ...view, hidden: ids.length ? ids : undefined });
  const saveGroupBy = (id: string | null) => saveView({ ...view, group_by: id ?? undefined });

  /* A status's options, edited from its column's menu. Rows hold an option's
     name, so a rename or a delete writes the rows holding it too — in the
     same step as the option, so one undo takes both back. */
  const writeRows = (propertyId: string, writes: RowWrite[]) => {
    const byId = new Map(allRows.map((row) => [row.id, row]));
    for (const write of writes) {
      const row = byId.get(write.rowId);
      if (row) setProperty(row, propertyId, write.value);
    }
  };
  /* A relation's fields, written the way they pair: its limit and its
     mirror's name live on the column itself; the mirror the column owes its
     target is made, dropped or renamed in the same commit, so the two
     databases never disagree about the pairing. */
  const relationMirror = (property: DatabaseProperty) => {
    const target = property.relation_database ? document?.state.pages[property.relation_database] : undefined;
    const mirror = target?.database?.properties.find((item) => item.type === "relation" && item.relation_origin === property.id);
    return { target, mirror };
  };
  const relationEditing = (property: DatabaseProperty): RelationEditing => {
    const { target, mirror } = relationMirror(property);
    const pages = document?.state.pages ?? {};
    /* The column's own config and, when the mirror lives on another
       database, that database's too — one commit for both. A self-relation's
       mirror is its own config's, already inside `next`. */
    const pairSave = (next: DatabaseConfig, edit?: (source: DatabaseConfig) => DatabaseConfig) => {
      if (edit && target?.database && target.id !== databaseId && canEdit(target.id)) {
        commitWrites([
          ...pagePatchMutations(pages, author, databaseId, { database: next }),
          ...pagePatchMutations(pages, author, target.id, { database: edit(target.database) }),
        ]);
      } else {
        saveConfig(next);
      }
    };
    return {
      targetName: target ? pageName(target) || "Untitled" : "?",
      mirror: Boolean(property.relation_origin),
      limit: property.relation_limit === "1" ? "1" : "unlimited",
      twoWay: Boolean(property.relation_two_way),
      backlinkName: property.relation_backlink_name ?? "",
      onLimit: (limit) => {
        const updated = { ...property };
        if (limit === "unlimited") delete updated.relation_limit;
        else updated.relation_limit = "1";
        saveConfig({ ...config, properties: config.properties.map((item) => (item.id === property.id ? updated : item)) });
      },
      onTwoWay: (twoWay) => {
        if (!target?.database) return;
        const updated = { ...property, relation_two_way: twoWay || undefined };
        let next: DatabaseConfig = { ...config, properties: config.properties.map((item) => (item.id === property.id ? updated : item)) };
        if (twoWay && !mirror) {
          const named = target.id === databaseId ? next : target.database;
          const made = relationMirrorProperty(updated, databaseId, pageName(database!), newPropertyId(), named.properties.map((item) => item.name));
          if (target.id === databaseId) next = { ...next, properties: [...next.properties, made] };
          pairSave(next, (source) => ({ ...source, properties: [...source.properties, made] }));
        } else if (!twoWay && mirror) {
          if (target.id === databaseId) next = removeProperty(next, mirror.id);
          pairSave(next, (source) => removeProperty(source, mirror.id));
        } else {
          pairSave(next);
        }
      },
      onBacklinkName: (name) => {
        const updated = { ...property, relation_backlink_name: name.trim() || undefined };
        const next: DatabaseConfig = { ...config, properties: config.properties.map((item) => (item.id === property.id ? updated : item)) };
        if (!mirror || !target?.database) {
          saveConfig(next);
          return;
        }
        const mirrorName = name.trim() || pageName(database!) || "Relation";
        if (target.id === databaseId) {
          saveConfig({ ...next, properties: next.properties.map((item) => (item.id === mirror.id ? { ...item, name: mirrorName } : item)) });
        } else {
          pairSave(next, (source) => ({ ...source, properties: source.properties.map((item) => (item.id === mirror.id ? { ...item, name: mirrorName } : item)) }));
        }
      },
    };
  };
  /** The mirror a column's deletion or type change takes with it: dropped
   *  from `next` itself on a self-relation, or as the mutations `peer` owes
   *  the other database — the caller commits both together. Skipped where
   *  the mirror lives past this person's write. */
  const dropMirror = (property: DatabaseProperty, next: DatabaseConfig): { next: DatabaseConfig; peer: WorkspaceMutation[] } => {
    const { target, mirror } = relationMirror(property);
    if (!mirror || !target?.database) return { next, peer: [] };
    if (target.id === databaseId) return { next: removeProperty(next, mirror.id), peer: [] };
    if (!canEdit(target.id)) return { next, peer: [] };
    const pages = document?.state.pages ?? {};
    return { next, peer: pagePatchMutations(pages, author, target.id, { database: removeProperty(target.database, mirror.id) }) };
  };
  /** A config write that may owe a second database's: both in one commit. */
  const saveConfigWithPeer = (next: DatabaseConfig, peer: WorkspaceMutation[]) => {
    if (!peer.length) {
      saveConfig(next);
      return;
    }
    const pages = document?.state.pages ?? {};
    commitWrites([...pagePatchMutations(pages, author, databaseId, { database: next }), ...peer]);
  };

  const statusEditing = (propertyId: string): StatusEditing => ({
    add: (group, name) => {
      const made = readOnly ? null : addStatusOption(config, propertyId, group, name, createId("status"));
      if (made) saveConfig(made.config);
      return Boolean(made);
    },
    rename: (optionId, name) => {
      const renamed = readOnly ? null : renameStatusOption(config, propertyId, optionId, name, allRows);
      if (!renamed) return false;
      saveConfig(renamed.config);
      writeRows(propertyId, renamed.writes);
      return true;
    },
    recolor: (optionId, color) => saveConfig(recolorStatusOption(config, propertyId, optionId, color)),
    move: (optionId, group, index) => saveConfig(moveStatusOption(config, propertyId, optionId, group, index)),
    makeDefault: (optionId) => saveConfig(setDefaultStatus(config, propertyId, optionId)),
    remove: (optionId) => {
      const removed = readOnly ? null : removeStatusOption(config, propertyId, optionId, allRows);
      if (!removed) return;
      saveConfig(removed.config);
      writeRows(propertyId, removed.writes);
    },
  });

  /* A select's or multi-select's options, the same way a status's are — by
     name, where a status works by id; a rename or delete writes the rows
     holding it (inside a multi-select's lists too), in the same step. */
  const selectEditing = (propertyId: string): SelectEditing => ({
    add: (name) => {
      const made = readOnly ? null : addSelectOption(config, propertyId, name);
      if (made) saveConfig(made.config);
      return Boolean(made);
    },
    rename: (option, name) => {
      const renamed = readOnly ? null : renameSelectOption(config, propertyId, option, name, allRows);
      if (!renamed) return false;
      saveConfig(renamed.config);
      writeRows(propertyId, renamed.writes);
      return true;
    },
    recolor: (option, color) => saveConfig(recolorSelectOption(config, propertyId, option, color)),
    remove: (option) => {
      const removed = readOnly ? null : removeSelectOption(config, propertyId, option, allRows);
      if (!removed) return;
      saveConfig(removed.config);
      writeRows(propertyId, removed.writes);
    },
  });

  const board = view.kind === "board" ? boardProperty(view, properties) : undefined;
  const dates = view.kind === "calendar" ? calendarProperty(view, properties) : undefined;
  // The side peek is the window's; this database marks the row it shows, if
  // it is one of this database's.
  // A row opens beside, in the side peek; asked for whole (⌘/Ctrl), it is
  // the page, as the peek's own "Open as full page" makes it.
  const openRow = (id: string, full?: boolean) => {
    if (!full) {
      openPeek(id);
      return;
    }
    selectPage(id);
    closePeek();
  };
  const layoutProps: LayoutProps = { rows, properties, bare, peekId: peeked, onOpen: openRow, onAdd: addRow, readOnly, reorderable, onReorderRow: reorderRow };

  /* A row's own menu, from a right-click on it in any view: Open — the row
     as the page it is — and Delete. */
  const menuRow = menu?.kind === "row" ? allRows.find((row) => row.id === menu.rowId) : undefined;
  const rowMenu = (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target as Element;
    // Words being typed keep the browser's own menu: copy, paste, spelling.
    if (readOnly || target.closest("input, textarea, [contenteditable='true']")) return;
    const rowId = target.closest<HTMLElement>("[data-page-id]")?.dataset.pageId;
    if (!rowId || !allRows.some((row) => row.id === rowId)) return;
    event.preventDefault();
    setRenaming(null);
    setMenu({ kind: "row", rowId, anchor: pointRect(event.clientX, event.clientY) });
  };
  const rename = (row: NotePage, name: InlineContent) => updatePage(row.id, titleFields(name));
  const cardEditing: CardEditing = {
    renamingId: renaming?.id ?? null,
    onStartRename: (id) => setRenaming({ id, caret: "all" }),
    onStopRename: () => setRenaming(null),
    onRename: rename,
    onAddInline: (values) => addRow(values, "card"),
  };
  const rowRenaming: RowRenaming = {
    renamingId: renaming?.id ?? null,
    renameCaret: renaming?.caret ?? "end",
    onStartRename: (id, caret = "all") => {
      if (!readOnly) setRenaming({ id, caret });
    },
    onStopRename: () => setRenaming(null),
    onRename: rename,
  };

  /* The tabs — the narrow database's one switch, or the strip — only once
     there is a second view: one view needs no tab to say which it is. */
  const tabs = config.views.length > 1 ? (
    <>
      <button
        type="button"
        className="db__view-switch"
        aria-haspopup="menu"
        aria-label={`View: ${view.name || viewKindLabel(view.kind)}`}
        onClick={(event) => setMenu({ kind: "views", anchor: rectOf(event.currentTarget) })}
      >
        <ViewIcon kind={view.kind} />
        <span className="view-tab__name">{view.name || viewKindLabel(view.kind)}</span>
        <ChevronDown size={14} />
      </button>
      <div className="db__views" role="tablist" aria-label="Views" ref={tabsRef}>
        {config.views.map((item) => {
          const active = item.id === view.id;
          return (
            <button
              type="button"
              role="tab"
              key={item.id}
              aria-selected={active}
              aria-haspopup={active ? "menu" : undefined}
              className={`view-tab ${active ? "is-active" : ""}`}
              // Notion's grammar: a tab you are not on switches to it; the
              // tab you ARE on opens its settings. Right-click does the
              // latter from anywhere.
              onClick={(event) => {
                if (!active) openView(item.id);
                else if (!readOnly) setMenu({ kind: "view", viewId: item.id, anchor: rectOf(event.currentTarget) });
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                if (!readOnly) setMenu({ kind: "view", viewId: item.id, anchor: rectOf(event.currentTarget) });
              }}
            >
              <ViewIcon kind={item.kind} />
              <span className="view-tab__name">{item.name || viewKindLabel(item.kind)}</span>
            </button>
          );
        })}
        <Tooltip label="Add a view">
          <button
            type="button"
            className="view-tab view-tab--add"
            aria-label="Add a view"
            onClick={(event) => setMenu({ kind: "add-view", anchor: rectOf(event.currentTarget) })}
          >
            <Plus size={15} />
          </button>
        </Tooltip>
      </div>
    </>
  ) : null;
  // The tools stay in sight while one of them is in use — a filter hiding
  // rows, groups or columns taken away included.
  const toolsHeld = filters > 0 || sorts.length > 0 || Boolean(groupedBy) || hiddenColumns > 0 || searchOpen || Boolean(query) || menu !== null;

  let layout;
  if (view.kind === "board" && board) {
    layout = (
      <BoardLayout
        {...layoutProps}
        {...cardEditing}
        property={board}
      />
    );
  } else if (view.kind === "list") {
    layout = (
      <ListLayout
        {...layoutProps}
        {...rowRenaming}
        properties={shown}
        groups={groups}
        groupedBy={groupedBy}
        onAddInline={(values) => addRow(values ?? {}, "cell")}
        titleLabel={titleLabel}
      />
    );
  } else if (view.kind === "gallery") {
    layout = (
      <GalleryLayout
        {...layoutProps}
        {...cardEditing}
        properties={cardProperties(view, properties).filter((property) => !view.hidden?.includes(property.id))}
        preview={cardPreview(view, properties)}
      />
    );
  } else if (view.kind === "calendar" && dates) {
    layout = <CalendarLayout {...layoutProps} property={dates} />;
  } else {
    layout = (
      <TableLayout
        {...layoutProps}
        {...rowRenaming}
        properties={shown}
        groups={groups}
        groupedBy={groupedBy}
        onAddInline={(values) => addRow(values ?? {}, "cell")}
        onSetProperty={setProperty}
        onAddProperty={(anchor) => setMenu({ kind: "property", anchor })}
        onCalc={(column, kind) => saveView(withCalc(view, column, kind))}
        minimal={minimal}
        view={view}
        titleLabel={titleLabel}
        titleIcon={config.title_icon}
        menuColumn={menuColumn}
        onColumnMenu={(column, anchor) => setMenu({ kind: "column", column, anchor })}
        onResize={(column, width) => saveView(withColumnWidth(view, column, width))}
        onReorder={reorderProperty}
        onReorderRow={reorderRow}
        reorderable={reorderable}
      />
    );
  }

  return (
    <div
      ref={rootRef}
      className={`dbv dbv--${variant} ${readOnly ? "dbv--readonly" : ""} ${minimal ? "dbv--minimal" : ""} ${quiet ? "dbv--quiet" : ""}`}
      onContextMenu={rowMenu}
    >
      {/* The others on this database: their caret in a name being typed
          (RemoteCarets). */}
      <RemoteCarets root={rootRef} />
      {/* One row: an inline database's name — on its own page, whose name is
          the page's, its views — then its tools: Filter, Sort, Search and ···,
          which holds the rest of the view and of the database. In a document
          the tools come when the pointer does, and stay while one is in use.
          A second view brings the tabs, under the name. A row is added where
          the rows are (+ New), never from up here. */}
      <div className={`db__toolbar ${toolsHeld ? "is-held" : ""}`}>
        {title ? <div className="db__title">{title}</div> : pinnedViewId ? (
          // A linked view has one view, named where the tabs would stand —
          // a label, not a tab: it does not switch.
          <div className="db__tabs">
            <span className="view-tab view-tab--pinned">
              <ViewIcon kind={view.kind} />
              <span className="view-tab__name">{view.name || viewKindLabel(view.kind)}</span>
            </span>
          </div>
        ) : <div className="db__tabs">{tabs}</div>}
        <div className="db__tools">
          {filterable.length && !readOnly ? (
            <Tooltip label={filters ? `${filters} filter${filters > 1 ? "s" : ""}` : "Filter"}>
              <button
                type="button"
                className={`db__tool ${filters ? "is-on" : ""}`}
                aria-label={filters ? `Filtered by ${filters} condition${filters > 1 ? "s" : ""}` : "Filter"}
                onClick={(event) => setMenu({ kind: "filter", anchor: rectOf(event.currentTarget) })}
              >
                <Filter size={15} />
                {filters ? <span className="db__tool-label">{filters}</span> : null}
              </button>
            </Tooltip>
          ) : null}
          {readOnly ? null : (
            <Tooltip label={sortTitle}>
              <button
                type="button"
                className={`db__tool ${sorts.length ? "is-on" : ""}`}
                aria-label={sortTitle}
                onClick={(event) => setMenu({ kind: "sort", anchor: rectOf(event.currentTarget) })}
              >
                {/* Sorted, the arrow is the first key's direction, as on
                    Notion's sort chip. */}
                {!sorts.length ? <ArrowDownAZ size={15} /> : sorts[0].direction === "desc" ? <ArrowDown size={15} /> : <ArrowUp size={15} />}
                {sorts.length ? <span className="db__tool-label">{sortLabel}</span> : null}
              </button>
            </Tooltip>
          )}
          {/* A table's and a list's rows can stand under the property's
              values; the chip names the property they group by. */}
          {readOnly || !groupable.length || (view.kind !== "table" && view.kind !== "list") ? null : (
            <Tooltip label={groupedBy ? `Grouped by ${propertyName(groupedBy)}` : "Group"}>
              <button
                type="button"
                className={`db__tool ${groupedBy ? "is-on" : ""}`}
                aria-label={groupedBy ? `Grouped by ${propertyName(groupedBy)}` : "Group"}
                onClick={(event) => setMenu({ kind: "group", anchor: rectOf(event.currentTarget) })}
              >
                <Layers size={15} />
                {groupedBy ? <span className="db__tool-label">{propertyName(groupedBy)}</span> : null}
              </button>
            </Tooltip>
          )}
          {readOnly || !properties.length || (view.kind !== "table" && view.kind !== "list" && view.kind !== "gallery") ? null : (
            <Tooltip label={hiddenColumns ? `${hiddenColumns} column${hiddenColumns > 1 ? "s" : ""} hidden` : "Columns"}>
              <button
                type="button"
                className={`db__tool ${hiddenColumns ? "is-on" : ""}`}
                aria-label={hiddenColumns ? `${hiddenColumns} columns hidden` : "Columns"}
                onClick={(event) => setMenu({ kind: "columns", anchor: rectOf(event.currentTarget) })}
              >
                <Eye size={15} />
                {hiddenColumns ? <span className="db__tool-label">{hiddenColumns} hidden</span> : null}
              </button>
            </Tooltip>
          )}
          {/* Search sits right after Sort (Winston, round 60). The box opens
              out of the button. */}
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
          <Tooltip label="Search">
            <button
              type="button"
              className="icon-btn"
              aria-label="Search this database"
              onClick={() => {
                setSearchOpen((open) => !open);
                window.setTimeout(() => searchRef.current?.focus(), 60);
              }}
            >
              <Search size={16} />
            </button>
          </Tooltip>
          {readOnly ? (
            variant === "inline" ? (
              <Tooltip label="Open as full page">
                <button type="button" className="db__tool" aria-label="Open as full page" onClick={() => selectPage(databaseId)}>
                  <ArrowUpRight size={16} />
                </button>
              </Tooltip>
            ) : null
          ) : (
            <Tooltip label="View and database settings">
              <button
                type="button"
                className={`db__tool ${menu?.kind === "view" && menu.viewId === view.id ? "is-open" : ""}`}
                aria-label="View and database settings"
                aria-haspopup="menu"
                onClick={(event) => setMenu({ kind: "view", viewId: view.id, anchor: rectOf(event.currentTarget) })}
              >
                <MoreHorizontal size={16} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
      {title && tabs ? <div className="db__toolbar db__toolbar--tabs"><div className="db__tabs">{tabs}</div></div> : null}

      {layout}

      {columnMenu && menuColumn && (menuColumn === TITLE_COLUMN || menuProperty) ? (
        <PropertyMenu
          key={menuColumn}
          anchor={columnMenu.anchor}
          databaseId={databaseId}
          property={menuProperty ?? null}
          name={menuProperty ? menuProperty.name : config.title_name ?? titleLabel}
          placeholder={menuProperty ? PROPERTY_LABELS[menuProperty.type] : "Name"}
          icon={menuProperty ? menuProperty.icon : config.title_icon}
          sort={sorts.find((sort) => sort.property_id === menuColumn)?.direction}
          wrap={menuColumn === TITLE_COLUMN || menuProperty?.type === "text" ? columnWraps(view, menuColumn) : undefined}
          statusEditing={menuProperty?.type === "status" ? statusEditing(menuProperty.id) : undefined}
          selectEditing={menuProperty && (menuProperty.type === "select" || menuProperty.type === "multi_select") ? selectEditing(menuProperty.id) : undefined}
          relation={menuProperty?.type === "relation" ? relationEditing(menuProperty) : undefined}
          onRename={(name) => saveConfig(renameProperty(config, menuColumn, name))}
          onIcon={(icon) => saveConfig(setPropertyIcon(config, menuColumn, icon))}
          onChangeType={(type) => {
            const changed = changePropertyType(config, menuColumn, type, allRows);
            if (menuProperty?.type === "relation" && !menuProperty.relation_origin) {
              const dropped = dropMirror(menuProperty, changed);
              saveConfigWithPeer(dropped.next, dropped.peer);
            } else {
              saveConfig(changed);
            }
          }}
          onSort={(direction) => saveView(sortByColumn(view, properties, menuColumn, direction))}
          onWrap={(wraps) => saveView(withColumnWrap(view, menuColumn, wraps))}
          onInsert={(side) => insertColumn(menuColumn, side)}
          onDuplicate={() => duplicateColumn(menuColumn)}
          onDelete={() => {
            if (menuProperty?.type === "relation" && !menuProperty.relation_origin) {
              const dropped = dropMirror(menuProperty, removeProperty(config, menuColumn));
              saveConfigWithPeer(dropped.next, dropped.peer);
            } else {
              saveConfig(removeProperty(config, menuColumn));
            }
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}

      <Popover
        open={menu?.kind === "row" && Boolean(menuRow)}
        anchor={menu?.kind === "row" ? menu.anchor : null}
        placement="bottom-start"
        label="Row"
        mobileSheet={{ title: menuRow ? pageName(menuRow) || "行操作" : "行操作" }}
        onDismiss={() => setMenu(null)}
      >
        {menuRow ? (
          <MenuList label="Row" autoFocus>
            <MenuItem icon={<Maximize2 size={16} />} label="Open" onSelect={() => { setMenu(null); openRow(menuRow.id); }} />
            <MenuDivider />
            <MenuItem
              icon={<Trash2 size={16} />}
              label="Delete"
              tone="danger"
              onSelect={() => {
                setMenu(null);
                if (peekPageId === menuRow.id) closePeek();
                archivePage(menuRow.id);
              }}
            />
          </MenuList>
        ) : <div />}
      </Popover>

      <Popover
        open={menu?.kind === "view" && Boolean(menuView)}
        anchor={menu?.kind === "view" ? menu.anchor : null}
        placement="bottom-start"
        label="View settings"
        mobileSheet={{ title: "视图设置" }}
        onDismiss={() => setMenu(null)}
      >
        {menuView ? (
          <div className="view-menu">
            {/* One view has no tab to name: the database's name is its name. */}
            {config.views.length > 1 ? <input
              className="view-menu__name"
              value={menuView.name}
              aria-label="View name"
              data-history-field={`view:${menuView.id}`}
              data-page-id={databaseId}
              placeholder={viewKindLabel(menuView.kind)}
              onChange={(event) => saveView({ ...menuView, name: event.target.value })}
              onKeyDown={(event) => { if (event.key === "Enter" && !imeComposing(event)) setMenu(null); }}
            /> : null}
            <MenuList label="View settings" autoFocus={config.views.length <= 1}>
              <div className="menu__section-title">Layout</div>
              {VIEW_KINDS.map((kind) => (
                <MenuItem
                  key={kind}
                  icon={<ViewIcon kind={kind} size={16} />}
                  label={viewKindLabel(kind)}
                  selected={menuView.kind === kind}
                  onSelect={() => changeLayout(menuView, kind)}
                />
              ))}
              {menuView.kind === "board" && boardGroupableProperties(properties).length > 1 ? (
                <>
                  <div className="menu__section-title">Group by</div>
                  {boardGroupableProperties(properties).map((property) => (
                    <MenuItem
                      key={property.id}
                      icon={<PropertyIcon property={property} />}
                      label={propertyName(property)}
                      selected={boardProperty(menuView, properties)?.id === property.id}
                      onSelect={() => saveView({ ...menuView, group_by: property.id })}
                    />
                  ))}
                </>
              ) : null}
              {menuView.kind === "calendar" && properties.filter((property) => property.type === "date").length > 1 ? (
                <>
                  <div className="menu__section-title">Show by</div>
                  {properties.filter((property) => property.type === "date").map((property) => (
                    <MenuItem
                      key={property.id}
                      icon={<PropertyIcon property={property} />}
                      label={propertyName(property)}
                      selected={calendarProperty(menuView, properties)?.id === property.id}
                      onSelect={() => saveView({ ...menuView, date_by: property.id })}
                    />
                  ))}
                </>
              ) : null}
              {menuView.kind === "gallery" ? (
                <GallerySettings
                  view={menuView}
                  properties={properties}
                  onChange={saveView}
                />
              ) : null}
              <MenuDivider />
              <MenuItem
                icon={<Copy size={16} />}
                label="Duplicate view"
                onSelect={() => {
                  const copied = duplicateView(config, menuView.id, createId("view"));
                  if (!copied) return;
                  saveConfig(copied.config);
                  openView(copied.view.id);
                  setMenu(null);
                }}
              />
              {config.views.length > 1 ? (
                <MenuItem
                  icon={<Trash2 size={16} />}
                  label="Delete view"
                  tone="danger"
                  onSelect={() => {
                    const next = removeView(config, menuView.id);
                    if (!next) return;
                    saveConfig(next);
                    setMenu(null);
                  }}
                />
              ) : (
                <MenuItem
                  icon={<Plus size={16} />}
                  label="Add a view"
                  onSelect={() => { if (menu?.anchor) setMenu({ kind: "add-view", anchor: menu.anchor }); }}
                />
              )}
              {/* The database's own: drawn plain, opened whole, or turned back
                  into a table or a list — offered only when it can be, its rows
                  empty (convert.ts); one step of undo either way, the rows
                  going with it. */}
              <MenuDivider />
              {menuView.kind === "table" ? (
                <MenuItem
                  icon={<Minimize2 size={16} />}
                  label="Minimal table"
                  selected={Boolean(menuView.minimal)}
                  onSelect={() => saveView({ ...menuView, minimal: !menuView.minimal })}
                />
              ) : null}
              {variant === "inline" ? (
                <MenuItem icon={<ArrowUpRight size={16} />} label="Open as full page" onSelect={() => { setMenu(null); selectPage(databaseId); }} />
              ) : null}
              {document ? (() => {
                const convertible = databaseConvertible(document.state.pages, databaseId);
                const turn = (as: "table" | "list") => {
                  setMenu(null);
                  if (!platform) return;
                  const done = databaseToBlocks(document.state.pages, databaseId, as, view, {
                    page: (kind) => createId(kind),
                    block: () => createId("block"),
                    property: () => createId("property"),
                    view: () => createId("view"),
                    column: () => createId("col"),
                    row: () => createId("row"),
                  }, { now: new Date().toISOString(), author: platform.bootstrap.user.displayName }, ordersBetween);
                  if ("refusal" in done) toast(done.refusal, "error");
                  else commitWrites(done.mutations);
                };
                if (convertible.table && convertible.list) return null;
                return (
                  <>
                    <div className="menu__section-title">Turn into</div>
                    {convertible.table ? null : <MenuItem icon={<Table size={16} />} label="Table" onSelect={() => turn("table")} />}
                    {convertible.list ? null : <MenuItem icon={<List size={16} />} label="List" onSelect={() => turn("list")} />}
                  </>
                );
              })() : null}
            </MenuList>
          </div>
        ) : <div />}
      </Popover>

      <Popover
        open={menu?.kind === "views"}
        anchor={menu?.kind === "views" ? menu.anchor : null}
        placement="bottom-start"
        label="Views"
        mobileSheet={{ title: "切换视图" }}
        onDismiss={() => setMenu(null)}
      >
        <MenuList label="Views" autoFocus>
          <div className="menu__section-title">Views</div>
          {config.views.map((item) => (
            <MenuItem
              key={item.id}
              icon={<ViewIcon kind={item.kind} size={16} />}
              label={item.name || viewKindLabel(item.kind)}
              selected={item.id === view.id}
              onSelect={() => { openView(item.id); setMenu(null); }}
            />
          ))}
          <MenuDivider />
          <MenuItem
            icon={<SlidersHorizontal size={16} />}
            label="Edit this view"
            onSelect={() => { if (menu?.anchor) setMenu({ kind: "view", viewId: view.id, anchor: menu.anchor }); }}
          />
          <MenuItem
            icon={<Plus size={16} />}
            label="Add a view"
            onSelect={() => { if (menu?.anchor) setMenu({ kind: "add-view", anchor: menu.anchor }); }}
          />
        </MenuList>
      </Popover>

      <Popover
        open={menu?.kind === "add-view"}
        anchor={menu?.kind === "add-view" ? menu.anchor : null}
        placement="bottom-start"
        label="Add a view"
        mobileSheet={{ title: "新建视图" }}
        onDismiss={() => setMenu(null)}
      >
        <MenuList label="Add a view" autoFocus>
          <div className="menu__section-title">Add a view</div>
          {VIEW_KINDS.map((kind) => (
            <MenuItem
              key={kind}
              icon={<ViewIcon kind={kind} size={16} />}
              label={viewKindLabel(kind)}
              onSelect={() => addView(kind)}
            />
          ))}
        </MenuList>
      </Popover>

      <Popover
        open={menu?.kind === "filter"}
        anchor={menu?.kind === "filter" ? menu.anchor : null}
        placement="bottom-end"
        label="Filter"
        mobileSheet={{ title: "筛选" }}
        onDismiss={() => setMenu(null)}
      >
        <FilterPanel
          items={viewFilters(view)}
          columns={filterColumns}
          properties={filterable}
          onChange={saveFilters}
        />
      </Popover>

      <Popover
        open={menu?.kind === "group"}
        anchor={menu?.kind === "group" ? menu.anchor : null}
        placement="bottom-end"
        label="Group"
        mobileSheet={{ title: "分组" }}
        onDismiss={() => setMenu(null)}
      >
        <MenuList label="Group by" autoFocus>
          <div className="menu__section-title">Group by</div>
          {groupable.map((property) => (
            <MenuItem
              key={property.id}
              icon={<PropertyIcon property={property} size={16} />}
              label={propertyName(property)}
              selected={groupedBy?.id === property.id}
              onSelect={() => { saveGroupBy(property.id); setMenu(null); }}
            />
          ))}
          <MenuDivider />
          <MenuItem
            icon={<X size={16} />}
            label="No grouping"
            disabled={!groupedBy}
            onSelect={() => { saveGroupBy(null); setMenu(null); }}
          />
        </MenuList>
      </Popover>

      <Popover
        open={menu?.kind === "columns"}
        anchor={menu?.kind === "columns" ? menu.anchor : null}
        placement="bottom-end"
        label="Columns"
        mobileSheet={{ title: "列与属性" }}
        onDismiss={() => setMenu(null)}
      >
        <ColumnsPanel
          hidden={view.hidden ?? []}
          titleLabel={titleLabel}
          titleIcon={config.title_icon}
          properties={properties}
          readOnly={readOnly}
          onChange={saveHidden}
          onReorder={reorderProperty}
        />
      </Popover>

      <Popover
        open={menu?.kind === "sort"}
        anchor={menu?.kind === "sort" ? menu.anchor : null}
        placement="bottom-end"
        label="Sort"
        mobileSheet={{ title: "排序" }}
        onDismiss={() => setMenu(null)}
      >
        {/* Unsorted, Sort is the list of what to sort by; sorted, it is the
            view's sorts, as Notion's panel. */}
        {sorts.length ? (
          <SortPanel sorts={sorts} columns={sortColumns} onChange={saveSorts} />
        ) : (
          <MenuList label="Sort by" autoFocus>
            <div className="menu__section-title">Sort by</div>
            {sortColumns.map((column) => (
              <MenuItem
                key={column.id}
                icon={column.icon}
                label={column.label}
                onSelect={() => saveView(withSorts(view, [{ property_id: column.id, direction: "asc" }]))}
              />
            ))}
          </MenuList>
        )}
      </Popover>

      <Popover
        open={menu?.kind === "property"}
        anchor={menu?.kind === "property" ? menu.anchor : null}
        placement="bottom-start"
        label="Add property"
        mobileSheet={{ title: "添加属性" }}
        onDismiss={() => setMenu(null)}
      >
        <MenuList label="Property type" autoFocus>
          {PROPERTY_TYPES.map((type) => (
            <MenuItem
              key={type}
              icon={<TypeIcon type={type} />}
              label={PROPERTY_LABELS[type]}
              onSelect={() => addColumn(type, properties.length, menu?.kind === "property" ? menu.anchor : undefined)}
            />
          ))}
        </MenuList>
      </Popover>

      {/* A relation's target: the database its values link to, picked
          before the column exists — it never changes afterwards. */}
      <Popover
        open={menu?.kind === "relation-target"}
        anchor={menu?.kind === "relation-target" ? menu.anchor : null}
        placement="bottom-start"
        label="Link to database"
        mobileSheet={{ title: "关联数据库" }}
        onDismiss={() => setMenu(null)}
      >
        <MenuList label="Databases" autoFocus>
          {databaseChoices.length ? databaseChoices.map((page) => (
            <MenuItem
              key={page.id}
              icon={<Table2 size={16} />}
              label={pageName(page) || "Untitled"}
              onSelect={() => addRelationColumn(page.id, menu?.kind === "relation-target" ? menu.index : properties.length)}
            />
          )) : <div className="menu__section-title">No database to link to</div>}
        </MenuList>
      </Popover>

    </div>
  );
}

