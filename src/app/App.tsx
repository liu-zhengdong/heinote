import { CircleAlert, Clock3, Eye, FileText, NotebookPen, Plus, RotateCcw, Trash2 } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { routes } from "../platform/schema";
import { DatabasePage } from "../features/database/DatabasePage";
import { AppPage } from "../features/artifact/AppPage";
import { SidePeek, usePeekLayout } from "../features/database/SidePeek";
import { DocumentEditor } from "../features/editor/DocumentEditor";
import { linkedPageId } from "../features/editor/mentions";
import { QuickFind } from "../features/quickfind/QuickFind";
import { Sidebar } from "../features/sidebar/Sidebar";
import { DeletePageConfirm } from "../features/sidebar/TrashView";
import { TopBar } from "../features/topbar/TopBar";
import { MobileDock } from "../features/mobile/MobileDock";
import { MobileEditBar } from "../features/editor/MobileEditBar";
import { getActiveEditSurface } from "./edit-surface";
import { AccountSettings } from "../features/account/AccountSettings";
import { useSession } from "../features/account/AuthGate";
import { useFold } from "../hooks/useFold";
import { useVisualViewport } from "../hooks/useVisualViewport";
import type { NotePage } from "../core/types";
import { SIDEBAR_RAIL_WIDTH } from "../core/workspace-state";
import { imeComposing } from "../core/keyboard";
import { useUi } from "./ui-context";
import { pageName } from "../core/block-tree";
import { pageAncestry } from "../core/page-tree";
import { useWorkspace } from "./workspace-context";
import { usePage, useWorkspaceState, useWorkspaceStore } from "./workspace-store";

/* Sharing, page history and the graph are loaded the first time they are opened. */
const ShareDialog = lazy(() => import("../features/share/ShareDialog").then((module) => ({ default: module.ShareDialog })));
const HistoryPanel = lazy(() => import("../features/history/HistoryPanel").then((module) => ({ default: module.HistoryPanel })));
const SnapshotPreview = lazy(() => import("../features/history/SnapshotPreview").then((module) => ({ default: module.SnapshotPreview })));
const GraphView = lazy(() => import("../features/sidebar/GraphView").then((module) => ({ default: module.GraphView })));
const AdminConsole = lazy(() => import("../features/admin/AdminConsole").then((module) => ({ default: module.AdminConsole })));

/** The open page's editor, redrawn as the page changes — the shell around it
 *  is not. A page whose body is still being pulled in (UC-48) shows a quiet
 *  loading row where its words will be. */
function OpenPage({ pageId, preview, readOnly }: { pageId: string; preview: NotePage | null; readOnly: boolean }) {
  const page = usePage(pageId);
  const { loadPages } = useWorkspace();
  useEffect(() => { loadPages([pageId]); }, [loadPages, pageId]);
  if (!page) return null;
  if (!preview && page.block_tree === undefined) {
    return <div className="page-loading" aria-busy="true"><span className="page-loading__line" /><span className="page-loading__line" /><span className="page-loading__line" /></div>;
  }
  return <DocumentEditor page={preview ?? page} readOnly={readOnly} historical={Boolean(preview)} />;
}

/** An app page redrawn as the page changes — its run surface and editor. */
function AppPageShell({ pageId }: { pageId: string }) {
  const page = usePage(pageId);
  if (!page) return null;
  return <AppPage page={page} />;
}

