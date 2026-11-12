import { Settings2, Waypoints, X } from "lucide-react";
import { useEffect, useState } from "react";
import { KnowledgeBaseSettings } from "../knowledge/KnowledgeBaseSettings";
import { personName, ProfileAvatar } from "../../components/ProfileAvatar";
import { Tooltip } from "../../components/Tooltip";
import { useFold } from "../../hooks/useFold";
import { pageName } from "../../core/block-tree";
import { useActivity, useWorkspace } from "../../app/workspace-context";
import { pageAncestry } from "../../core/page-tree";
import { usePage, useWorkspaceState } from "../../app/workspace-store";
import type { NotePage } from "../../core/types";
import { pageIcon, type PageIcon } from "../editor/page-decoration";
import { PageIconMark } from "../editor/PageIcon";
import { PageActions } from "./PageActions";
import { AgentProposals } from "../collaboration/AgentProposals";

const MAX_CRUMBS = 4;

/** One step of the trail: a page, or a block open as a page of its own. */
interface Crumb {
  id: string;
  /** Its page, when an icon is drawn — a picture icon needs the record. */
  page?: NotePage;
  icon: PageIcon | null;
  label: string;
}

const sameIcon = (left: PageIcon | null, right: PageIcon | null) =>
  left === right || (!!left && !!right
    && (left.kind === "emoji" ? right.kind === "emoji" && left.emoji === right.emoji
      : left.kind === "image" && right.kind === "image" && left.file === right.file));

/** The trail to a page as it reads — each step's name and icon — so the bar
 *  is redrawn when one of those changes, not with every keystroke. */
function trailTo(pages: Record<string, NotePage>, pageId: string): Crumb[] {
  return pageAncestry(pages, pageId).map((page) => ({ id: page.id, page, icon: pageIcon(page), label: pageName(page) }));
}
const sameTrail = (left: readonly Crumb[], right: readonly Crumb[]) => left.length === right.length
  && left.every((crumb, index) => crumb.id === right[index].id && sameIcon(crumb.icon, right[index].icon) && crumb.label === right[index].label);

/** The open page's own actions, redrawn as the page changes — the bar is not. */
function OpenPageActions({ pageId, compact, onHistory }: { pageId: string; compact: boolean; onHistory(): void }) {
  const page = usePage(pageId);
  return page ? <PageActions page={page} compact={compact} onHistory={onHistory} widthOption moveShortcut /> : null;
}

/* The page bar keeps the trail, people, proposals and sharing visible.
   Other page actions remain in the menu. Narrow windows use compact controls. */
export function TopBar({ onHistory }: { onHistory(): void }) {
  const { platform, selectedPageId, selectPage, rosters, spaceOf, activeSpace, graphOpen, closeGraph } = useWorkspace();
  const { presence, saveStatus } = useActivity();
  const folded = useFold();
  const [settingsOpen, setSettingsOpen] = useState(false);

  /* The trail: the page and every page it sits in — a block is a step past
     the page it is in, as a sub-page is past its parent. */
  const trail = useWorkspaceState((state) => trailTo(state.pages, selectedPageId), sameTrail);
  // The graph open in the page pane is where you are: no page's trail, faces or actions.
  const opened = trail.length > 0 && !graphOpen;
  const library = activeSpace?.knowledgeBase && (!opened || spaceOf(selectedPageId) === activeSpace.spaceId) ? activeSpace : null;
  const canManageLibrary = library && (library.role === "owner" || library.role === "admin");
  useEffect(() => { setSettingsOpen(false); }, [library?.spaceId]);
  /* A narrow window keeps the page and its parent: "where am I" is answered by
     the last two names, and a trail that truncates every crumb to "Pro…"
     answers nothing. */
  const limit = folded ? 2 : MAX_CRUMBS;
  const crumbs = trail.length > limit
    ? [trail[0], null, ...trail.slice(-(limit - 1))]
    : trail;

  /* Who else is on this page: present in its space, and still a member there.
     Someone just removed goes at once, whatever their presence last said;
     until the roster has been read, presence is taken at its word. */
  const roster = opened ? rosters[spaceOf(selectedPageId) ?? ""]?.members : undefined;
  const here = presence.filter(
    (item) => item.online
      && opened
      && item.state?.pageId === selectedPageId
      && item.userId !== platform?.bootstrap.user.id
      && (!roster || roster.some((member) => member.id === item.userId)),
  );
  const memberOf = (userId: string) => Object.values(rosters).flatMap((space) => space.members).find((member) => member.id === userId);
  // Until the roster has been read, all presence gives is an id: no name.
  const nameOf = (userId: string) => {
    const member = memberOf(userId);
    return member ? personName(member) : "Someone";
  };

  /* Saving is a state, not news. At rest nothing is shown; while a write is
     on its way a dot breathes; it holds amber while there is no connection
     to send it on, and red once the server refused a change for good. It never
     rests while something is not saved. Words would take a third of this
     bar on a narrow window for something that is true almost all of the
     time. */
  const saveLabel = saveStatus === "offline"
    ? "Not saved yet — you’re offline. Keep this window open: it saves once you’re back online."
    : saveStatus === "refused"
      ? "Some changes could not be saved and were undone. Everything else is saved."
      : "Saving…";

  return (
    <header className="topbar">
      <nav className="topbar__crumbs" aria-label="Breadcrumb">
        {graphOpen ? (
          <span className="crumb__slot">
            <span className="crumb is-current" aria-current="page">
              <span className="crumb__icon" aria-hidden="true"><Waypoints size={14} /></span>
              <span className="crumb__label">Graph</span>
            </span>
          </span>
        ) : crumbs.map((crumb, index) => (
          <span key={crumb?.id ?? `gap-${index}`} className="crumb__slot">
            {index ? <span className="crumb__sep" aria-hidden="true">/</span> : null}
            {crumb ? (
              <button
                type="button"
                className={`crumb ${index === crumbs.length - 1 ? "is-current" : ""}`}
                aria-current={index === crumbs.length - 1 ? "page" : undefined}
                onClick={() => selectPage(crumb.id)}
              >
                {crumb.icon ? <span className="crumb__icon" aria-hidden="true"><PageIconMark page={crumb.page} size={14} /></span> : null}
                <span className="crumb__label">{crumb.id === library?.knowledgeBase?.homePageId ? library.name : crumb.label}</span>
              </button>
            ) : <span className="crumb__sep">…</span>}
          </span>
        ))}
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

        {opened ? <AgentProposals key={`${platform?.bootstrap.user.id}:${selectedPageId}`} pageId={selectedPageId} compact={folded} /> : null}
        {opened ? <OpenPageActions pageId={selectedPageId} compact={folded} onHistory={onHistory} /> : null}
        {canManageLibrary ? <Tooltip label="知识库设置">
          <button type="button" className="icon-btn knowledge-base-settings-entry" aria-label="知识库设置" aria-haspopup="dialog" aria-expanded={settingsOpen}
            onClick={(event) => { event.currentTarget.focus(); setSettingsOpen(true); }}><Settings2 size={16} aria-hidden="true" /></button>
        </Tooltip> : null}
        {graphOpen ? (
          <Tooltip label="Close graph">
            <button type="button" className="icon-btn" aria-label="Close graph" onClick={closeGraph}>
              <X size={16} />
            </button>
          </Tooltip>
        ) : null}
      </div>
      {settingsOpen && canManageLibrary && library ? <KnowledgeBaseSettings key={library.spaceId} space={library} onClose={() => setSettingsOpen(false)} /> : null}
    </header>
  );
}
