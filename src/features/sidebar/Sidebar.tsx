import {
  AppWindow,
  Archive,
  ArchiveRestore,
  ArrowUpNarrowWide,
  ChevronRight,
  ChevronsDownUp,
  Copy,
  FileText,
  Files,
  Link,
  FolderInput,
  PanelLeft,
  Plus,
  Search,
  Shield,
  SquarePen,
  Star,
  Table2,
  Trash2,
  UserPlus,
  Users,
  Waypoints,
  Zap,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { BottomSheet } from "../../components/BottomSheet";
import { MenuDivider, MenuItem, MenuList } from "../../components/Menu";
import { Popover } from "../../components/Popover";
import { Tooltip } from "../../components/Tooltip";
import { rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import { useFold } from "../../hooks/useFold";
import { SIDEBAR_SORTS, SIDEBAR_VIEWS } from "../../../schema";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_RAIL_WIDTH } from "../../core/workspace-state";
import type { NotePage, PageKind, SidebarSort, SidebarView } from "../../core/types";
import { pagesInSpace } from "../../core/space-navigation";
import { useWorkspace } from "../../app/workspace-context";
import { useUi } from "../../app/ui-context";
import { pageName } from "../../core/block-tree";
import { descendantPageIds, inTrash, isPurging, pageAncestry, shelvedRoot, spaceOfPage } from "../../core/page-tree";
import { buildShelvedTree, buildTree, countTree, flattenTree, linkedFromOutside, planSidebarReorder, sameListing, SORT_LABELS, type PageTree } from "./tree";
import { sameItems, useWorkspaceState } from "../../app/workspace-store";
import { useCopyPageLink } from "../../hooks/useCopyPageLink";
import { usePublicLinks } from "../share/usePublicLinks";
import { capitalized } from "../../core/title";
import { EmptyTrashConfirm, TrashView } from "./TrashView";
import { MemoSidebarPane } from "../memos/MemoSidebarPane";
import { MoveToMenu } from "../editor/MoveToMenu";
import { AccountSettingsButton } from "../account/AccountMenu";
import { useSession } from "../account/AuthGate";
import { SpaceSwitcher } from "../knowledge/SpaceSwitcher";
import {
  measureTree,
  PAGE_DRAG,
  readExpanded,
  ROW_HEIGHT_DESKTOP,
  ROW_HEIGHT_MOBILE,
  TREE_OVERSCAN,
  TREE_STEP,
  TreeRow,
  writeExpanded,
  type TreeActions,
  type TreeDropPosition,
  type TreeTarget,
} from "./TreeRow";
import "./sidebar.css";

/* The graph is loaded the first time it is looked at. */
const GraphView = lazy(() => import("./GraphView").then((module) => ({ default: module.GraphView })));

const VIEW_ICONS: Record<SidebarView, typeof Files> = { files: Files, memos: Zap, favorites: Star, shared: Users, graph: Waypoints, trash: Trash2 };
/* One word for every way a page leaves the member's private space:
   member-shared trees and public read-only links. "空间" stays with
   knowledge bases — the only real space the member navigates between. */
const VIEW_LABELS: Record<SidebarView, string> = { files: "全部页面", memos: "闪念", favorites: "收藏夹", shared: "已分享", graph: "关系图谱", trash: "回收站" };
const MOBILE_VIEW_LABELS: Record<SidebarView, string> = { files: "全部", memos: "闪念", favorites: "收藏", shared: "已分享", graph: "图谱", trash: "回收站" };
const SECTION_LABELS: Record<SidebarView, string> = { files: "笔记", memos: "闪念", favorites: "星标置顶", shared: "已分享", graph: "知识拓扑", trash: "回收站" };

const SORTS: readonly SidebarSort[] = SIDEBAR_SORTS;

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
    setPageShelved,
    archivePage,
    createPage,
    duplicatePage,
    copyPageTo,
    ensureShareSpace,
    movePage,
    selectPage,
    setPreference,
    updatePage,
    canEdit,
    canMovePage,
    canOrderPage,
    canShelvePage,
    canTrashPage,
    canDeletePage,
    deletePage,
    isFavorite,
    toggleFavorite,
    openGraph,
    ensureAllSpaces,
    directoryLoading,
  } = useWorkspace();
  const { drawerOpen, setDrawerOpen, setQuickFindOpen, requestShare, toast, adminOpen, openAdmin, closeAdmin } = useUi();
  const { user: sessionUser } = useSession();
  const isAdmin = sessionUser?.siteRole === "admin";
  const folded = useFold();

  const asideRef = useRef<HTMLElement | null>(null);
  const newTriggerRef = useRef<HTMLButtonElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const viewsRef = useRef<HTMLDivElement | null>(null);
  const lastScrolledRef = useRef("");

  const [rowMenu, setRowMenu] = useState<{ pageId: string; anchor: AnchorRect } | null>(null);
  const [copyPicker, setCopyPicker] = useState<{ pageId: string; anchor: AnchorRect } | null>(null);
  useEffect(() => {
    if (copyPicker) void ensureAllSpaces();
  }, [copyPicker, ensureAllSpaces]);
  const [newMenu, setNewMenu] = useState<AnchorRect | null>(null);
  const [sortMenu, setSortMenu] = useState<AnchorRect | null>(null);
  const [emptyTrashConfirm, setEmptyTrashConfirm] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [resizing, setResizing] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(readExpanded);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [rootDrop, setRootDrop] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const draggingIdRef = useRef<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ pageId: string; position: TreeDropPosition; depth: number } | null>(null);

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
  /* "已分享" lives in the personal space only: inside a knowledge base the
     tab is meaningless — nothing there may be shared — so fall back to the
     page list and hide the tab below. */
  const inLibrary = Boolean(activeSpace?.knowledgeBase);
  const visibleViews = useMemo(
    () => SIDEBAR_VIEWS.filter((value) => !(inLibrary && (value === "shared" || value === "memos"))),
    [inLibrary],
  );
  const view: SidebarView = inLibrary && (preferences.sidebar_view === "shared" || preferences.sidebar_view === "memos")
    ? "files"
    : preferences.sidebar_view;
  const tree = useMemo(() => buildTree(pages, sort), [pages, sort]);
  const shelvedTree = useMemo(() => buildShelvedTree(pages, sort), [pages, sort]);
  const favorites = useMemo(
    () => preferences.favorites.flatMap((id): NotePage[] => (pages[id] && !inTrash(pages, id) ? [pages[id]] : [])),
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
    () => flattenTree(tree).filter((page) => Boolean(page.share_space_id)),
    [tree],
  );
  const sharedWithMe = sharedRoots.filter((page) => !ownedByMe(page));
  const sharedByMe = sharedRoots.filter((page) => ownedByMe(page));
  /* Public read-only links: pages the member published without inviting
     anyone. Distinct pages — one page can hold several links. */
  const publicLinks = usePublicLinks();
  const linkedPages = useMemo(
    () => [...new Set(publicLinks.map((link) => link.pageId))]
      .filter((pageId) => pages[pageId] && !inTrash(pages, pageId))
      .map((pageId) => pages[pageId]),
    [publicLinks, pages],
  );
  const trashed = useMemo(() => Object.values(pages).filter((page) => page.archived && !isPurging(pages, page.id)), [pages]);
  const deletableTrash = useMemo(() => {
    const candidates = trashed.filter((page) => canDeletePage(page.id));
    const candidateIds = new Set(candidates.map((page) => page.id));
    const topTargets = candidates.filter((page) => !pageAncestry(pages, page.id).slice(0, -1).some((ancestor) => candidateIds.has(ancestor.id)));
    const affected = new Set<string>();
    for (const target of topTargets) {
      affected.add(target.id);
      for (const descendantId of descendantPageIds(pages, target.id)) {
        if (!isPurging(pages, descendantId)) affected.add(descendantId);
      }
    }
    return { topTargets, totalCount: affected.size };
  }, [canDeletePage, pages, trashed]);
  const viewCounts: Partial<Record<SidebarView, number>> = {
    files: countTree(tree),
    favorites: favorites.length,
    shared: new Set([...sharedRoots.map((page) => page.id), ...linkedPages.map((page) => page.id)]).size,
    trash: trashed.length,
  };
  /* The link mark says something links to a page from outside where it
     lives — by the one rule, a block's too. */
  const linked = linkedFromOutside(pages);
  const linkedPage = useCallback((page: NotePage) => linked.has(page.id), [linked]);

  const mobile = folded;
  const railed = !mobile && preferences.sidebar_collapsed;
  const rowHeight = mobile ? ROW_HEIGHT_MOBILE : ROW_HEIGHT_DESKTOP;
  const [scrollBucket, setScrollBucket] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(800);
  const treeMetrics = useMemo(() => measureTree(tree, expanded), [tree, expanded]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.clientHeight > 0) setViewportHeight(el.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (el.clientHeight > 0) setViewportHeight(el.clientHeight);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [railed, view]);

  const prevScopeViewRef = useRef(`${activeSpaceId}:${view}`);

  useEffect(() => {
    if (!folded && drawerOpen) setDrawerOpen(false);
  }, [drawerOpen, folded, setDrawerOpen]);

  useEffect(() => {
    if (!mobile || !drawerOpen) return;
    const strip = viewsRef.current;
    if (!strip || strip.scrollWidth <= strip.clientWidth) return;
    const activeTab = strip.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest", container: "nearest" } as ScrollIntoViewOptions);
  }, [mobile, drawerOpen, view, visibleViews.length]);

  useEffect(() => {
    if (!mobile || !drawerOpen) return;
    const strip = viewsRef.current;
    if (!strip) return;
    if (typeof CSS !== "undefined" && CSS.supports("animation-timeline", "scroll()")) return;
    const [first, last] = [strip.firstElementChild, strip.lastElementChild];
    if (!first || !last || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const { target, intersectionRatio } of entries) {
          if (target === first) strip.classList.toggle("more-start", intersectionRatio < 1);
          if (target === last) strip.classList.toggle("more-end", intersectionRatio < 1);
        }
      },
      { root: strip, threshold: 1, rootMargin: "1px" },
    );
    observer.observe(first);
    observer.observe(last);
    return () => {
      observer.disconnect();
      strip.classList.remove("more-start", "more-end");
    };
  }, [mobile, drawerOpen, visibleViews.length]);

  useEffect(() => {
    setNewMenu(null);
    setSortMenu(null);
    setRowMenu(null);
    setEmptyTrashConfirm(false);
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
    const scopeKey = `${activeSpaceId}:${view}`;
    if (prevScopeViewRef.current !== scopeKey) {
      prevScopeViewRef.current = scopeKey;
      setScrollBucket(0);
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }
    if (!selectedPageId) return;
    const key = `${activeSpaceId}:${view}:${selectedPageId}`;
    if (lastScrolledRef.current === key) return;
    if (view === "files") {
      const idx = treeMetrics.rowIndex.get(selectedPageId);
      if (idx === undefined) return;
      lastScrolledRef.current = key;
      const el = scrollRef.current;
      if (!el) return;
      const h = el.clientHeight || viewportHeight;
      const rowTop = idx * rowHeight;
      const rowBottom = rowTop + rowHeight;
      if (rowTop < el.scrollTop || rowBottom > el.scrollTop + h) {
        const target = Math.max(0, Math.round(rowTop - h / 2 + rowHeight / 2));
        el.scrollTop = target;
        const nextBucket = Math.floor(target / (rowHeight * TREE_STEP)) * TREE_STEP;
        setScrollBucket((current) => (current === nextBucket ? current : nextBucket));
      }
      return;
    }
    lastScrolledRef.current = key;
    scrollRef.current?.querySelector(`[data-page-id="${CSS.escape(selectedPageId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeSpaceId, rowHeight, selectedPageId, treeMetrics, view, viewportHeight]);

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
    const ceiling = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, window.innerWidth - SIDEBAR_RAIL_WIDTH - 280));
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

  /* "New shared page" means what it says: the page becomes a shared root
     right away (its own space is created), then the dialog invites the
     first member. Before this the page stayed private until someone was
     invited — a "shared" page that no list could see. */
  const createShared = () => {
    if (!writable) return;
    const id = createPage();
    if (!id) return;
    void ensureShareSpace(id)
      .then(() => requestShare(id))
      .catch((reason: unknown) => toast(reason instanceof Error ? reason.message : "无法创建共享空间，请重试。", "error"));
    afterNavigate();
  };

  const toggleNewMenu = (button: HTMLButtonElement) => {
    if (!writable) return;
    newTriggerRef.current = button;
    setNewMenu((current) => current ? null : rectOf(button));
  };

  const createIn = (parentId: string | null, kind: PageKind) => {
    if (!writable) return;
    if (adminOpen) closeAdmin();
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

  /* Cross-space moves are only allowed between spaces the member owns
     (personal <-> their own shared space); pages shared by others stay in
     their own tree, and content transfers across ownership via Copy to. */

  /** Opens a parent page in the list so what was dropped inside can be seen. */
  const revealParent = (parentId: string | null) => {
    if (parentId) updateExpanded((current) => new Set([...current, parentId]));
  };

  const switchToManualSort = () => {
    if (sidebarSort === "manual" || !writable) return;
    void setSidebarSort("manual").catch((reason: unknown) => toast(reason instanceof Error ? reason.message : "无法保存排序，请重试。", "error"));
  };

  /** Translates a row/root drop target into its destination parent, sibling
   *  insertion index, and indicator indent depth. */
  const resolveDropPlacement = (target: TreeTarget, draggedPageId: string | null, rowDepth = 0) => {
    const libraryHomeId = activeSpace?.knowledgeBase?.homePageId ?? null;
    if (!target) {
      const targetParentId = libraryHomeId;
      const siblings = targetParentId ? (tree.children.get(targetParentId) ?? []) : tree.roots;
      const rest = draggedPageId ? siblings.filter((item) => item.id !== draggedPageId) : siblings;
      return { targetParentId, siblings, insertIndex: rest.length, indicatorDepth: 0, revealId: targetParentId, explicitOrder: true };
    }
    const targetPage = pages[target.pageId];
    if (!targetPage) return null;
    const targetChildren = tree.children.get(targetPage.id) ?? shelvedTree.children.get(targetPage.id) ?? [];
    const targetCanHold = targetPage.kind === "document" && canEdit(targetPage.id);
    if (target.position === "inside") {
      const rest = draggedPageId ? targetChildren.filter((item) => item.id !== draggedPageId) : targetChildren;
      return { targetParentId: targetPage.id, siblings: targetChildren, insertIndex: rest.length, indicatorDepth: rowDepth, revealId: targetPage.id, explicitOrder: false };
    }
    if (target.position === "after" && expanded.has(targetPage.id) && targetChildren.length > 0 && targetCanHold) {
      return { targetParentId: targetPage.id, siblings: targetChildren, insertIndex: 0, indicatorDepth: rowDepth + 1, revealId: targetPage.id, explicitOrder: true };
    }
    const targetParentId = targetPage.parent_id ?? null;
    const siblings = targetParentId ? (tree.children.get(targetParentId) ?? shelvedTree.children.get(targetParentId) ?? []) : tree.roots;
    const rest = draggedPageId ? siblings.filter((item) => item.id !== draggedPageId) : siblings;
    const index = rest.findIndex((item) => item.id === targetPage.id);
    if (index < 0) return null;
    return {
      targetParentId,
      siblings,
      insertIndex: target.position === "before" ? index : index + 1,
      indicatorDepth: rowDepth,
      revealId: targetParentId,
      explicitOrder: true,
    };
  };

  const clearDrag = () => {
    draggingIdRef.current = null;
    setDraggingId(null);
    setDropIndicator(null);
    setRootDrop(false);
  };

  /* The row actions, one object for the list's whole life (see TreeActions),
     each reaching the list as it is now through a ref. */
  const handlers = useRef<TreeActions | null>(null);
  useLayoutEffect(() => {
    handlers.current = {
      select: (pageId) => {
        selectPage(pageId);
        if (view === "memos") setPreference("sidebar_view", "files");
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
      dragStart: (pageId) => {
        draggingIdRef.current = pageId;
        setDraggingId(pageId);
      },
      dragEnd: () => clearDrag(),
      dragOver: (target, depth, event) => {
        if (!writable || view !== "files" || !event.dataTransfer.types.includes(PAGE_DRAG)) {
          setDropIndicator(null);
          return;
        }
        setRootDrop(false);
        const activeId = draggingIdRef.current;
        if (!target) {
          setDropIndicator(null);
          return;
        }
        const targetPage = pages[target.pageId];
        if (!targetPage || targetPage.id === activeId) {
          setDropIndicator(null);
          return;
        }
        if (activeId && pageAncestry(pages, targetPage.id).some((ancestor) => ancestor.id === activeId)) {
          setDropIndicator(null);
          return;
        }
        const placement = resolveDropPlacement(target, activeId, depth);
        if (!placement) {
          setDropIndicator(null);
          return;
        }
        if (inLibrary && placement.targetParentId === null) {
          setDropIndicator(null);
          return;
        }
        if (target.position === "inside") {
          if (targetPage.kind === "database" || targetPage.kind === "app" || !canEdit(targetPage.id)) {
            setDropIndicator(null);
            return;
          }
          // Allow drop even across unauthorized spaces so onDrop surfaces the clear toast hint.
          event.preventDefault();
          const allowed = !activeId || canMovePage(activeId, placement.targetParentId);
          setDropIndicator(allowed ? { pageId: target.pageId, position: "inside", depth } : null);
          return;
        }
        const activePage = activeId ? pages[activeId] : undefined;
        const sameParent = activePage ? (activePage.parent_id ?? null) === placement.targetParentId : false;
        const allowed = !activeId
          ? true
          : sameParent
            ? canOrderPage(activeId)
            : canMovePage(activeId, placement.targetParentId);
        if (!allowed) {
          setDropIndicator(null);
          return;
        }
        event.preventDefault();
        setDropIndicator((current) => (
          current && current.pageId === target.pageId && current.position === target.position && current.depth === placement.indicatorDepth
            ? current
            : { pageId: target.pageId, position: target.position, depth: placement.indicatorDepth }
        ));
      },
      dragLeave: (pageId) => {
        setDropIndicator((current) => (current?.pageId === pageId ? null : current));
      },
      drop: (target, event) => {
        event.preventDefault();
        const draggedId = event.dataTransfer.getData(PAGE_DRAG) || draggingIdRef.current || "";
        clearDrag();
        if (!draggedId || !writable || view !== "files") return;
        const dragged = pages[draggedId];
        if (!dragged) return;
        if (target && target.pageId === draggedId) return;
        const placement = resolveDropPlacement(target, draggedId);
        if (!placement) return;
        if (inLibrary && placement.targetParentId === null) return;
        const currentParentId = dragged.parent_id ?? null;
        const sameParent = currentParentId === placement.targetParentId;
        if (!sameParent) {
          if (!canMovePage(draggedId, placement.targetParentId)) {
            if (dragged.id !== placement.targetParentId) {
              const fromSpace = spaceOfPage(pages, draggedId);
              const toSpace = placement.targetParentId ? spaceOfPage(pages, placement.targetParentId) : undefined;
              const message = dragged.share_space_id
                ? "已共享的根页面不能直接移动位置"
                : toSpace && fromSpace !== toSpace && spaces[toSpace]?.role !== "owner"
                  ? "不能将页面移入他人共享的空间，请使用「拷贝到…」"
                  : fromSpace && fromSpace !== toSpace && spaces[fromSpace]?.role !== "owner"
                    ? "不能将他人共享空间中的页面移出，请使用「拷贝到…」"
                    : "无法将页面移动到此处";
              toast(message, "info");
            }
            return;
          }
        } else if (!canOrderPage(draggedId)) {
          return;
        }
        const plan = planSidebarReorder(placement.siblings, dragged, placement.insertIndex, {
          currentSort: sort,
          now: Date.now(),
          canOrder: canOrderPage,
        });
        if (sameParent && !plan) return;
        movePage(draggedId, placement.targetParentId, plan ? { sidebarOrder: plan.sidebar_order, rewriteOrders: plan.rewrite } : {});
        if (placement.explicitOrder) switchToManualSort();
        revealParent(placement.revealId);
      },
      stepOrder: (pageId, delta) => {
        if (!writable || view !== "files" || !canOrderPage(pageId)) return;
        const page = pages[pageId];
        if (!page) return;
        const parentId = page.parent_id ?? null;
        const siblings = parentId ? (tree.children.get(parentId) ?? []) : tree.roots;
        const currentIndex = siblings.findIndex((item) => item.id === pageId);
        if (currentIndex < 0) return;
        const targetIndex = currentIndex + delta;
        if (targetIndex < 0 || targetIndex >= siblings.length) return;
        const plan = planSidebarReorder(siblings, page, targetIndex, {
          currentSort: sort,
          now: Date.now(),
          canOrder: canOrderPage,
        });
        if (!plan) return;
        movePage(pageId, parentId, { sidebarOrder: plan.sidebar_order, rewriteOrders: plan.rewrite });
        switchToManualSort();
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
    dragStart: (pageId) => handlers.current?.dragStart(pageId),
    dragEnd: () => handlers.current?.dragEnd(),
    dragOver: (target, depth, event) => handlers.current?.dragOver(target, depth, event),
    dragLeave: (pageId) => handlers.current?.dragLeave(pageId),
    drop: (target, event) => handlers.current?.drop(target, event),
    stepOrder: (pageId, delta) => handlers.current?.stepOrder(pageId, delta),
  }), []);

  const winStart = Math.max(0, scrollBucket - TREE_OVERSCAN);
  const winEnd = Math.min(treeMetrics.totalRows, scrollBucket + Math.ceil(viewportHeight / rowHeight) + TREE_STEP + TREE_OVERSCAN);

  const renderList = (items: readonly NotePage[], depth: number, startRow: number): ReactNode => {
    let cursor = startRow;
    let topSkip = 0;
    let bottomSkip = 0;
    const visible: ReactNode[] = [];
    for (const page of items) {
      const size = treeMetrics.counts.get(page.id) ?? 1;
      const end = cursor + size;
      if (end <= winStart) {
        topSkip += size;
      } else if (cursor >= winEnd) {
        bottomSkip += size;
      } else {
        visible.push(branch(page, depth, tree, cursor));
      }
      cursor = end;
    }
    return (
      <>
        {topSkip > 0 ? <div className="tree-spacer" style={{ height: topSkip * rowHeight }} aria-hidden="true" /> : null}
        {visible}
        {bottomSkip > 0 ? <div className="tree-spacer" style={{ height: bottomSkip * rowHeight }} aria-hidden="true" /> : null}
      </>
    );
  };

  /** A block's row, in the tree or in Favorites. */
  const branch = (page: NotePage, depth: number, source: PageTree, startRow?: number): ReactNode => {
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
          reorderable={view === "files" && canOrderPage(page.id)}
          dragging={draggingId === page.id}
          dropPosition={dropIndicator?.pageId === page.id ? dropIndicator.position : null}
          dropDepth={dropIndicator?.pageId === page.id ? dropIndicator.depth : depth}
          linked={linkedPage(page)}
          people={page.share_space_id ? rosters[page.share_space_id]?.members : undefined}
          me={me}
          actions={actions}
        />
        {open && children.length > 0 ? (
          <div className="tree-children" style={{ "--tree-depth": depth } as CSSProperties}>
            {startRow !== undefined ? renderList(children, depth + 1, startRow + 1) : children.map((child) => branch(child, depth + 1, source))}
          </div>
        ) : null}
      </div>
    );
  };

  /** Every deletable page in the trash, gone for good root-by-root. */
  const emptyTrash = useCallback(async () => {
    const { topTargets } = deletableTrash;
    setEmptyTrashConfirm(false);
    if (!topTargets.length) return;
    const deletedIds = new Set<string>();
    for (const page of topTargets) {
      const subtreeIds = [page.id, ...descendantPageIds(pages, page.id).filter((id) => !isPurging(pages, id))];
      try {
        await deletePage(page.id);
        for (const id of subtreeIds) deletedIds.add(id);
      } catch (reason) {
        toast(reason instanceof Error ? reason.message : "无法永久删除页面，请重试。", "error");
      }
    }
    if (deletedIds.size) toast(`${deletedIds.size} 个页面已永久删除`, "success");
  }, [deletableTrash, deletePage, pages, toast]);

  const beforeAccountSettings = useCallback(() => { if (folded) setDrawerOpen(true); }, [folded, setDrawerOpen]);

  const accountFoot = (compact: boolean) => (
    <>
      <SpaceSwitcher compact={compact} onSwitch={afterNavigate} />
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
        reorderable={false}
        dragging={false}
        dropPosition={null}
        dropDepth={0}
        linked={linkedPage(page)}
        people={page.share_space_id ? rosters[page.share_space_id]?.members : undefined}
        me={me}
        actions={actions}
      />
    </div>
  );

  const selectSidebarView = (nextView: SidebarView) => {
    if (adminOpen) closeAdmin();
    setPreference("sidebar_view", nextView);
    if (railed) setPreference("sidebar_collapsed", false);
  };

  const sectionCount = viewCounts[view];

  const list = (
    <>
      {mobile ? (
        <div className="sidebar__head">
          <div className="sidebar__topbar">
            <button type="button" className="sidebar__search" aria-label="Search" onClick={() => setQuickFindOpen(true)}>
              <Search size={15} aria-hidden="true" />
              <span>搜索或跳转…</span>
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
          </div>
          <div ref={viewsRef} className="sidebar__views" role="tablist" aria-label="Page list" aria-orientation="horizontal">
            {visibleViews.map((value) => {
              const Icon = VIEW_ICONS[value];
              const count = viewCounts[value];
              return (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={view === value}
                  aria-label={capitalized(value)}
                  tabIndex={view === value ? 0 : -1}
                  className={`sidebar__view ${view === value ? "is-active" : ""}`}
                  onClick={() => selectSidebarView(value)}
                  onKeyDown={(event) => {
                    const index = visibleViews.indexOf(value);
                    if (index < 0) return;
                    const next = event.key === "ArrowRight" ? (index + 1) % visibleViews.length
                      : event.key === "ArrowLeft" ? (index + visibleViews.length - 1) % visibleViews.length
                      : event.key === "Home" ? 0
                      : event.key === "End" ? visibleViews.length - 1
                      : null;
                    if (next === null) return;
                    event.preventDefault();
                    selectSidebarView(visibleViews[next]);
                    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
                  }}
                >
                  <span className={`sidebar__view-icon sidebar__view-icon--${value}`}><Icon size={15} aria-hidden="true" /></span>
                  <span className="sidebar__view-label">{MOBILE_VIEW_LABELS[value]}</span>
                  {count !== undefined && count > 0 ? (
                    <span className="sidebar__view-count" aria-hidden="true">{count}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="sidebar__head sidebar__head--pane">
          <SpaceSwitcher header placement="bottom-start" onSwitch={afterNavigate} />
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
        </div>
      )}

      <div className="sidebar__tools" role="toolbar" aria-label={capitalized(view)}>
        <span className="sidebar__section-title">
          <span>{SECTION_LABELS[view]}</span>
          {sectionCount !== undefined ? <span className="sidebar__section-count">{sectionCount}</span> : null}
        </span>
        {view === "trash" ? (
          <span className="sidebar__section-actions">
            <Tooltip label="Empty trash">
              <button
                type="button"
                className="icon-btn"
                aria-label="Empty trash"
                disabled={!trashed.length || !writable}
                onClick={() => setEmptyTrashConfirm(true)}
              >
                <Trash2 size={13} />
              </button>
            </Tooltip>
          </span>
        ) : null}
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
          role={view === "trash" ? undefined : "tree"}
          aria-label={capitalized(view)}
          onScroll={(event) => {
            if (view !== "files") return;
            const next = Math.floor(event.currentTarget.scrollTop / (rowHeight * TREE_STEP)) * TREE_STEP;
            setScrollBucket((current) => (current === next ? current : next));
          }}
          onDragOver={(event) => {
            if (!writable || view !== "files" || !event.dataTransfer.types.includes(PAGE_DRAG)) return;
            event.preventDefault();
            setDropIndicator(null);
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
            <>
              {tree.roots.length ? renderList(tree.roots, 0, 0) : !directoryLoading ? (
                writable ? <button type="button" className="rail-invite" onClick={() => createIn(null, "document")}>
                  <Plus size={15} />New page
                </button> : !shelvedTree.roots.length ? <div className="sidebar__empty"><p>当前空间没有页面</p></div> : null
              ) : null}
              {shelvedTree.roots.length ? (
                <section className="sidebar__group sidebar__archived" aria-label="已归档">
                  <button
                    type="button"
                    className="sidebar__archived-toggle"
                    aria-expanded={archivedOpen}
                    onClick={() => setArchivedOpen((open) => !open)}
                  >
                    <ChevronRight size={13} className={`sidebar__archived-chevron ${archivedOpen ? "is-open" : ""}`} aria-hidden="true" />
                    <Archive size={13} aria-hidden="true" />
                    <span>已归档</span>
                    <span className="sidebar__archived-count">{shelvedTree.roots.length}</span>
                  </button>
                  {archivedOpen ? (
                    <div className="sidebar__archived-list">
                      {shelvedTree.roots.map((page) => branch(page, 0, shelvedTree))}
                    </div>
                  ) : null}
                </section>
              ) : null}
              {directoryLoading ? <div className="sidebar__empty" aria-busy="true"><p>正在加载目录…</p></div> : null}
            </>
          ) : null}

          {view === "memos" ? <MemoSidebarPane /> : null}

          {view === "favorites" ? (
            favorites.length ? favorites.map((favorite) => flatRow(favorite)) : (
              <div className="sidebar__empty">
                <Star size={18} />
                <p>Star a page or a block to keep it here.</p>
              </div>
            )
          ) : null}

          {view === "trash" ? (
            <TrashView
              pages={pages}
              onOpenPage={(pageId) => {
                selectPage(pageId);
                afterNavigate();
              }}
            />
          ) : null}

          {view === "shared" ? (
            <>
              {sharedWithMe.length ? (
                <section className="sidebar__group">
                  <h3 className="sidebar__group-title">与我共享</h3>
                  {sharedWithMe.map((page) => branch(page, 0, tree))}
                </section>
              ) : null}
              <section className="sidebar__group">
                <h3 className="sidebar__group-title">
                  <span>我共享的</span>
                  <Tooltip label="新建共享页面">
                    <button type="button" className="icon-btn icon-btn--sm" aria-label="新建共享页面" disabled={!writable} onClick={createShared}>
                      <Plus size={15} />
                    </button>
                  </Tooltip>
                </h3>
                {sharedByMe.length ? sharedByMe.map((page) => branch(page, 0, tree)) : (
                  <button type="button" className="rail-invite" disabled={!writable} onClick={createShared}>
                    <UserPlus size={15} />新建共享页面
                  </button>
                )}
              </section>
              {linkedPages.length ? (
                <section className="sidebar__group">
                  <h3 className="sidebar__group-title">公开链接</h3>
                  {linkedPages.map((page) => flatRow(page))}
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      )}

      {mobile ? <footer className="sidebar__foot">{accountFoot(false)}</footer> : null}
    </>
  );

  const menuEditable = menuPage ? canEdit(menuPage.id) : false;
  const menuShelvedBy = menuPage ? shelvedRoot(pages, menuPage.id) : null;
  const menuShelveTargetId = menuShelvedBy?.id ?? menuPage?.id ?? "";
  const menuShelvable = Boolean(menuPage && canShelvePage(menuShelveTargetId));
  const menuTrashable = menuPage ? canTrashPage(menuPage.id) : false;
  const menuIsHome = Boolean(menuPage && activeSpace?.knowledgeBase?.homePageId === menuPage.id);
  const menuSpaceId = menuPage ? spaceOfPage(pages, menuPage.id) : undefined;
  const menuInLibrary = Boolean(menuSpaceId && spaces[menuSpaceId]?.knowledgeBase);
  // Where a copy may land: a document page the member can write to.
  const copyPage = copyPicker ? pages[copyPicker.pageId] : undefined;
  const copyTargets = useWorkspaceState(
    (state) => (copyPage
      ? Object.values(state.pages).filter((candidate) =>
          candidate.id !== copyPage.id && candidate.kind === "document" && !inTrash(state.pages, candidate.id) && canEdit(candidate.id))
      : null),
    (left, right) => (left && right ? sameItems(left, right) : left === right),
  );

  return (
    <>
      {!mobile ? (
        <nav className={`rail ${railed ? "rail--collapsed" : ""}`} aria-label="HeiNote navigation">
          <div className="rail__group rail__group--verbs">
            <Tooltip label={writable ? "新建页面或数据库" : "当前空间只读"} placement="right-start">
              <button
                type="button"
                className={`sidebar__new rail__new ${newMenu ? "is-active" : ""}`}
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
            <Tooltip label="搜索或跳转…" hint="⌘K" placement="right-start">
              <button
                type="button"
                className="icon-btn rail__btn sidebar__search"
                aria-label="Search"
                onClick={() => {
                  if (adminOpen) closeAdmin();
                  setQuickFindOpen(true);
                }}
              >
                <Search size={16} aria-hidden="true" />
              </button>
            </Tooltip>
          </div>

          <div className="rail__group rail__group--views" role="tablist" aria-label="Page list" aria-orientation="vertical">
            {visibleViews.map((value) => {
              const Icon = VIEW_ICONS[value];
              const count = viewCounts[value];
              const tip = count !== undefined ? `${VIEW_LABELS[value]} · ${count}` : VIEW_LABELS[value];
              const selectedTab = !adminOpen && view === value;
              return (
                <Tooltip key={value} label={tip} placement="right-start">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selectedTab}
                    aria-label={capitalized(value)}
                    tabIndex={view === value ? 0 : -1}
                    data-count={count}
                    className={`icon-btn rail__btn rail__tab rail__tab--${value} ${selectedTab ? "is-active" : ""}`}
                    onClick={() => selectSidebarView(value)}
                    onKeyDown={(event) => {
                      const index = visibleViews.indexOf(value);
                      if (index < 0) return;
                      const next = event.key === "ArrowDown" ? (index + 1) % visibleViews.length
                        : event.key === "ArrowUp" ? (index + visibleViews.length - 1) % visibleViews.length
                        : event.key === "Home" ? 0
                        : event.key === "End" ? visibleViews.length - 1
                        : null;
                      if (next === null) return;
                      event.preventDefault();
                      selectSidebarView(visibleViews[next]);
                      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
                    }}
                  >
                    <span className={`sidebar__view-icon sidebar__view-icon--${value}`}><Icon size={16} aria-hidden="true" /></span>
                  </button>
                </Tooltip>
              );
            })}
          </div>

          <div className="rail__group rail__group--foot">
            {railed && !adminOpen ? (
              <>
                <Tooltip label="Show the list" hint="⌘\" placement="right-start">
                  <button
                    type="button"
                    className="icon-btn rail__btn"
                    aria-label="All pages"
                    onClick={showList}
                  >
                    <PanelLeft size={16} />
                  </button>
                </Tooltip>
                <SpaceSwitcher compact placement="right-start" onSwitch={afterNavigate} />
              </>
            ) : null}
            {isAdmin ? (
              <Tooltip label={adminOpen ? "返回笔记" : "后台管理"} placement="right-start">
                <button
                  type="button"
                  className={`icon-btn rail__btn rail__tab rail__tab--admin ${adminOpen ? "is-active" : ""}`}
                  aria-label="后台管理"
                  aria-pressed={adminOpen}
                  onClick={() => { if (adminOpen) closeAdmin(); else openAdmin(); }}
                >
                  <span className="sidebar__view-icon sidebar__view-icon--admin"><Shield size={16} aria-hidden="true" /></span>
                </button>
              </Tooltip>
            ) : null}
            <AccountSettingsButton onOpen={beforeAccountSettings} />
          </div>
        </nav>
      ) : null}

      {mobile ? (
        <BottomSheet
          open={drawerOpen}
          label="Pages"
          size="tall"
          className="sidebar sidebar--sheet"
          scrimLabel="Close the page list"
          restoreFocusTo={() => document.querySelector<HTMLElement>('.mobile-dock [aria-label="All pages"]')}
          onClose={() => setDrawerOpen(false)}
        >
          {list}
        </BottomSheet>
      ) : !railed && !adminOpen ? (
        <aside
          ref={asideRef}
          className={["sidebar", resizing ? "is-resizing" : ""].filter(Boolean).join(" ")}
          aria-label="Pages"
        >
          {list}
          <div
            className={`sidebar__resize ${resizing ? "is-dragging" : ""}`}
            role="separator"
            aria-label="Resize the page list"
            aria-orientation="vertical"
            onPointerDown={onResizeStart}
          />
        </aside>
      ) : null}

      <Popover
        open={Boolean(newMenu)}
        anchor={newMenu}
        placement={mobile ? "bottom-start" : "right-start"}
        role="presentation"
        group="sidebar-new"
        mobileSheet={{ title: "新建" }}
        onDismiss={(reason) => {
          setNewMenu(null);
          if (reason === "escape") newTriggerRef.current?.focus({ preventScroll: true });
        }}
      >
        <MenuList label="新建" autoFocus>
          <MenuItem icon={<FileText size={16} />} label="页面" disabled={!writable} onSelect={() => createIn(null, "document")} />
          <MenuItem icon={<Table2 size={16} />} label="数据库" disabled={!writable} onSelect={() => createIn(null, "database")} />
          <MenuItem icon={<AppWindow size={16} />} label="小应用" disabled={!writable} onSelect={() => createIn(null, "app")} />
        </MenuList>
      </Popover>

      <Popover open={Boolean(sortMenu)} anchor={sortMenu} placement="bottom-start" label="Sort" mobileSheet={{ title: "排序" }} onDismiss={() => setSortMenu(null)}>
        <MenuList label="Sort" autoFocus>
          {SORTS.map((sort, index) => (
            <div key={sort}>
              {index === 1 || index === 3 || index === 5 ? <MenuDivider /> : null}
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
        mobileSheet={{ title: menuPage ? pageName(menuPage) || "页面操作" : "页面操作" }}
        onDismiss={() => setRowMenu(null)}
      >
        {menuPage ? (
          <MenuList label="Page actions" autoFocus>
            <MenuItem
              icon={<Star size={16} />}
              label={isFavorite(menuPage.id) ? "Remove from favorites" : "Add to favorites"}
              onSelect={() => { toggleFavorite(menuPage.id); setRowMenu(null); }}
            />
            <MenuItem
              icon={<UserPlus size={16} />}
              label={menuInLibrary ? "成员…" : "Share…"}
              onSelect={() => { selectPage(menuPage.id); requestShare(menuPage.id); setRowMenu(null); }}
            />
            <MenuItem icon={<Link size={16} />} label="Copy link" onSelect={() => { copyPageLink(menuPage.id); setRowMenu(null); }} />
            {/* The only way content leaves a shared space or a knowledge
                base: a copy the server makes at the destination (fresh ids,
                attachments re-stored). */}
            <MenuItem
              icon={<FolderInput size={16} />}
              label="拷贝到…"
              onSelect={() => { setCopyPicker(rowMenu); setRowMenu(null); }}
            />
            {menuEditable ? (
              <>
                <MenuItem icon={<Copy size={16} />} label="Duplicate" disabled={menuIsHome} onSelect={() => { if (!menuIsHome) { duplicatePage(menuPage.id); setRowMenu(null); } }} />
                <MenuItem icon={<FileText size={16} />} label="Rename" onSelect={() => { setRenaming(menuPage.id); setRowMenu(null); }} />
              </>
            ) : null}
            {menuShelvable || menuTrashable ? (
              <>
                <MenuDivider />
                {menuShelvable ? (
                  <MenuItem
                    icon={menuShelvedBy ? <ArchiveRestore size={16} /> : <Archive size={16} />}
                    label={menuShelvedBy ? (menuShelvedBy.id === menuPage.id ? "取消归档" : `取消「${pageName(menuShelvedBy)}」归档`) : "归档"}
                    onSelect={() => {
                      setPageShelved(menuShelveTargetId, !menuShelvedBy);
                      setRowMenu(null);
                      toast(menuShelvedBy ? "已取消归档" : "已归档，默认在搜索中折叠", "success");
                    }}
                  />
                ) : null}
                {menuTrashable ? (
                  <MenuItem
                    icon={<Trash2 size={16} />}
                    label="Move to trash"
                    tone="danger"
                    onSelect={() => { archivePage(menuPage.id); setRowMenu(null); toast("Moved to trash", "success"); }}
                  />
                ) : null}
              </>
            ) : null}
          </MenuList>
        ) : null}
      </Popover>

      {/* "拷贝到…": choosing a page lands a copy of the row's page and its
          subtree under it — or at Files' top. */}
      {copyPicker && copyPage ? (
        <MoveToMenu
          anchor={copyPicker.anchor}
          pages={copyTargets ?? []}
          count={1}
          label="拷贝到…"
          placeholder="拷贝到…"
          onMove={(targetId) => {
            setCopyPicker(null);
            void copyPageTo(copyPage.id, targetId).then((copyId) => {
              if (copyId) { selectPage(copyId); toast("已拷贝", "success"); }
              else toast("无法拷贝此页面", "error");
            }).catch((reason: unknown) => toast(reason instanceof Error ? reason.message : "无法拷贝此页面", "error"));
          }}
          onMoveToTop={() => {
            setCopyPicker(null);
            void copyPageTo(copyPage.id, null).then((copyId) => {
              if (copyId) { selectPage(copyId); toast("已拷贝到个人空间", "success"); }
              else toast("无法拷贝此页面", "error");
            }).catch((reason: unknown) => toast(reason instanceof Error ? reason.message : "无法拷贝此页面", "error"));
          }}
          onClose={() => setCopyPicker(null)}
        />
      ) : null}

      <EmptyTrashConfirm
        open={emptyTrashConfirm}
        count={deletableTrash.topTargets.length}
        totalCount={deletableTrash.totalCount}
        onCancel={() => setEmptyTrashConfirm(false)}
        onConfirm={() => void emptyTrash()}
      />

    </>
  );
}