export function App() {
  const {
    selectedPageId, loading, error, preferences, createPage, selectPage, setPreference, canEdit, canDeletePage, graphOpen, restorePage, deletePage, activeSpace, activeSpaceId, switchSpace, saveNow,
  } = useWorkspace();
  const store = useWorkspaceStore();
  const { user, githubOutcome, clearGithubOutcome } = useSession();
  const {
    setQuickFindOpen,
    drawerOpen,
    setDrawerOpen,
    sharePageId,
    closeShare,
    peekPageId,
    openPeek,
    closePeek,
    toast,
    adminOpen,
    setAdminOpen,
    historyOpen,
    setHistoryOpen,
    accountSettingsOpen,
    accountSettingsNotice,
    openAccountSettings,
    closeAccountSettings,
  } = useUi();

  useEffect(() => {
    if (!user || !githubOutcome) return;
    openAccountSettings(githubOutcome);
    clearGithubOutcome();
  }, [clearGithubOutcome, githubOutcome, openAccountSettings, user]);
  /* Opened once, the panel stays mounted, so it can slide out as it closes. */
  const [historyUsed, setHistoryUsed] = useState(false);
  const [historyPreview, setHistoryPreview] = useState<NotePage | null>(null);
  const [surfaceEl, setSurfaceEl] = useState<HTMLElement | null>(null);
  const mobile = useFold();
  const { keyboardOpen } = useVisualViewport(mobile);
  const previousKeyboardOpen = useRef(false);
  useEffect(() => {
    const wasOpen = previousKeyboardOpen.current;
    previousKeyboardOpen.current = keyboardOpen;
    if (!mobile || !wasOpen || keyboardOpen) return;
    const current = getActiveEditSurface();
    if (current && !current.subOverlayOpen) current.done();
  }, [keyboardOpen, mobile]);
  /* Same sum the Sidebar does. The shell only needs it for the width of the
     first track; on mobile there is no rail track at all. */
  const railed = !mobile && preferences.sidebar_collapsed;

  /* The side peek is laid out by the shell: docked beside the page when the
     page pane holds both, over it when it does not. */
  const [shell, setShell] = useState<HTMLDivElement | null>(null);
  const peek = usePeekLayout(shell, mobile ? 0 : railed ? SIDEBAR_RAIL_WIDTH : preferences.sidebar_width);
  /* What the shell draws of the workspace — the open page's kind, whether
     the row in the peek is still there, whether sharing still follows the
     page — each read on its own, so typing redraws none of it. */
  const selectedKind = useWorkspaceState((state) => state.pages[selectedPageId]?.kind ?? null);
  // Opened from the trash, the page is read where it is: the page in the
  // trash, itself or above it, is the one Restore brings back.
  const trashedAt = useWorkspaceState((state) => pageAncestry(state.pages, selectedPageId).find((page) => page.archived)?.id ?? null);
  const trashedTitle = useWorkspaceState((state) => trashedAt && state.pages[trashedAt] ? pageName(state.pages[trashedAt]) || "Untitled" : "");
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const removeTrashedPage = useCallback(async () => {
    if (!trashedAt || deleting) return;
    setDeleting(true);
    setConfirmDelete(false);
    try { await deletePage(trashedAt); toast("Deleted permanently", "success"); }
    catch (reason) { toast(reason instanceof Error ? reason.message : "页面未删除。", "error"); }
    finally { setDeleting(false); }
  }, [trashedAt, deleting, deletePage, toast]);
  // Gone, the peek closes.
  const peekOpen = useWorkspaceState((state) => {
    const peeked = peekPageId ? state.pages[peekPageId] : undefined;
    return Boolean(peeked && !peeked.archived);
  });
  const sharePage = usePage(sharePageId);
  /* Sharing follows the page it was opened for — the page, the row open
     beside it, or a page inside either, as a block drawn in it is. */
  const shareFollows = useWorkspaceState((state) => !sharePageId
    || pageAncestry(state.pages, sharePageId).some((page) => page.id === selectedPageId || page.id === peekPageId));

  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    setHistoryPreview(null);
  }, [setHistoryOpen]);

  /* Workspace-level shortcuts. ⌘K opens Quick Find, ⌘\ folds the list and
     ⌘⇧N starts a page — the three Notion reaches for without a menu. On a
     window too narrow for the list, ⌘\ can only mean the drawer: the fold is
     already the window's, and toggling the member's preference there would
     change nothing they could see. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      /* ⌘/Ctrl+S means "make sure it's saved", not the browser's page
         download: wait on what is still in flight and say where it landed.
         It is taken before the IME check — even mid-composition the system
         save dialog must never open. */
      if (key === "s") {
        event.preventDefault();
        void saveNow().then((status) => {
          if (status === "saved") toast("已保存", "success");
          else if (status === "refused") toast("部分更改未能保存，已保留为草稿", "error");
          else toast("尚未全部保存，联网后会自动完成", "info");
        });
        return;
      }
      if (imeComposing(event)) return;
      if (key === "k" && !event.shiftKey) {
        // Words selected in a page took it for a link.
        if (event.defaultPrevented) return;
        event.preventDefault();
        setQuickFindOpen(true);
        return;
      }
      if (key === "\\") {
        event.preventDefault();
        if (mobile) setDrawerOpen(!drawerOpen);
        else setPreference("sidebar_collapsed", !preferences.sidebar_collapsed);
        return;
      }
      if (key === "n" && event.shiftKey) {
        event.preventDefault();
        createPage(null, "document");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [createPage, drawerOpen, mobile, preferences.sidebar_collapsed, saveNow, setDrawerOpen, setPreference, setQuickFindOpen, toast]);

  /* A page id in the fragment opens that page — the target of every "Copy
     link" in the app, a block's too: a block is a page. So does a place
     the window is asked to go to, `/?page=<id>` — the address the window
     was opened at, or one handed to it while it is open (`routes.listen` in
     the platform shim: today a `popstate` listener). Each is honoured
     once: it is asked again as pages arrive, and must not drag the reader
     back after they navigate away. */
  const openedFromHash = useRef("");
  const wantedPage = useRef<string | null>(new URLSearchParams(window.location.search).get("page"));
  useEffect(() => {
    const openWanted = () => {
      const wanted = wantedPage.current;
      const id = wanted ? linkedPageId(wanted, store.getState().pages) : null;
      if (!id) return;
      wantedPage.current = null;
      selectPage(id);
    };
    const openFromHash = () => {
      const link = window.location.hash;
      if (!link || openedFromHash.current === link) return;
      const id = linkedPageId(link, store.getState().pages);
      if (!id) return;
      openedFromHash.current = link;
      selectPage(id);
    };
    const open = () => {
      openWanted();
      openFromHash();
    };
    open();
    const stop = store.subscribe(open);
    window.addEventListener("hashchange", openFromHash);
    const stopRoutes = routes.listen((route) => {
      const place = new URL(route, window.location.origin);
      if (place.pathname !== "/admin") setAdminOpen(false);
      else setAdminOpen(true);
      wantedPage.current = place.searchParams.get("page") ?? (place.hash.length > 1 ? place.hash : null);
      openWanted();
    });
    return () => {
      stop();
      stopRoutes();
      window.removeEventListener("hashchange", openFromHash);
    };
  }, [selectPage, store]);

  /* The address says which page is open — `?page=<id>`, the place a link or
     an agent's `open` brings the window back to — so the desktop can tell an
     agent where the window is (`whats_open`). Replaced, never pushed: it is
     no step of the browser's history. */
  useEffect(() => {
    const here = new URL(window.location.href);
    if (selectedPageId) here.searchParams.set("page", selectedPageId);
    else here.searchParams.delete("page");
    if (here.href !== window.location.href) window.history.replaceState(window.history.state, "", here);
  }, [selectedPageId]);

  /* A peeked row's history belongs to the row as a page: opening it selects
     the row, and the page-change cleanup below then opens it — doing it in
     the handler would race the same cleanup it must survive. */
  const historyForRef = useRef<string | null>(null);

  /* Going to another page closes what belonged to this one: its history, the
     drawer that led there, and the row open beside it — unless the move was
     the history itself reaching a peeked row. */
  useEffect(() => {
    if (historyForRef.current === selectedPageId) {
      historyForRef.current = null;
      setHistoryOpen(true);
      setHistoryUsed(true);
    } else {
      closeHistory();
    }
    setDrawerOpen(false);
    closePeek();
  }, [closeHistory, closePeek, selectedPageId, setDrawerOpen]);

  // The graph opened in the page pane takes the page's history with it.
  useEffect(() => {
    if (graphOpen) closeHistory();
  }, [closeHistory, graphOpen]);

  // A row that undo took away, or that went to the trash, closes its peek
  // rather than leaving it open on nothing.
  useEffect(() => {
    if (peekPageId && !peekOpen) closePeek();
  }, [closePeek, peekOpen, peekPageId]);

  // Leaving the page sharing was opened for closes it.
  useEffect(() => {
    if (!shareFollows) closeShare();
  }, [closeShare, shareFollows]);

  if (loading) {
    return (
      <div className="state-screen state-screen--loading" role="status" aria-label="正在打开小黑笔记">
        <span className="state-screen__mark"><NotebookPen size={20} /></span>
        <p>正在打开小黑笔记…</p>
      </div>
    );
  }

  if (error) {
    return (
      <main className="state-screen">
        <span className="state-screen__mark state-screen__mark--danger"><CircleAlert size={20} /></span>
        <h1>小黑笔记无法打开</h1>
        <p>{error}</p>
        <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>Try again</button>
      </main>
    );
  }

  return (
    <div
      ref={setShell}
      className={`app-shell ${mobile ? "app-shell--mobile" : ""} ${railed ? "app-shell--railed" : ""} ${!mobile && peekOpen && peek.docked ? "app-shell--peek" : ""}`}
      style={{ ["--sidebar-w" as string]: `${preferences.sidebar_width}px`, ["--peek-w" as string]: `${peek.width}px` }}
    >
      <Sidebar />
      <div className="app-main">
        <TopBar
          onHistory={() => {
            if (historyOpen) {
              closeHistory();
              return;
            }
            // History is read beside the page it belongs to, where the peek was.
            closePeek();
            setHistoryOpen(true);
            setHistoryUsed(true);
          }}
        />
        <div className="app-workspace">
          {/* The graph, opened as a page of its own: its dots open beside
              it, in the side peek — or in its place with ⌘/Ctrl. */}
          {graphOpen ? (
            <main ref={setSurfaceEl} className="page-surface page-surface--graph">
              <Suspense fallback={<div className="graph graph--page" aria-busy="true" />}>
                <GraphView
                  variant="page"
                  selectedPageId={selectedPageId || null}
                  onOpenPage={(pageId, full) => (full ? selectPage(pageId) : openPeek(pageId))}
                />
              </Suspense>
            </main>
          ) : (
          <main ref={setSurfaceEl} className="page-surface scroller">
            {historyPreview ? (
              <div className="history-banner" role="status">
                <Clock3 size={14} />
                <span>You are looking at an older version.</span>
              </div>
            ) : trashedAt ? (
              <div className="history-banner trash-banner" role="status">
                <Trash2 size={14} />
                <span>In the trash</span>
                <button type="button" className="btn btn--outline" disabled={deleting || !canEdit(trashedAt)} onClick={() => restorePage(trashedAt, { select: false })}>
                  <RotateCcw size={13} />Restore
                </button>
                {canDeletePage(trashedAt) ? (
                  <button type="button" className="btn btn--danger" disabled={deleting} onClick={() => setConfirmDelete(true)}>
                    Delete permanently
                  </button>
                ) : null}
              </div>
            ) : selectedKind && !canEdit(selectedPageId) ? (
              <div className="history-banner" role="status">
                <Eye size={14} />
                <span>You can only view this page.</span>
              </div>
            ) : null}

            {historyPreview && historyPreview.kind !== "document" ? (
              /* A non-document checkpoint holds the page's definition, not
                 a body: show what restoring it restores. */
              <Suspense fallback={null}><SnapshotPreview page={historyPreview} /></Suspense>
            ) : selectedKind === "database" && !historyPreview ? (
              <DatabasePage readOnly={Boolean(trashedAt)} />
            ) : selectedKind === "app" && !historyPreview ? (
              <AppPageShell pageId={selectedPageId} />
            ) : selectedKind ? (
              <OpenPage key="page" pageId={selectedPageId} preview={historyPreview} readOnly={Boolean(historyPreview) || Boolean(trashedAt) || !canEdit(selectedPageId)} />
            ) : (
              <div className="empty-page">
                <FileText size={28} strokeWidth={1.4} />
                <h1>{activeSpace?.knowledgeBase ? "知识库首页尚未读取" : "No page open"}</h1>
                {activeSpace?.knowledgeBase ? (
                  <button type="button" className="btn" onClick={() => switchSpace(activeSpaceId)}>重试打开</button>
                ) : (
                  <button type="button" className="btn btn--primary" onClick={() => createPage(null, "document")}>
                    <Plus size={15} />New page
                  </button>
                )}
              </div>
            )}
          </main>
          )}
        </div>
      </div>

      <SidePeek
        docked={peek.docked}
        width={peek.width}
        pane={peek.pane}
        onResize={peek.resize}
        onHistory={() => {
          if (!peekPageId) return;
          if (peekPageId !== selectedPageId) {
            historyForRef.current = peekPageId;
            selectPage(peekPageId);
          } else {
            closePeek();
            setHistoryOpen(true);
            setHistoryUsed(true);
          }
        }}
      />
      {historyUsed ? (
        <Suspense fallback={null}>
          <HistoryPanel
            pageId={selectedKind ? selectedPageId : null}
            open={historyOpen}
            onClose={closeHistory}
            onPreview={setHistoryPreview}
          />
        </Suspense>
      ) : null}
      {sharePage ? (
        <Suspense fallback={null}>
          <ShareDialog page={sharePage} onClose={closeShare} />
        </Suspense>
      ) : null}
      <DeletePageConfirm
        open={confirmDelete}
        title={trashedTitle}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void removeTrashedPage()}
      />
      <QuickFind />
      {mobile ? <MobileDock surface={surfaceEl} historyOpen={historyOpen} /> : null}
      {mobile ? <MobileEditBar /> : null}
      {user && accountSettingsOpen ? (
        <AccountSettings
          key={`${user.id}:${accountSettingsNotice || "default"}`}
          notice={accountSettingsNotice}
          onClose={() => {
            closeAccountSettings();
            requestAnimationFrame(() => {
              const trigger = document.querySelector<HTMLElement>('.sidebar [aria-label="设置"], .rail [aria-label="设置"]');
              if (trigger?.getClientRects().length && !trigger.closest("[inert]")) trigger.focus({ preventScroll: true });
            });
          }}
        />
      ) : null}
      {adminOpen ? (
        <Suspense fallback={null}>
          <AdminConsole onClose={() => {
            // The console opened by pushing /admin, so back returns to the
            // workspace; landing straight on the URL has nothing to go back to.
            if (window.location.pathname === "/admin" && window.history.length > 1) window.history.back();
            else window.history.replaceState(null, "", "/");
            setAdminOpen(false);
          }} />
        </Suspense>
      ) : null}
    </div>
  );
}
