import {
  ArrowUpNarrowWide,
  ChevronRight,
  ChevronsDownUp,
  Copy,
  FileText,
  Files,
  Link,
  MoreHorizontal,
  PanelLeft,
  Plus,
  Search,
  SquarePen,
  Star,
  Table2,
  Trash2,
  UserPlus,
  Users,
  Waypoints,
} from "lucide-react";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { MenuDivider, MenuItem, MenuList } from "../../components/Menu";
import { Popover } from "../../components/Popover";
import { personName, ProfileAvatar } from "../../components/ProfileAvatar";
import { Tooltip } from "../../components/Tooltip";
import { imeComposing } from "../../core/keyboard";
import { rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import { useFold } from "../../hooks/useFold";
import { SIDEBAR_SORTS, SIDEBAR_VIEWS } from "../../../schema";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "../../core/workspace-state";
import type { NotePage, PageKind, SidebarSort, SidebarView, SpaceMember } from "../../core/types";
import { pagesInSpace } from "../../core/space-navigation";
import { useWorkspace } from "../../app/workspace-context";
import { useUi } from "../../app/ui-context";
import { pageName } from "../../core/block-tree";
import { pageAncestry } from "../../core/page-tree";
import { buildTree, linkedFromOutside, sameListing, SORT_LABELS, type PageTree } from "./tree";
import { useWorkspaceState } from "../../app/workspace-store";
import { useCopyPageLink } from "../../hooks/useCopyPageLink";
import { capitalized } from "../../core/title";
import { pageGlyph } from "../editor/block-registry";
import { TrashMenu } from "./TrashMenu";
import { AccountSettingsButton } from "../account/AccountMenu";
import { SpaceSwitcher } from "../knowledge/SpaceSwitcher";
import "./sidebar.css";

/* The graph is loaded the first time it is looked at. */
const GraphView = lazy(() => import("./GraphView").then((module) => ({ default: module.GraphView })));

/* Which pages are open is the reader's, on this device — as in Obsidian —
   and survives a reload. Storage that is missing or full costs only that. */
const EXPANDED_KEY = "notes.sidebar.expanded";

function readExpanded(): Set<string> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(EXPANDED_KEY) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeExpanded(ids: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(EXPANDED_KEY, JSON.stringify([...ids].slice(-1000)));
  } catch {
    // Not remembered: the tree simply opens closed next time.
  }
}

const VIEW_ICONS: Record<SidebarView, typeof Files> = { files: Files, favorites: Star, shared: Users, graph: Waypoints };
const VIEW_LABELS: Record<SidebarView, string> = { files: "全部页面", favorites: "收藏夹", shared: "共享空间", graph: "关系图谱" };
const SECTION_LABELS: Record<SidebarView, string> = { files: "笔记", favorites: "星标置顶", shared: "协作文档", graph: "知识拓扑" };

const SORTS: readonly SidebarSort[] = SIDEBAR_SORTS;

/** The faces of the people a page is shared with, as a small stack: at most
 *  three, and a count for the rest. */
function People({ members, me }: { members: SpaceMember[]; me?: string }) {
  const others = members.filter((member) => member.id !== me);
  const shown = (others.length ? others : members).slice(0, 3);
  const rest = (others.length ? others : members).length - shown.length;
  const names = members.map(personName).join(", ");
  return (
    <span className="tree-row__people avatar-stack" role="img" aria-label={`Shared with ${names}`} title={`Shared with ${names}`}>
      {shown.map((member) => (
        <ProfileAvatar key={member.id} src={member.avatarUrl} name={personName(member)} size={16} />
      ))}
      {rest > 0 ? <span className="tree-row__more">+{rest}</span> : null}
    </span>
  );
}

/** Where something dragged in the list lands: on a page — a block is a
 *  page — or, null, the top level. */
type TreeTarget = { pageId: string } | null;

const PAGE_DRAG = "text/x-notes-page";

/** What a row asks of the list. One stable object for the list's whole
 *  life, so a row is drawn again only when its own page (or how it is shown)
 *  changes. */
interface TreeActions {
  select(pageId: string): void;
  toggle(id: string): void;
  openMenu(pageId: string, anchor: AnchorRect): void;
  rename(id: string): void;
  finishRename(pageId: string, name: string | null): void;
  createInside(pageId: string): void;
  dragOver(target: TreeTarget, event: DragEvent<HTMLElement>): boolean;
  drop(target: TreeTarget, event: DragEvent<HTMLElement>): void;
}

