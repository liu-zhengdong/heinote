import { AppWindow, FileText, Menu, Plus, Search, Table2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useIsMobileEditing } from "../../app/edit-surface";
import { useUi } from "../../app/ui-context";
import { useWorkspace } from "../../app/workspace-context";
import { BottomSheet } from "../../components/BottomSheet";
import { MenuItem, MenuList } from "../../components/Menu";
import type { PageKind } from "../../core/types";
import { markFresh } from "../database/fresh";
import "./mobile.css";

/** Direction C floating bottom command pill on mobile (<560px). Holds the
 *  three frequent entry points (All pages, Search, New) within thumb reach,
 *  condenses to the bottom-right corner on downward scroll, and yields whenever
 *  editing or an overlay takes over. */
export function MobileDock({
  surface,
  historyOpen,
}: {
  surface: HTMLElement | null;
  historyOpen: boolean;
}) {
  const { activeSpace, createPage, preferences, setPreference } = useWorkspace();
  const {
    drawerOpen,
    setDrawerOpen,
    quickFindOpen,
    setQuickFindOpen,
    peekPageId,
    sharePageId,
    adminOpen,
  } = useUi();
  const editing = useIsMobileEditing();
  const [condensed, setCondensed] = useState(false);
  const [newSheetOpen, setNewSheetOpen] = useState(false);

  const writable = !activeSpace
    || Boolean(activeSpace.knowledgeBase && !activeSpace.knowledgeBase.archived && activeSpace.role !== "viewer");

  const hidden = drawerOpen
    || quickFindOpen
    || Boolean(peekPageId)
    || historyOpen
    || Boolean(sharePageId)
    || editing
    || adminOpen
    || newSheetOpen;

  useEffect(() => {
    setCondensed(false);
    if (!surface) return;
    let lastY = Math.max(0, surface.scrollTop);
    const onScroll = () => {
      const max = Math.max(0, surface.scrollHeight - surface.clientHeight);
      const y = Math.max(0, Math.min(surface.scrollTop, max));
      if (y === lastY) return;
      if (y > lastY && y > 56) setCondensed(true);
      else if (y < lastY || y <= 24) setCondensed(false);
      lastY = y;
    };
    surface.addEventListener("scroll", onScroll, { passive: true });
    return () => surface.removeEventListener("scroll", onScroll);
  }, [surface]);

  const createIn = (kind: PageKind) => {
    if (!writable) return;
    const id = createPage(null, kind, { block: true });
    if (id) {
      markFresh(id);
      if (preferences.sidebar_view !== "files") setPreference("sidebar_view", "files");
    }
    setNewSheetOpen(false);
  };

  return (
    <>
      <div
        className={`mobile-dock-wrap ${condensed ? "is-condensed" : ""} ${hidden ? "is-hidden" : ""}`}
        inert={hidden ? true : undefined}
        aria-hidden={hidden || undefined}
      >
        <nav className="mobile-dock" aria-label="移动端命令坞">
          <button
            type="button"
            className="mobile-dock__nav"
            aria-label="All pages"
            aria-expanded={drawerOpen}
            onClick={() => {
              setCondensed(false);
              setDrawerOpen(!drawerOpen);
            }}
          >
            <Menu size={17} aria-hidden="true" />
            <span>目录</span>
          </button>

          {condensed ? (
            <button
              type="button"
              className="mobile-dock__icon-search"
              aria-label="Search"
              onClick={() => {
                setCondensed(false);
                setQuickFindOpen(true);
              }}
            >
              <Search size={17} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="mobile-dock__search"
              aria-label="Search"
              onClick={() => setQuickFindOpen(true)}
            >
              <Search size={16} aria-hidden="true" />
              <span>搜索或跳转…</span>
            </button>
          )}

          <button
            type="button"
            className="mobile-dock__add"
            aria-label="新建"
            disabled={!writable}
            aria-haspopup="dialog"
            aria-expanded={newSheetOpen}
            onClick={() => {
              setCondensed(false);
              setNewSheetOpen(true);
            }}
          >
            <Plus size={18} aria-hidden="true" />
          </button>
        </nav>
      </div>

      <BottomSheet
        open={newSheetOpen}
        label="新建"
        title="新建内容"
        size="auto"
        onClose={() => setNewSheetOpen(false)}
      >
        <MenuList label="新建" autoFocus>
          <MenuItem icon={<FileText size={16} />} label="页面" disabled={!writable} onSelect={() => createIn("document")} />
          <MenuItem icon={<Table2 size={16} />} label="数据库" disabled={!writable} onSelect={() => createIn("database")} />
          <MenuItem icon={<AppWindow size={16} />} label="小应用" disabled={!writable} onSelect={() => createIn("app")} />
        </MenuList>
      </BottomSheet>
    </>
  );
}
