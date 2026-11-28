import { ChevronLeft, Redo2, Settings2, Undo2, Waypoints, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { PaneId } from "../../core/tab-layout";
import { KnowledgeBaseSettings } from "../knowledge/KnowledgeBaseSettings";
import { personName, ProfileAvatar } from "../../components/ProfileAvatar";
import { Tooltip } from "../../components/Tooltip";
import { useFold } from "../../hooks/useFold";
import { pageName } from "../../core/block-tree";
import { useActiveEditSurface } from "../../app/edit-surface";
import { useActivity, useWorkspace } from "../../app/workspace-context";
import { pageAncestry } from "../../core/page-tree";
import { usePage, useWorkspaceState } from "../../app/workspace-store";
import type { NotePage } from "../../core/types";
import { pageIcon, type PageIcon } from "../editor/page-decoration";
import { PageIconMark } from "../editor/PageIcon";
import { PageActions } from "./PageActions";
import { AgentProposals } from "../collaboration/AgentProposals";

const MAX_CRUMBS = 4;

interface Crumb {
  id: string;
  page?: NotePage;
  icon: PageIcon | null;
  label: string;
}

const sameIcon = (left: PageIcon | null, right: PageIcon | null) =>
  left === right || (!!left && !!right
    && (left.kind === "emoji" ? right.kind === "emoji" && left.emoji === right.emoji
      : left.kind === "image" && right.kind === "image" && left.file === right.file));

function trailTo(pages: Record<string, NotePage>, pageId: string): Crumb[] {
  return pageAncestry(pages, pageId).map((page) => ({ id: page.id, page, icon: pageIcon(page), label: pageName(page) }));
}
const sameTrail = (left: readonly Crumb[], right: readonly Crumb[]) => left.length === right.length
  && left.every((crumb, index) => crumb.id === right[index].id && sameIcon(crumb.icon, right[index].icon) && crumb.label === right[index].label);

function OpenPageActions({
  pageId,
  compact,
  onHistory,
  fullscreen,
  onToggleFullscreen,
}: {
  pageId: string;
  compact: boolean;
  onHistory(): void;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}) {
  const page = usePage(pageId);
  return page
    ? <PageActions page={page} compact={compact} onHistory={onHistory} widthOption moveShortcut fullscreen={fullscreen} onToggleFullscreen={onToggleFullscreen} />
    : null;
}

/* On desktop: 44px top bar with breadcrumbs, presence, proposals and actions.
   On mobile (<560px, Direction C): borderless quiet paper header showing space
   dot (or < parent back link), save state, actions, and editing Done bar. */
export function TopBar({
  onHistory,
  pageId,
  paneId,
  isFocusedPane = true,
  showSaveStatus = true,
  splitActive = false,
  fullscreen = false,
  onToggleFullscreen,
}: {
  onHistory(): void;
  pageId?: string;
  paneId?: PaneId;
  isFocusedPane?: boolean;
  showSaveStatus?: boolean;
  splitActive?: boolean;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}) {
  const { platform, selectedPageId, selectPage, openInNewTab, rosters, spaceOf, activeSpace, graphOpen, closeGraph } = useWorkspace();
  const effectivePageId = pageId ?? selectedPageId;
  const mobile = useFold();
  const activeSurface = useActiveEditSurface();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const trail = useWorkspaceState((state) => trailTo(state.pages, effectivePageId), sameTrail);
  const opened = trail.length > 0 && !(graphOpen && isFocusedPane);
  const library = activeSpace?.knowledgeBase && (!opened || spaceOf(effectivePageId) === activeSpace.spaceId) ? activeSpace : null;
  const canManageLibrary = library && (library.role === "owner" || library.role === "admin");
  useEffect(() => { setSettingsOpen(false); }, [library?.spaceId]);

  const crumbs = trail.length > MAX_CRUMBS
    ? [trail[0], null, ...trail.slice(-(MAX_CRUMBS - 1))]
    : trail;
  const parentCrumb = trail.length > 1 ? trail[trail.length - 2] : null;
  const parentLabel = parentCrumb
    ? (parentCrumb.id === library?.knowledgeBase?.homePageId ? library.name : parentCrumb.label)
    : "";

  const roster = opened ? rosters[spaceOf(effectivePageId) ?? ""]?.members : undefined;
  const { presence, saveStatus } = useActivity();
  const here = presence.filter(
    (item) => item.online
      && opened
      && item.state?.pageId === effectivePageId
      && item.userId !== platform?.bootstrap.user.id
      && (!roster || roster.some((member) => member.id === item.userId)),
  );
  const memberOf = (userId: string) => Object.values(rosters).flatMap((space) => space.members).find((member) => member.id === userId);
  const nameOf = (userId: string) => {
    const member = memberOf(userId);
    return member ? personName(member) : "Someone";
  };

  const saveLabel = saveStatus === "offline"
    ? "Not saved yet — you’re offline. Keep this window open: it saves once you’re back online."
    : saveStatus === "refused"
      ? "Some changes could not be saved and were undone. Everything else is saved."
      : "Saving…";

  const mobileEditingMain = mobile && activeSurface?.container === "main";

  return (
    <header className={`topbar ${mobile ? "topbar--mobile" : ""}`}>
      {mobile ? (
        mobileEditingMain ? (
          <>
            <button
              type="button"
              className="btn topbar__done"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => activeSurface.done()}
            >
              完成
            </button>
            <div className="topbar__actions">
              <button
                type="button"
                className="icon-btn"
                aria-label="Undo"
                disabled={!activeSurface.canUndo}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => activeSurface.undo?.()}
              >
                <Undo2 size={16} />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="Redo"
                disabled={!activeSurface.canRedo}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => activeSurface.redo?.()}
              >
                <Redo2 size={16} />
              </button>
              {opened ? <OpenPageActions pageId={effectivePageId} compact onHistory={onHistory} fullscreen={fullscreen} onToggleFullscreen={onToggleFullscreen} /> : null}
            </div>
          </>
        ) : graphOpen ? (
          <>
            <span className="topbar__space-badge">
              <Waypoints size={15} aria-hidden="true" />
              <span className="topbar__space-label">Graph</span>
            </span>
            <div className="topbar__actions">
              <button type="button" className="icon-btn" aria-label="Close graph" onClick={closeGraph}>
                <X size={17} />
              </button>
            </div>
          </>
        ) : (
          <>
            <nav className="topbar__crumbs" aria-label="Breadcrumb">
              {parentCrumb ? (
                <button type="button" className="topbar__back" onClick={() => selectPage(parentCrumb.id)}>
                  <ChevronLeft size={17} aria-hidden="true" />
                  <span>{parentLabel}</span>
                </button>
              ) : (
                <span className="topbar__space-badge">
                  <span className="topbar__space-dot" aria-hidden="true" />
                  <span className="topbar__space-label">{library ? library.name : "个人空间"}</span>
                </span>
              )}
            </nav>
            <div className="topbar__actions">
              <Tooltip label={saveLabel}>
                <span
                  className={`save-state save-state--${saveStatus}`}
                  role="status"
                  aria-live="polite"
                  aria-label={saveStatus === "saved" ? "All changes saved" : saveLabel}
                  tabIndex={saveStatus === "saved" ? -1 : 0}
                />
              </Tooltip>
              {here.length ? (
                <div className="avatar-stack" aria-label={`${here.length} other ${here.length === 1 ? "person" : "people"} here`}>
                  {here.slice(0, 2).map((item) => (
                    <ProfileAvatar key={item.userId} src={memberOf(item.userId)?.avatarUrl} name={nameOf(item.userId)} size={20} online />
                  ))}
                </div>
              ) : null}
              {opened ? <AgentProposals key={`${platform?.bootstrap.user.id}:${selectedPageId}`} pageId={selectedPageId} compact /> : null}
              {opened ? <OpenPageActions pageId={effectivePageId} compact onHistory={onHistory} fullscreen={fullscreen} onToggleFullscreen={onToggleFullscreen} /> : null}
              {canManageLibrary ? (
                <button
                  type="button"
                  className="icon-btn knowledge-base-settings-entry"
                  aria-label="知识库设置"
                  aria-haspopup="dialog"
                  aria-expanded={settingsOpen}
                  onClick={(event) => { event.currentTarget.focus(); setSettingsOpen(true); }}
                >
                  <Settings2 size={16} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </>
        )
      ) : (
        <>
          <nav className="topbar__crumbs" aria-label="Breadcrumb">
            {graphOpen && isFocusedPane ? (
              <span className="crumb__slot">
                <span className="crumb is-current" aria-current="page">
                  <span className="crumb__icon" aria-hidden="true"><Waypoints size={14} /></span>
                  <span className="crumb__label">Graph</span>
                </span>
              </span>
            ) : trail.length > 1 ? crumbs.map((crumb, index) => (
              <span key={crumb?.id ?? `gap-${index}`} className="crumb__slot">
                {index ? <span className="crumb__sep" aria-hidden="true">/</span> : null}
                {crumb ? (
                  <button
                    type="button"
                    className={`crumb ${index === crumbs.length - 1 ? "is-current" : ""}`}
                    aria-current={index === crumbs.length - 1 ? "page" : undefined}
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey) openInNewTab(crumb.id, paneId);
                      else selectPage(crumb.id, paneId ? { pane: paneId } : undefined);
                    }}
                    onMouseDown={(event) => {
                      if (event.button === 1) event.preventDefault();
                    }}
                    onMouseUp={(event) => {
                      if (event.button === 1) {
                        event.preventDefault();
                        openInNewTab(crumb.id, paneId);
                      }
                    }}
                  >
                    {crumb.icon ? <span className="crumb__icon" aria-hidden="true"><PageIconMark page={crumb.page} size={14} /></span> : null}
                    <span className="crumb__label">{crumb.id === library?.knowledgeBase?.homePageId ? library.name : crumb.label}</span>
                  </button>
                ) : <span className="crumb__sep">…</span>}
              </span>
            )) : null}
          </nav>

          <div className="topbar__actions">
            {splitActive && paneId ? (
              <span className={`pane-focus-pill ${isFocusedPane ? "is-focused" : ""}`}>
                {paneId === "left" ? "左栏" : "右栏"}
                {isFocusedPane ? " · 当前焦点" : ""}
              </span>
            ) : null}
            {showSaveStatus ? (
              <Tooltip label={saveLabel}>
                <span
                  className={`save-state save-state--${saveStatus}`}
                  role="status"
                  aria-live="polite"
                  aria-label={saveStatus === "saved" ? "All changes saved" : saveLabel}
                  tabIndex={saveStatus === "saved" ? -1 : 0}
                />
              </Tooltip>
            ) : null}

            {here.length ? (
              <div className="avatar-stack" aria-label={`${here.length} other ${here.length === 1 ? "person" : "people"} here`}>
                {here.slice(0, 3).map((item) => (
                  <ProfileAvatar
                    key={item.userId}
                    src={memberOf(item.userId)?.avatarUrl}
                    name={nameOf(item.userId)}
                    size={20}
                    online
                  />
                ))}
              </div>
            ) : null}

            {opened ? <AgentProposals key={`${platform?.bootstrap.user.id}:${effectivePageId}`} pageId={effectivePageId} compact={false} /> : null}
            {opened ? <OpenPageActions pageId={effectivePageId} compact={false} onHistory={onHistory} fullscreen={fullscreen} onToggleFullscreen={onToggleFullscreen} /> : null}
            {canManageLibrary && isFocusedPane ? <Tooltip label="知识库设置">
              <button type="button" className="icon-btn knowledge-base-settings-entry" aria-label="知识库设置" aria-haspopup="dialog" aria-expanded={settingsOpen}
                onClick={(event) => { event.currentTarget.focus(); setSettingsOpen(true); }}><Settings2 size={16} aria-hidden="true" /></button>
            </Tooltip> : null}
            {graphOpen && isFocusedPane ? (
              <Tooltip label="Close graph">
                <button type="button" className="icon-btn" aria-label="Close graph" onClick={closeGraph}>
                  <X size={16} />
                </button>
              </Tooltip>
            ) : null}
          </div>
        </>
      )}
      {settingsOpen && canManageLibrary && library ? <KnowledgeBaseSettings key={library.spaceId} space={library} onClose={() => setSettingsOpen(false)} /> : null}
    </header>
  );
}
