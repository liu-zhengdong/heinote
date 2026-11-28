import "./tabs.css";
import { ArrowLeftRight, Columns2, Pin, PinOff, Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { MenuDivider, MenuItem, MenuList } from "../../components/Menu";
import { Popover } from "../../components/Popover";
import { Tooltip } from "../../components/Tooltip";
import { pointRect, type AnchorRect } from "../../hooks/useAnchoredPosition";
import { pageName } from "../../core/block-tree";
import type { PaneId, PaneState, TabItem } from "../../core/tab-layout";
import { useUi } from "../../app/ui-context";
import { useWorkspace } from "../../app/workspace-context";
import { usePages } from "../../app/workspace-store";
import { pageGlyph } from "../editor/block-registry";
import { PAGE_DRAG } from "../sidebar/TreeRow";

export const TAB_DRAG = "text/x-notes-tab";

interface DraggedTab {
  paneId: PaneId;
  pageId: string;
}

function parseTabDrag(event: DragEvent<HTMLElement>): DraggedTab | null {
  const raw = event.dataTransfer.getData(TAB_DRAG);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed && typeof parsed === "object"
      && ("paneId" in parsed && (parsed.paneId === "left" || parsed.paneId === "right"))
      && ("pageId" in parsed && typeof parsed.pageId === "string" && parsed.pageId)
    ) {
      return { paneId: parsed.paneId, pageId: parsed.pageId };
    }
  } catch {
    return null;
  }
  return null;
}

