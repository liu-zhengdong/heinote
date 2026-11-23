import { ChevronRight, Link, MoreHorizontal, Plus } from "lucide-react";
import { memo, useState, type CSSProperties, type DragEvent } from "react";
import { ProfileAvatar, personName } from "../../components/ProfileAvatar";
import { Tooltip } from "../../components/Tooltip";
import { pageName } from "../../core/block-tree";
import { imeComposing } from "../../core/keyboard";
import type { NotePage, SpaceMember } from "../../core/types";
import { rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import { pageGlyph } from "../editor/block-registry";
import type { PageTree } from "./tree";

/* Which pages are open is the reader's, on this device — as in Obsidian —
   and survives a reload. Storage that is missing or full costs only that. */
const EXPANDED_KEY = "notes.sidebar.expanded";

export function readExpanded(): Set<string> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(EXPANDED_KEY) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeExpanded(ids: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(EXPANDED_KEY, JSON.stringify([...ids].slice(-1000)));
  } catch {
    // Not remembered: the tree simply opens closed next time.
  }
}

/** The faces of the people a page is shared with, as a small stack: at most
 *  three, and a count for the rest. */
export function People({ members, me }: { members: SpaceMember[]; me?: string }) {
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
export type TreeTarget = { pageId: string } | null;

export const PAGE_DRAG = "text/x-notes-page";

/** What a row asks of the list. One stable object for the list's whole
 *  life, so a row is drawn again only when its own page (or how it is shown)
 *  changes. */
export interface TreeActions {
  select(pageId: string): void;
  toggle(id: string): void;
  openMenu(pageId: string, anchor: AnchorRect): void;
  rename(id: string): void;
  finishRename(pageId: string, name: string | null): void;
  createInside(pageId: string): void;
  dragOver(target: TreeTarget, event: DragEvent<HTMLElement>): boolean;
  drop(target: TreeTarget, event: DragEvent<HTMLElement>): void;
}

export const TreeRow = memo(function TreeRow({
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
        {editable && page.kind !== "app" ? (
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

export const ROW_HEIGHT_DESKTOP = 31;
export const ROW_HEIGHT_MOBILE = 44;
export const TREE_OVERSCAN = 20;
export const TREE_STEP = 10;

export interface TreeMetrics {
  counts: Map<string, number>;
  rowIndex: Map<string, number>;
  totalRows: number;
}

export function measureTree(tree: PageTree, expanded: ReadonlySet<string>): TreeMetrics {
  const counts = new Map<string, number>();
  const rowIndex = new Map<string, number>();
  let cursor = 0;
  const walk = (page: NotePage): number => {
    const start = cursor;
    cursor += 1;
    rowIndex.set(page.id, start);
    let size = 1;
    if (expanded.has(page.id)) {
      const children = tree.children.get(page.id);
      if (children) {
        for (const child of children) size += walk(child);
      }
    }
    counts.set(page.id, size);
    return size;
  };
  for (const root of tree.roots) walk(root);
  return { counts, rowIndex, totalRows: cursor };
}
