import { Archive, Clock3, Eye, FileText, Plus, RotateCcw, Trash2 } from "lucide-react";
import { lazy, Suspense, useCallback, useState, type CSSProperties, type DragEvent } from "react";
import { isPurging, pageAncestry, shelvedRoot } from "../core/page-tree";
import { pageName } from "../core/block-tree";
import type { PaneId, PaneState } from "../core/tab-layout";
import type { NotePage } from "../core/types";
import type { ImportJobDto } from "../features/account/useImports";
import { TAB_DRAG, TabBar } from "../features/tabs/TabBar";
import { TopBar } from "../features/topbar/TopBar";
import { PAGE_DRAG } from "../features/sidebar/TreeRow";
import { CachedDocumentPages, OpenPage } from "./CachedDocumentPages";
import { useUi } from "./ui-context";
import { useWorkspace } from "./workspace-context";
import { usePage, useWorkspaceState } from "./workspace-store";

const DatabasePage = lazy(() => import("../features/database/DatabasePage").then((module) => ({ default: module.DatabasePage })));
const AppPage = lazy(() => import("../features/artifact/AppPage").then((module) => ({ default: module.AppPage })));
const SnapshotPreview = lazy(() => import("../features/history/SnapshotPreview").then((module) => ({ default: module.SnapshotPreview })));
const GraphView = lazy(() => import("../features/sidebar/GraphView").then((module) => ({ default: module.GraphView })));
const ImportProgressView = lazy(() => import("../features/account/ImportProgressView").then((module) => ({ default: module.ImportProgressView })));

function AppPageShell({ pageId }: { pageId: string }) {
  const page = usePage(pageId);
  if (!page) return null;
  return (
    <Suspense fallback={<div className="page-loading" aria-busy="true"><span className="page-loading__line" /><span className="page-loading__line" /><span className="page-loading__line" /></div>}>
      <AppPage page={page} />
    </Suspense>
  );
}