export function TabBar({
  paneId,
  paneState,
  splitActive,
  onTabDragState,
}: {
  paneId: PaneId;
  paneState: PaneState;
  splitActive: boolean;
  onTabDragState?(dragging: DraggedTab | null): void;
}) {
  const {
    activateTab,
    openInNewTab,
    openInRightSplit,
    togglePinTab,
    closeTab,
    closeOtherTabs,
    closeRightTabs,
    moveTab,
    toggleSplit,
    createPageInPane,
  } = useWorkspace();
  const { toast } = useUi();
  const pages = usePages();
  const listRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<DraggedTab | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ pageId: string; position: "before" | "after" } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ tab: TabItem; anchor: AnchorRect } | null>(null);

  // Keep active tab scrolled into view when switching tabs or panes.
  useEffect(() => {
    const list = listRef.current;
    if (!list || !paneState.activePageId) return;
    const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(paneState.activePageId)
      : paneState.activePageId.replace(/"/g, '\\"');
    const activeEl = list.querySelector<HTMLElement>(`.pane-tab[data-page-id="${escaped}"]`);
    activeEl?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [paneState.activePageId]);

  const pinnedTabs = paneState.tabs.filter((tab) => tab.pinned);
  const normalTabs = paneState.tabs.filter((tab) => !tab.pinned);

  const handleClose = (pageId: string) => {
    const result = closeTab(paneId, pageId);
    if (result.blockedByPin) {
      toast("已钉住页签受保护，请先取消钉住再关闭", "info");
    } else if (result.collapsedSplit) {
      toast("分屏已合并为单栏", "info");
    }
  };

  const handleTogglePin = (pageId: string) => {
    const pinned = togglePinTab(paneId, pageId);
    if (pinned !== null) {
      toast(pinned ? "已钉住页签，打开其他笔记不会覆盖" : "已取消钉住", "info");
    }
  };

  const handleToggleSplit = () => {
    const res = toggleSplit();
    if (res.merged) toast("已合并为单栏，右栏页签已全部保留", "info");
  };

  const renderTab = (tab: TabItem, indexInPane: number) => {
    const page = pages[tab.pageId];
    const title = page ? pageName(page) || "Untitled" : "Untitled";
    const isActive = paneState.activePageId === tab.pageId;
    const isBefore = dropIndicator?.pageId === tab.pageId && dropIndicator.position === "before";
    const isAfter = dropIndicator?.pageId === tab.pageId && dropIndicator.position === "after";

    return (
      <div
        key={tab.pageId}
        className={[
          "pane-tab",
          isActive ? "is-active" : "",
          tab.pinned ? "is-pinned" : "",
          isBefore ? "is-drop-before" : "",
          isAfter ? "is-drop-after" : "",
        ].filter(Boolean).join(" ")}
        data-page-id={tab.pageId}
        data-pane-id={paneId}
        data-pinned={tab.pinned ? "true" : "false"}
        draggable
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault();
        }}
        onMouseUp={(event) => {
          if (event.button === 1) {
            event.preventDefault();
            handleClose(tab.pageId);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setContextMenu({ tab, anchor: pointRect(event.clientX, event.clientY) });
        }}
        onDragStart={(event) => {
          const payload: DraggedTab = { paneId, pageId: tab.pageId };
          draggingRef.current = payload;
          onTabDragState?.(payload);
          event.dataTransfer.setData(TAB_DRAG, JSON.stringify(payload));
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => {
          draggingRef.current = null;
          setDropIndicator(null);
          onTabDragState?.(null);
        }}
        onDragOver={(event) => {
          const hasTab = event.dataTransfer.types.includes(TAB_DRAG);
          const hasPage = event.dataTransfer.types.includes(PAGE_DRAG);
          if (!hasTab && !hasPage) return;
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          const position = event.clientX > rect.left + rect.width / 2 ? "after" : "before";
          setDropIndicator((prev) => (prev?.pageId === tab.pageId && prev.position === position ? prev : { pageId: tab.pageId, position }));
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDropIndicator((prev) => (prev?.pageId === tab.pageId ? null : prev));
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDropIndicator(null);
          const rect = event.currentTarget.getBoundingClientRect();
          const after = event.clientX > rect.left + rect.width / 2;
          let targetIndex = indexInPane + (after ? 1 : 0);

          const tabDrag = parseTabDrag(event) ?? draggingRef.current;
          if (tabDrag) {
            if (tabDrag.paneId === paneId) {
              const oldIndex = paneState.tabs.findIndex((item) => item.pageId === tabDrag.pageId);
              if (oldIndex >= 0 && oldIndex < targetIndex) targetIndex -= 1;
            }
            moveTab(tabDrag.paneId, tabDrag.pageId, paneId, targetIndex);
            draggingRef.current = null;
            onTabDragState?.(null);
            return;
          }
          const pageDrag = event.dataTransfer.getData(PAGE_DRAG);
          if (pageDrag) openInNewTab(pageDrag, paneId);
        }}
      >
        <button
          type="button"
          className="pane-tab__main"
          role="tab"
          aria-selected={isActive}
          title={tab.pinned ? `${title}（已钉住）` : title}
          onClick={() => activateTab(paneId, tab.pageId)}
        >
          <span className="pane-tab__icon" aria-hidden="true">
            {page ? pageGlyph(page, 13) : null}
          </span>
          <span className="pane-tab__title">{title}</span>
        </button>

        <Tooltip label={tab.pinned ? "取消钉住" : "钉住页签"}>
          <button
            type="button"
            className="pane-tab__pin"
            aria-label={tab.pinned ? `取消钉住 ${title}` : `钉住 ${title}`}
            aria-pressed={tab.pinned}
            onClick={(event) => {
              event.stopPropagation();
              handleTogglePin(tab.pageId);
            }}
          >
            <Pin size={12} />
          </button>
        </Tooltip>

        {!tab.pinned ? (
          <Tooltip label="关闭页签" hint="⌘W">
            <button
              type="button"
              className="pane-tab__close"
              aria-label={`关闭 ${title}`}
              onClick={(event) => {
                event.stopPropagation();
                handleClose(tab.pageId);
              }}
            >
              <X size={12} />
            </button>
          </Tooltip>
        ) : null}
      </div>
    );
  };

  const tablistLabel = splitActive
    ? (paneId === "left" ? "左侧页面标签" : "右侧页面标签")
    : "页面标签";

  const contextTab = contextMenu?.tab ?? null;
  const canCloseContext = Boolean(contextTab && !contextTab.pinned && (splitActive || paneState.tabs.length > 1));
  const otherPane: PaneId = paneId === "left" ? "right" : "left";

  return (
    <div className="tabbar" data-pane-id={paneId}>
      <div
        ref={listRef}
        className="tabbar__list"
        role="tablist"
        aria-label={tablistLabel}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(TAB_DRAG) || event.dataTransfer.types.includes(PAGE_DRAG)) {
            event.preventDefault();
          }
        }}
        onDrop={(event) => {
          if ((event.target as Element | null)?.closest(".pane-tab")) return;
          event.preventDefault();
          setDropIndicator(null);
          const tabDrag = parseTabDrag(event) ?? draggingRef.current;
          if (tabDrag) {
            moveTab(tabDrag.paneId, tabDrag.pageId, paneId);
            draggingRef.current = null;
            onTabDragState?.(null);
            return;
          }
          const pageDrag = event.dataTransfer.getData(PAGE_DRAG);
          if (pageDrag) openInNewTab(pageDrag, paneId);
        }}
      >
        {pinnedTabs.map((tab, index) => renderTab(tab, index))}
        {pinnedTabs.length > 0 && normalTabs.length > 0 ? <span className="tabbar__pin-sep" aria-hidden="true" /> : null}
        {normalTabs.map((tab, index) => renderTab(tab, pinnedTabs.length + index))}
      </div>

      <div className="tabbar__tools">
        <Tooltip label="新建标签页">
          <button
            type="button"
            className="tabbar__btn"
            aria-label="新建标签页"
            onClick={() => createPageInPane(paneId)}
          >
            <Plus size={14} />
          </button>
        </Tooltip>
        <Tooltip label={splitActive ? "合并为单栏" : "左右分屏"}>
          <button
            type="button"
            className={`tabbar__btn ${splitActive && paneId === "right" ? "is-active" : ""}`}
            aria-label={splitActive ? "合并为单栏" : "左右分屏"}
            aria-pressed={splitActive}
            onClick={handleToggleSplit}
          >
            <Columns2 size={14} />
          </button>
        </Tooltip>
      </div>

      <Popover
        open={Boolean(contextMenu)}
        anchor={contextMenu?.anchor ?? null}
        placement="bottom-start"
        label="标签页操作"
        onDismiss={() => setContextMenu(null)}
      >
        {contextTab ? (
          <MenuList label="标签页操作" autoFocus>
            <MenuItem
              icon={contextTab.pinned ? <PinOff size={15} /> : <Pin size={15} />}
              label={contextTab.pinned ? "取消钉住" : "钉住页签"}
              onSelect={() => {
                handleTogglePin(contextTab.pageId);
                setContextMenu(null);
              }}
            />
            {!splitActive ? (
              <MenuItem
                icon={<Columns2 size={15} />}
                label="在右侧分屏打开"
                onSelect={() => {
                  openInRightSplit(contextTab.pageId);
                  setContextMenu(null);
                }}
              />
            ) : (
              <MenuItem
                icon={<ArrowLeftRight size={15} />}
                label={paneId === "left" ? "移至右侧分屏" : "移至左侧分屏"}
                disabled={paneState.tabs.length <= 1}
                onSelect={() => {
                  moveTab(paneId, contextTab.pageId, otherPane);
                  setContextMenu(null);
                }}
              />
            )}
            <MenuDivider />
            <MenuItem
              label="关闭其他页签"
              hint="保留已钉住"
              onSelect={() => {
                closeOtherTabs(paneId, contextTab.pageId);
                setContextMenu(null);
              }}
            />
            <MenuItem
              label="关闭右侧页签"
              hint="保留已钉住"
              onSelect={() => {
                closeRightTabs(paneId, contextTab.pageId);
                setContextMenu(null);
              }}
            />
            <MenuItem
              icon={<X size={15} />}
              label="关闭页签"
              hint={contextTab.pinned ? "已保护" : "⌘W"}
              disabled={!canCloseContext}
              onSelect={() => {
                handleClose(contextTab.pageId);
                setContextMenu(null);
              }}
            />
          </MenuList>
        ) : null}
      </Popover>
    </div>
  );
}