const TreeRow = memo(function TreeRow({
  page,
  depth,
  branch,
  open,
  selected,
  renaming,
  menuOpen,
  editable,
  movable,
  linked,
  people,
  me,
  actions,
}: {
  page: NotePage;
  depth: number;
  /** Shows the disclosure arrow: it has pages or blocks inside. */
  branch: boolean;
  open: boolean;
  selected: boolean;
  renaming: boolean;
  menuOpen: boolean;
  editable: boolean;
  movable: boolean;
  /** Something outside it links to it: a link mark follows its name. */
  linked: boolean;
  /** Who the page is shared with — given for the page that is shared, not
   *  for the pages inside it, which are shared with it. */
  people?: SpaceMember[];
  me?: string;
  actions: TreeActions;
}) {
  const [dropping, setDropping] = useState(false);
  const label = pageName(page);
  return (
    <div
      className={[
        "tree-row",
        selected ? "is-selected" : "",
        dropping ? "is-drop-target" : "",
        menuOpen ? "is-menu-open" : "",
      ].filter(Boolean).join(" ")}
      style={{ "--depth": depth } as CSSProperties}
      data-page-id={page.id}
      draggable={movable && !renaming}
      onDragStart={(event) => {
        event.dataTransfer.setData(PAGE_DRAG, page.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(event) => {
        event.stopPropagation();
        setDropping(actions.dragOver({ pageId: page.id }, event));
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        event.stopPropagation();
        setDropping(false);
        actions.drop({ pageId: page.id }, event);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        actions.openMenu(page.id, rectOf(event.currentTarget));
      }}
    >
      {/* Its mark, as in the page: its icon at rest, and — when it holds
          anything — the arrow that opens it under the pointer. No column is
          spent on an arrow, so each level is one step in. */}
      <button
        type="button"
        className={`tree-row__mark ${branch ? "is-branch" : ""} ${open ? "is-open" : ""}`}
        aria-label={branch ? (open ? `Collapse ${label}` : `Expand ${label}`) : `Open ${label}`}
        aria-expanded={branch ? open : undefined}
        onClick={(event) => {
          event.stopPropagation();
          if (branch) actions.toggle(page.id);
          else actions.select(page.id);
        }}
      >
        <span className="tree-row__glyph" aria-hidden="true">{pageGlyph(page, 14)}</span>
        {branch ? <ChevronRight className="tree-row__arrow" size={12} aria-hidden="true" /> : null}
      </button>

      {renaming ? (
        <input
          className="tree-row__rename"
          autoFocus
          defaultValue={page.title}
          aria-label="Rename page"
          onBlur={(event) => actions.finishRename(page.id, event.target.value)}
          onKeyDown={(event) => {
            if (imeComposing(event)) return;
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") actions.finishRename(page.id, null);
          }}
        />
      ) : (
        <button
          type="button"
          className="tree-row__main"
          aria-current={selected ? "page" : undefined}
          onClick={() => actions.select(page.id)}
          onDoubleClick={() => { if (editable) actions.rename(page.id); }}
        >
          <span className="tree-row__label">{label}</span>
          {linked ? <Link className="tree-row__linked" size={11} aria-label="Has backlinks" /> : null}
        </button>
      )}

      {people?.length ? <People members={people} me={me} /> : null}

      <span className="tree-row__actions">
        <button
          type="button"
          className="icon-btn"
          aria-label={`Actions for ${label}`}
          onClick={(event) => actions.openMenu(page.id, rectOf(event.currentTarget))}
        >
          <MoreHorizontal size={14} />
        </button>
        {editable ? (
          <Tooltip label={page.kind === "database" ? "Add a row" : "Add a page inside"}>
            <button type="button" className="icon-btn" aria-label={`New page inside ${label}`} onClick={() => actions.createInside(page.id)}>
              <Plus size={14} />
            </button>
          </Tooltip>
        ) : null}
      </span>
    </div>
  );
});

export function Sidebar() {
  const {
    platform,
    preferences,
    selectedPageId,
    spaces,
    activeSpaceId,
    activeSpace,
    sidebarSort,
    setSidebarSort,
    rosters,
    archivePage,
    createPage,
    duplicatePage,
    movePage,
    selectPage,
    setPreference,
    updatePage,
    canEdit,
    canMovePage,
    canTrashPage,
    isFavorite,
    toggleFavorite,
    openGraph,
  } = useWorkspace();
  const { drawerOpen, setDrawerOpen, setQuickFindOpen, requestShare, toast } = useUi();
  const folded = useFold();

  const asideRef = useRef<HTMLElement | null>(null);
  const newTriggerRef = useRef<HTMLButtonElement | null>(null);
  const trashRef = useRef<HTMLButtonElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const [rowMenu, setRowMenu] = useState<{ pageId: string; anchor: AnchorRect } | null>(null);
  const [newMenu, setNewMenu] = useState<AnchorRect | null>(null);
  const [sortMenu, setSortMenu] = useState<AnchorRect | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [resizing, setResizing] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(readExpanded);
  const [rootDrop, setRootDrop] = useState(false);

  const me = platform?.bootstrap.user.id;
  /* The pages as the list shows them: a new state of the workspace is taken
     only when the list would look different (`sameListing`) — typing in a
     page redraws the list only when it renames the page. Anything written
     from here names the fields it changes, so an older copy of a page here
     never puts back what was written since. */
  const sort = sidebarSort;
  const allPages = useWorkspaceState((state) => state.pages, (left, right) => sameListing(left, right, sort));
  const pages = useMemo(() => pagesInSpace(allPages, spaces, activeSpaceId), [allPages, spaces, activeSpaceId]);
  const writable = !activeSpace || Boolean(activeSpace.knowledgeBase && !activeSpace.knowledgeBase.archived && activeSpace.role !== "viewer");
  const view = preferences.sidebar_view;
  const tree = useMemo(() => buildTree(pages, sort), [pages, sort]);
  const favorites = useMemo(
    () => preferences.favorites.flatMap((id): NotePage[] => (pages[id] && !pages[id].archived ? [pages[id]] : [])),
    [pages, preferences.favorites],
  );
  /* A page shared with others is a root of its own space; whose it is comes
     from the member's role there. */
  const ownedByMe = useCallback((page: NotePage) => {
    const spaceId = page.share_space_id;
    if (!spaceId) return true;
    const role = spaces[spaceId]?.role;
    if (role) return role === "owner";
    const owner = rosters[spaceId]?.members.find((member) => member.role === "owner");
    return owner ? owner.id === me : true;
  }, [me, rosters, spaces]);
  const sharedRoots = useMemo(
    () => tree.roots.concat([...tree.children.values()].flat()).filter((page) => Boolean(page.share_space_id)),
    [tree],
  );
  const sharedWithMe = sharedRoots.filter((page) => !ownedByMe(page));
  const sharedByMe = sharedRoots.filter((page) => ownedByMe(page));
  const viewCounts: Partial<Record<SidebarView, number>> = {
    files: tree.roots.length + [...tree.children.values()].reduce((count, children) => count + children.length, 0),
    favorites: favorites.length,
    shared: sharedRoots.length,
  };
  /* The link mark says something links to a page from outside where it
     lives — by the one rule, a block's too. */
  const linked = linkedFromOutside(pages);
  const linkedPage = useCallback((page: NotePage) => linked.has(page.id), [linked]);

  const railed = folded || preferences.sidebar_collapsed;
  const drawered = railed && drawerOpen;

  useEffect(() => {
    if (!folded && drawerOpen) setDrawerOpen(false);
  }, [drawerOpen, folded, setDrawerOpen]);

  useEffect(() => {
    if (!drawered) return;
    const aside = asideRef.current;
    if (!aside) return;
    const trigger = document.querySelector<HTMLButtonElement>('.rail [aria-label="All pages"]');
    const controls = () => [...aside.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]')]
      .filter((element) => element.tabIndex >= 0 && element.getClientRects().length && !element.closest("[inert]"));
    const frame = requestAnimationFrame(() => {
      if (!document.querySelector('.overlay [role="dialog"]')) controls()[0]?.focus({ preventScroll: true });
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || imeComposing(event)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setDrawerOpen(false);
      } else if (event.key === "Tab") {
        const items = controls();
        const first = items[0]; const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    // Native listeners leave portalled menus and modals in control of their keys.
    aside.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      aside.removeEventListener("keydown", onKeyDown);
      if (trigger?.getClientRects().length && !document.querySelector('.overlay [role="dialog"]')) trigger.focus({ preventScroll: true });
    };
  }, [drawered, setDrawerOpen]);

  useEffect(() => {
    setNewMenu(null);
    setSortMenu(null);
    setRowMenu(null);
    setTrashOpen(false);
    setRenaming(null);
  }, [activeSpaceId]);

  const afterNavigate = useCallback(() => setDrawerOpen(false), [setDrawerOpen]);

  const updateExpanded = useCallback((update: (current: ReadonlySet<string>) => ReadonlySet<string>) => {
    setExpanded((current) => {
      const next = update(current);
      if (next !== current) writeExpanded(next);
      return next;
    });
  }, []);

  /* The page being read is always in view in the tree: the pages above it
     open, as Obsidian reveals the active file. */
  useEffect(() => {
    if (!selectedPageId) return;
    const above = pageAncestry(pages, selectedPageId).slice(0, -1).map((page) => page.id);
    if (!above.length) return;
    updateExpanded((current) => (above.every((id) => current.has(id)) ? current : new Set([...current, ...above])));
  }, [pages, selectedPageId, updateExpanded]);

  useLayoutEffect(() => {
    if (!selectedPageId) return;
    scrollRef.current?.querySelector(`[data-page-id="${CSS.escape(selectedPageId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedPageId, view]);

  /* Dragging the seam writes straight to the DOM variable and only commits the
     preference on release, so a resize never round-trips through the operation
     log frame by frame. The upper bound protects the OTHER pane: a list you
     can drag over the page it exists to open is not a split. */
  const onResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const aside = asideRef.current;
    const shell = aside?.closest<HTMLElement>(".app-shell");
    if (!aside || !shell) return;
    const startX = event.clientX;
    const startWidth = aside.getBoundingClientRect().width;
    const ceiling = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, window.innerWidth - 280));
    let width = startWidth;
    setResizing(true);
    shell.classList.add("is-resizing");
    const onMove = (move: PointerEvent) => {
      width = Math.min(ceiling, Math.max(SIDEBAR_MIN_WIDTH, startWidth + move.clientX - startX));
      shell.style.setProperty("--sidebar-w", `${width}px`);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      shell.classList.remove("is-resizing");
      setResizing(false);
      setPreference("sidebar_width", Math.round(width));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [setPreference]);

  const menuPage = rowMenu ? pages[rowMenu.pageId] : null;

  const copyPageLink = useCopyPageLink();

  /* Sharing is the point of this page, so it is created and handed straight to
     the Share dialog. */
  const createShared = () => {
    if (!writable) return;
    const id = createPage();
    if (!id) return;
    requestShare(id);
    afterNavigate();
  };

  const toggleNewMenu = (button: HTMLButtonElement) => {
    if (!writable) return;
    newTriggerRef.current = button;
    setNewMenu((current) => current ? null : rectOf(button));
  };

  const createIn = (parentId: string | null, kind: PageKind) => {
    if (!writable) return;
    const id = createPage(parentId, kind, { block: true });
    if (id && view !== "files") setPreference("sidebar_view", "files");
    setNewMenu(null);
    if (parentId) updateExpanded((current) => new Set([...current, parentId]));
    afterNavigate();
  };

  const showList = () => {
    if (folded) setDrawerOpen(!drawerOpen);
    else setPreference("sidebar_collapsed", false);
  };

  /* Only someone with Full access carries a page out of a shared tree: for
     everyone else in the space it is gone. A page that is itself shared stays
     where it is shared, and a view-only page stays put. */

  /** Opens a target in the list — a page, or a block — so what was dropped
   *  there can be seen. */
  const reveal = (target: TreeTarget) => {
    if (target) updateExpanded((current) => new Set([...current, target.pageId]));
  };

  /* The row actions, one object for the list's whole life (see TreeActions),
     each reaching the list as it is now through a ref. */
  const handlers = useRef<TreeActions | null>(null);
  useLayoutEffect(() => {
    handlers.current = {
      select: (pageId) => {
        selectPage(pageId);
        afterNavigate();
      },
      toggle: (id) => updateExpanded((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
      openMenu: (pageId, anchor) => setRowMenu({ pageId, anchor }),
      rename: (id) => setRenaming(id),
      finishRename: (pageId, name) => {
        const page = pages[pageId];
        if (page && name !== null && name !== page.title) updatePage(pageId, { title: name });
        setRenaming(null);
      },
      createInside: (pageId) => {
        createPage(pageId, "document", { block: true });
        updateExpanded((current) => new Set([...current, pageId]));
        afterNavigate();
      },
      dragOver: (target, event) => {
        if (!writable || !event.dataTransfer.types.includes(PAGE_DRAG)) return false;
        // What is dragged is not readable until the drop; the move rule is
        // asked then. Here the target only has to be able to hold it.
        const page = target ? pages[target.pageId] : null;
        if (page && (page.kind === "database" || !canEdit(page.id))) return false;
        event.preventDefault();
        return true;
      },
      drop: (target, event) => {
        event.preventDefault();
        const draggedId = event.dataTransfer.getData(PAGE_DRAG);
        if (!draggedId) return;
        const targetId = target?.pageId ?? null;
        if (!canMovePage(draggedId, targetId)) {
          const dragged = pages[draggedId];
          if (dragged && (dragged.parent_id ?? null) !== targetId && dragged.id !== targetId) {
            toast(dragged.share_space_id
              ? "A shared page stays where it is shared"
              : "Only people with Full access can move a page out of a shared page", "info");
          }
          return;
        }
        movePage(draggedId, targetId);
        reveal(target);
      },
    };
  });
  const actions = useMemo<TreeActions>(() => ({
    select: (pageId) => handlers.current?.select(pageId),
    toggle: (id) => handlers.current?.toggle(id),
    openMenu: (pageId, anchor) => handlers.current?.openMenu(pageId, anchor),
    rename: (id) => handlers.current?.rename(id),
    finishRename: (pageId, name) => handlers.current?.finishRename(pageId, name),
    createInside: (pageId) => handlers.current?.createInside(pageId),
    dragOver: (target, event) => handlers.current?.dragOver(target, event) ?? false,
    drop: (target, event) => handlers.current?.drop(target, event),
  }), []);

  /** A block's row, in the tree or in Favorites. */
  const branch = (page: NotePage, depth: number, source: PageTree): ReactNode => {
    // A page holds pages — its blocks among them, a block being a page —
    // listed under it; a database, its rows.
    const children = source.children.get(page.id) ?? [];
    const open = expanded.has(page.id);
    return (
      <div className="tree-branch" key={page.id}>
        <TreeRow
          page={page}
          depth={depth}
          branch={children.length > 0}
          open={open}
          selected={selectedPageId === page.id}
          renaming={renaming === page.id}
          menuOpen={rowMenu?.pageId === page.id}
          editable={canEdit(page.id)}
          movable={canMovePage(page.id, undefined)}
          linked={linkedPage(page)}
          people={page.share_space_id ? rosters[page.share_space_id]?.members : undefined}
          me={me}
          actions={actions}
        />
        {open && children.length > 0 ? (
          <div className="tree-children" style={{ "--tree-depth": depth } as CSSProperties}>
            {children.map((child) => branch(child, depth + 1, source))}
          </div>
        ) : null}
      </div>
    );
  };

  const beforeAccountSettings = useCallback(() => { if (folded) setDrawerOpen(true); }, [folded, setDrawerOpen]);

  const accountFoot = (compact: boolean) => (
    <>
      <SpaceSwitcher compact={compact} onSwitch={afterNavigate} />
      <Tooltip label="Trash" placement="top-start">
        <button type="button" ref={trashRef} className="icon-btn" aria-label="Trash" onClick={() => setTrashOpen(true)}>
          <Trash2 size={16} />
        </button>
      </Tooltip>
      <AccountSettingsButton onOpen={beforeAccountSettings} />
    </>
  );

  const flatRow = (page: NotePage) => (
    <div className="tree-branch" key={page.id}>
      <TreeRow
        page={page}
        depth={0}
        branch={false}
        open={false}
        selected={selectedPageId === page.id}
        renaming={renaming === page.id}
        menuOpen={rowMenu?.pageId === page.id}
        editable={canEdit(page.id)}
        movable={false}
        linked={linkedPage(page)}
        people={page.share_space_id ? rosters[page.share_space_id]?.members : undefined}
        me={me}
        actions={actions}
      />
    </div>
  );

  const list = (
    <>
      <div className="sidebar__head">
        <div className="sidebar__topbar">
          <button type="button" className="sidebar__search" aria-label="Search" onClick={() => setQuickFindOpen(true)}>
            <Search size={15} aria-hidden="true" />
            <span>搜索或跳转…</span>
            <kbd>⌘K</kbd>
          </button>
          <Tooltip label="新建页面或数据库">
            <button
              type="button"
              className={`sidebar__new ${newMenu ? "is-active" : ""}`}
              aria-label="新建"
              disabled={!writable}
              title={!writable ? "当前空间只读" : undefined}
              aria-haspopup="menu"
              aria-expanded={Boolean(newMenu)}
              data-pop-group="sidebar-new"
              onClick={(event) => toggleNewMenu(event.currentTarget)}
            >
              <SquarePen size={15} aria-hidden="true" />
            </button>
          </Tooltip>
          {!folded ? (
            <Tooltip label="Collapse to rail" hint="⌘\">
              <button
                type="button"
                className="icon-btn sidebar__collapse"
                aria-label="Collapse to rail"
                onClick={() => setPreference("sidebar_collapsed", true)}
              >
                <PanelLeft size={15} />
              </button>
            </Tooltip>
          ) : null}
        </div>
        <div className="sidebar__views" role="tablist" aria-label="Page list" aria-orientation="vertical">
          {SIDEBAR_VIEWS.map((value) => {
            const Icon = VIEW_ICONS[value];
            return (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={view === value}
                aria-label={capitalized(value)}
                tabIndex={view === value ? 0 : -1}
                className={`sidebar__view ${view === value ? "is-active" : ""}`}
                onClick={() => setPreference("sidebar_view", value)}
                onKeyDown={(event) => {
                  const index = SIDEBAR_VIEWS.indexOf(value);
                  const next = event.key === "ArrowDown" ? (index + 1) % SIDEBAR_VIEWS.length
                    : event.key === "ArrowUp" ? (index + SIDEBAR_VIEWS.length - 1) % SIDEBAR_VIEWS.length
                    : event.key === "Home" ? 0
                    : event.key === "End" ? SIDEBAR_VIEWS.length - 1
                    : null;
                  if (next === null) return;
                  event.preventDefault();
                  setPreference("sidebar_view", SIDEBAR_VIEWS[next]);
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
                }}
              >
                <span className={`sidebar__view-icon sidebar__view-icon--${value}`}><Icon size={15} aria-hidden="true" /></span>
                <span className="sidebar__view-label">{VIEW_LABELS[value]}</span>
                {viewCounts[value] !== undefined ? (
                  <span className="sidebar__view-count" aria-hidden="true">{viewCounts[value]}</span>
                ) : <span className="sidebar__view-dot" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="sidebar__tools" role="toolbar" aria-label={capitalized(view)}>
        <span className="sidebar__section-title">{SECTION_LABELS[view]}</span>
        {view === "files" ? (
          <span className={`sidebar__section-actions ${sortMenu ? "is-active" : ""}`}>
            <Tooltip label={`排序：${SORT_LABELS[sort]}`}>
              <button
                type="button"
                className={`icon-btn ${sortMenu ? "is-active" : ""}`}
                aria-label="Change sort order"
                aria-haspopup="menu"
                aria-expanded={Boolean(sortMenu)}
                disabled={!writable}
                onClick={(event) => setSortMenu(rectOf(event.currentTarget))}
              >
                <ArrowUpNarrowWide size={13} />
              </button>
            </Tooltip>
            <Tooltip label="收起全部子页面">
              <button type="button" className="icon-btn" aria-label="Collapse all" onClick={() => updateExpanded(() => new Set())}>
                <ChevronsDownUp size={13} />
              </button>
            </Tooltip>
          </span>
        ) : null}
      </div>

      {view === "graph" ? (
        <Suspense fallback={<div className="graph" aria-busy="true" />}>
          <GraphView
            selectedPageId={selectedPageId}
            onOpenPage={(pageId) => { selectPage(pageId); afterNavigate(); }}
            onOpenAsPage={() => { openGraph(); afterNavigate(); }}
          />
        </Suspense>
      ) : (
        <div
          ref={scrollRef}
          className={`sidebar__scroll scroller ${rootDrop ? "is-drop-target" : ""}`}
          role="tree"
          aria-label={capitalized(view)}
          onDragOver={(event) => {
            if (!writable || view !== "files" || !event.dataTransfer.types.includes(PAGE_DRAG)) return;
            event.preventDefault();
            setRootDrop(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setRootDrop(false);
          }}
          onDrop={(event) => {
            setRootDrop(false);
            if (view === "files") actions.drop(null, event);
          }}
        >
          {view === "files" ? (
            tree.roots.length ? tree.roots.map((page) => branch(page, 0, tree)) : (
              writable ? <button type="button" className="rail-invite" onClick={() => createIn(null, "document")}>
                <Plus size={15} />New page
              </button> : <div className="sidebar__empty"><p>当前空间没有页面</p></div>
            )
          ) : null}

          {view === "favorites" ? (
            favorites.length ? favorites.map((favorite) => flatRow(favorite)) : (
              <div className="sidebar__empty">
                <Star size={18} />
                <p>Star a page or a block to keep it here.</p>
              </div>
            )
          ) : null}

          {view === "shared" ? (
            <>
              {sharedWithMe.length ? (
                <section className="sidebar__group">
                  <h3 className="sidebar__group-title">Shared with you</h3>
                  {sharedWithMe.map((page) => branch(page, 0, tree))}
                </section>
              ) : null}
              <section className="sidebar__group">
                <h3 className="sidebar__group-title">
                  <span>Shared by you</span>
                  <Tooltip label="New shared page">
                    <button type="button" className="icon-btn icon-btn--sm" aria-label="New shared page" disabled={!writable} onClick={createShared}>
                      <Plus size={15} />
                    </button>
                  </Tooltip>
                </h3>
                {sharedByMe.length ? sharedByMe.map((page) => branch(page, 0, tree)) : (
                  <button type="button" className="rail-invite" disabled={!writable} onClick={createShared}>
                    <UserPlus size={15} />New shared page
                  </button>
                )}
              </section>
            </>
          ) : null}
        </div>
      )}

      {!railed || folded ? <footer className="sidebar__foot">{accountFoot(false)}</footer> : null}
    </>
  );

  const menuEditable = menuPage ? canEdit(menuPage.id) : false;
  const menuTrashable = menuPage ? canTrashPage(menuPage.id) : false;
  const menuIsHome = Boolean(menuPage && activeSpace?.knowledgeBase?.homePageId === menuPage.id);

  return (
    <>
      {railed ? (
        <nav className="rail" aria-label="Notes navigation">
          <div className="rail__group">
            <Tooltip label={folded ? "All pages" : "Show the list"} hint={folded ? undefined : "⌘\\"} placement="right-start">
              <button
                type="button"
                className={`icon-btn rail__btn ${drawered ? "is-on" : ""}`}
                aria-label="All pages"
                aria-expanded={folded ? drawered : undefined}
                onClick={showList}
              >
                <PanelLeft size={17} />
              </button>
            </Tooltip>
            <Tooltip label="Search" hint="⌘K" placement="right-start">
              <button type="button" className="icon-btn rail__btn" aria-label="Search" onClick={() => setQuickFindOpen(true)}>
                <Search size={17} />
              </button>
            </Tooltip>
            <Tooltip label="新建" placement="right-start">
              <button
                type="button"
                className={`icon-btn rail__btn ${newMenu ? "is-active" : ""}`}
                aria-label="新建"
                disabled={!writable}
                aria-haspopup="menu"
                aria-expanded={Boolean(newMenu)}
                data-pop-group="sidebar-new"
                onClick={(event) => toggleNewMenu(event.currentTarget)}
              >
                <Plus size={17} aria-hidden="true" />
              </button>
            </Tooltip>
          </div>

          {/* A rail of identical file marks would be no navigation at all, so
              it carries the pages that were named on purpose: the starred
              ones. Everything else is one press away in the drawer. */}
          {favorites.length ? (
            <div className="rail__group rail__group--pages scroller">
              {favorites.map((page) => {
                const label = pageName(page);
                const current = selectedPageId === page.id;
                return (
                  <Tooltip key={page.id} label={label} placement="right-start">
                    <button
                      type="button"
                      className={`icon-btn rail__btn ${current ? "is-current" : ""}`}
                      aria-label={label}
                      aria-current={current ? "page" : undefined}
                      onClick={() => { actions.select(page.id); }}
                    >
                      {pageGlyph(page, 17)}
                    </button>
                  </Tooltip>
                );
              })}
            </div>
          ) : <div className="rail__group rail__group--pages" />}

          {!folded ? <div className="rail__group rail__group--foot">{accountFoot(true)}</div> : null}
        </nav>
      ) : null}

      <aside
        ref={asideRef}
        className={[
          "sidebar",
          railed ? "sidebar--drawer" : "",
          drawered ? "is-open" : "",
          resizing ? "is-resizing" : "",
        ].filter(Boolean).join(" ")}
        aria-label="Pages"
        role={drawered ? "dialog" : undefined}
        aria-modal={drawered ? true : undefined}
        aria-hidden={railed && !drawered ? true : undefined}
        inert={railed && !drawered ? true : undefined}
      >
        {list}
        {!railed ? (
          <div
            className={`sidebar__resize ${resizing ? "is-dragging" : ""}`}
            role="separator"
            aria-label="Resize the page list"
            aria-orientation="vertical"
            onPointerDown={onResizeStart}
          />
        ) : null}
      </aside>

      {drawered ? (
        <button type="button" tabIndex={-1} className="sidebar__scrim is-shown" aria-label="Close the page list" onClick={() => setDrawerOpen(false)} />
      ) : null}

      <Popover
        open={Boolean(newMenu)}
        anchor={newMenu}
        placement="bottom-start"
        role="presentation"
        group="sidebar-new"
        onDismiss={(reason) => {
          setNewMenu(null);
          if (reason === "escape") newTriggerRef.current?.focus({ preventScroll: true });
        }}
      >
        <MenuList label="新建" autoFocus>
          <MenuItem icon={<FileText size={16} />} label="页面" disabled={!writable} onSelect={() => createIn(null, "document")} />
          <MenuItem icon={<Table2 size={16} />} label="数据库" disabled={!writable} onSelect={() => createIn(null, "database")} />
        </MenuList>
      </Popover>

      <Popover open={Boolean(sortMenu)} anchor={sortMenu} placement="bottom-start" label="Sort" onDismiss={() => setSortMenu(null)}>
        <MenuList label="Sort" autoFocus>
          {SORTS.map((sort, index) => (
            <div key={sort}>
              {index === 2 || index === 4 ? <MenuDivider /> : null}
              <MenuItem
                label={SORT_LABELS[sort]}
                selected={sidebarSort === sort}
                disabled={!writable}
                onSelect={() => {
                  setSortMenu(null);
                  if (writable) void setSidebarSort(sort).catch((reason: unknown) => toast(reason instanceof Error ? reason.message : "无法保存排序，请重试。", "error"));
                }}
              />
            </div>
          ))}
        </MenuList>
      </Popover>

      <Popover
        open={Boolean(rowMenu)}
        anchor={rowMenu?.anchor ?? null}
        placement="bottom-start"
        label="Page actions"
        onDismiss={() => setRowMenu(null)}
      >
        {menuPage ? (
          <MenuList label="Page actions" autoFocus>
            <MenuItem
              icon={<Star size={16} />}
              label={isFavorite(menuPage.id) ? "Remove from favorites" : "Add to favorites"}
              onSelect={() => { toggleFavorite(menuPage.id); setRowMenu(null); }}
            />
            <MenuItem icon={<UserPlus size={16} />} label="Share…" onSelect={() => { selectPage(menuPage.id); requestShare(menuPage.id); setRowMenu(null); }} />
            <MenuItem icon={<Link size={16} />} label="Copy link" onSelect={() => { copyPageLink(menuPage.id); setRowMenu(null); }} />
            {menuEditable ? (
              <>
                <MenuItem icon={<Copy size={16} />} label="Duplicate" disabled={menuIsHome} onSelect={() => { if (!menuIsHome) { duplicatePage(menuPage.id); setRowMenu(null); } }} />
                <MenuItem icon={<FileText size={16} />} label="Rename" onSelect={() => { setRenaming(menuPage.id); setRowMenu(null); }} />
              </>
            ) : null}
            {menuTrashable ? (
              <>
                <MenuDivider />
                <MenuItem
                  icon={<Trash2 size={16} />}
                  label="Move to trash"
                  tone="danger"
                  onSelect={() => { archivePage(menuPage.id); setRowMenu(null); toast("Moved to trash", "success"); }}
                />
              </>
            ) : null}
          </MenuList>
        ) : null}
      </Popover>

      {trashOpen ? <TrashMenu anchor={trashRef.current ? rectOf(trashRef.current) : null} onClose={() => setTrashOpen(false)} /> : null}

    </>
  );
}