export function WorkspacePane({
  paneId,
  paneState,
  mobile,
  splitActive,
  isFocused,
  showSaveStatus,
  historyPreview,
  selectedImportJob,
  style,
  onHistory,
  onSurfaceRef,
  onConfirmPermanentDelete,
}: {
  paneId: PaneId;
  paneState: PaneState;
  mobile: boolean;
  splitActive: boolean;
  isFocused: boolean;
  showSaveStatus: boolean;
  historyPreview: NotePage | null;
  selectedImportJob: ImportJobDto | null;
  style?: CSSProperties;
  onHistory(): void;
  onSurfaceRef?(element: HTMLElement | null): void;
  onConfirmPermanentDelete(trashedAt: string): void;
}) {
  const {
    createPage,
    selectPage,
    openInRightSplit,
    moveTab,
    focusPane,
    setPageShelved,
    restorePage,
    canEdit,
    canShelvePage,
    canRestorePage,
    canDeletePage,
    graphOpen,
    activeSpace,
    activeSpaceId,
    switchSpace,
  } = useWorkspace();
  const { openPeek, toast } = useUi();
  const [surfaceEl, setSurfaceEl] = useState<HTMLElement | null>(null);
  const [rightDropVisible, setRightDropVisible] = useState(false);

  const pageId = paneState.activePageId;
  const pinnedIds = paneState.tabs.filter((tab) => tab.pinned).map((tab) => tab.pageId);

  const setSurface = useCallback((element: HTMLElement | null) => {
    setSurfaceEl(element);
    if (isFocused) onSurfaceRef?.(element);
  }, [isFocused, onSurfaceRef]);

  const selectedKind = useWorkspaceState((state) => {
    if (!pageId || isPurging(state.pages, pageId)) return null;
    return state.pages[pageId]?.kind ?? null;
  });

  const trashedAt = useWorkspaceState((state) => (
    !pageId || isPurging(state.pages, pageId)
      ? null
      : pageAncestry(state.pages, pageId).find((page) => page.archived)?.id ?? null
  ));
  const shelvedBy = useWorkspaceState((state) => (
    !pageId || isPurging(state.pages, pageId) ? null : shelvedRoot(state.pages, pageId)
  ));
  const shelvedTitle = useWorkspaceState((state) => (
    shelvedBy && state.pages[shelvedBy.id] ? pageName(state.pages[shelvedBy.id]) || "Untitled" : ""
  ));

  const showHistoryPreview = isFocused ? historyPreview : null;
  const showImportJob = isFocused ? selectedImportJob : null;
  const showGraph = isFocused && graphOpen;
  const SurfaceTag = isFocused ? "main" : "section";

  const handleDragOverSplitZone = (event: DragEvent<HTMLDivElement>) => {
    if (mobile || splitActive) return;
    if (!event.dataTransfer.types.includes(TAB_DRAG) && !event.dataTransfer.types.includes(PAGE_DRAG)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const inRightZone = event.clientX > rect.left + rect.width * 0.66;
    if (inRightZone) event.preventDefault();
    if (rightDropVisible !== inRightZone) setRightDropVisible(inRightZone);
  };

  const handleDropSplitZone = (event: DragEvent<HTMLDivElement>) => {
    setRightDropVisible(false);
    if (mobile || splitActive) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX <= rect.left + rect.width * 0.66) return;
    const rawTab = event.dataTransfer.getData(TAB_DRAG);
    if (rawTab) {
      event.preventDefault();
      try {
        const parsed = JSON.parse(rawTab) as { paneId?: PaneId; pageId?: string };
        if (parsed.pageId) {
          if (paneState.tabs.length <= 1) openInRightSplit(parsed.pageId);
          else moveTab(parsed.paneId ?? paneId, parsed.pageId, "right", 0);
        }
      } catch {
        // Ignore malformed drag payload.
      }
      return;
    }
    const rawPage = event.dataTransfer.getData(PAGE_DRAG);
    if (rawPage) {
      event.preventDefault();
      openInRightSplit(rawPage);
    }
  };

  return (
    <div
      className={`workspace-pane ${isFocused ? "is-focused" : ""}`}
      data-pane-id={paneId}
      style={style}
      onMouseDownCapture={() => { if (!isFocused) focusPane(paneId); }}
      onFocusCapture={() => { if (!isFocused) focusPane(paneId); }}
      onDragOver={handleDragOverSplitZone}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setRightDropVisible(false);
      }}
      onDrop={handleDropSplitZone}
    >
      {!mobile ? (
        <TabBar
          paneId={paneId}
          paneState={paneState}
          splitActive={splitActive}
          onTabDragState={(dragging) => { if (!dragging) setRightDropVisible(false); }}
        />
      ) : null}

      <div className="pane-island">
        <TopBar
          pageId={pageId}
          paneId={paneId}
          isFocusedPane={isFocused}
          showSaveStatus={showSaveStatus}
          splitActive={splitActive}
          onHistory={onHistory}
        />
        <div className="app-workspace">
          {showGraph ? (
            <SurfaceTag ref={(el: HTMLElement | null) => setSurface(el)} className="page-surface page-surface--graph">
              <Suspense fallback={<div className="graph graph--page" aria-busy="true" />}>
                <GraphView
                  variant="page"
                  selectedPageId={pageId || null}
                  onOpenPage={(targetId, full) => (full ? selectPage(targetId, { pane: paneId }) : openPeek(targetId))}
                />
              </Suspense>
            </SurfaceTag>
          ) : (
            <SurfaceTag
              ref={(el: HTMLElement | null) => setSurface(el)}
              className="page-surface scroller"
              aria-label={isFocused ? undefined : "分屏页面"}
            >
              {!showImportJob && showHistoryPreview ? (
                <div className="history-banner" role="status">
                  <Clock3 size={14} />
                  <span>You are looking at an older version.</span>
                </div>
              ) : !showImportJob && trashedAt ? (
                <div className="history-banner trash-banner" role="status">
                  <Trash2 size={14} />
                  <span>In the trash</span>
                  <button type="button" className="btn btn--outline" disabled={!canRestorePage(trashedAt)} onClick={() => restorePage(trashedAt, { select: false })}>
                    <RotateCcw size={13} />Restore
                  </button>
                  {canDeletePage(trashedAt) ? (
                    <button type="button" className="btn btn--danger" onClick={() => onConfirmPermanentDelete(trashedAt)}>
                      Delete permanently
                    </button>
                  ) : null}
                </div>
              ) : !showImportJob && selectedKind && !canEdit(pageId) ? (
                <div className="history-banner" role="status">
                  <Eye size={14} />
                  <span>You can only view this page.</span>
                </div>
              ) : !showImportJob && shelvedBy ? (
                <div className="history-banner shelved-banner" role="status">
                  <Archive size={14} />
                  <span>
                    {shelvedBy.id === pageId
                      ? "此页面已归档 · 搜索中默认折叠，内容仍可编辑"
                      : `随「${shelvedTitle}」已归档 · 搜索中默认折叠，内容仍可编辑`}
                  </span>
                  {canShelvePage(shelvedBy.id) ? (
                    <button
                      type="button"
                      className="btn btn--outline"
                      onClick={() => { setPageShelved(shelvedBy.id, false); toast("已取消归档", "success"); }}
                    >
                      取消归档
                    </button>
                  ) : null}
                </div>
              ) : null}

              <CachedDocumentPages
                activePageId={selectedKind === "document" && !showHistoryPreview && !trashedAt && !showImportJob ? pageId : null}
                pinnedIds={pinnedIds}
                surfaceEl={surfaceEl}
                canEdit={canEdit}
              />

              {showImportJob ? (
                <Suspense fallback={<div className="page-loading" aria-busy="true"><span className="page-loading__line" /><span className="page-loading__line" /><span className="page-loading__line" /></div>}>
                  <ImportProgressView job={showImportJob} />
                </Suspense>
              ) : showHistoryPreview && showHistoryPreview.kind !== "document" ? (
                <Suspense fallback={null}><SnapshotPreview page={showHistoryPreview} /></Suspense>
              ) : selectedKind === "database" && !showHistoryPreview ? (
                <Suspense fallback={<div className="page-loading" aria-busy="true"><span className="page-loading__line" /><span className="page-loading__line" /><span className="page-loading__line" /></div>}>
                  <DatabasePage pageId={pageId} readOnly={Boolean(trashedAt)} />
                </Suspense>
              ) : selectedKind === "app" && !showHistoryPreview ? (
                <AppPageShell pageId={pageId} />
              ) : selectedKind && (showHistoryPreview || trashedAt) ? (
                <OpenPage key="page" pageId={pageId} preview={showHistoryPreview} readOnly={Boolean(showHistoryPreview) || Boolean(trashedAt) || !canEdit(pageId)} />
              ) : selectedKind ? null : (
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
            </SurfaceTag>
          )}
        </div>
      </div>

      {rightDropVisible ? (
        <div className="split-drop-zone" aria-hidden="true">松开即可在右侧分屏打开</div>
      ) : null}
    </div>
  );
}
