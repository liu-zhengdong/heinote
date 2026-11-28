import { AlertCircle, ChevronRight, Link, Loader2, MoreHorizontal, Plus } from "lucide-react";
import { memo, type CSSProperties, type DragEvent } from "react";
import { ProfileAvatar, personName } from "../../components/ProfileAvatar";
import { Tooltip } from "../../components/Tooltip";
import { pageName } from "../../core/block-tree";
import { imeComposing } from "../../core/keyboard";
import type { NotePage, SpaceMember } from "../../core/types";
import { rectOf, type AnchorRect } from "../../hooks/useAnchoredPosition";
import type { ImportJobDto } from "../account/useImports";
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

export type TreeDropPosition = "before" | "inside" | "after";

/** Where something dragged in the list lands: before/inside/after a page, or
 *  null for the list's trailing blank area (root level / KB home). */
export type TreeTarget = { pageId: string; position: TreeDropPosition } | null;

export const PAGE_DRAG = "text/x-notes-page";

/** Resolves which drop zone of a tree row a pointer sits in. Synthetic drag
 *  events with no coordinates (0, 0) default to `inside` when the row accepts
 *  children so programmatic drops on a row preserve container semantics. */
export function resolveRowDropPosition(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, "top" | "height">,
  canDropInside: boolean,
): TreeDropPosition {
  if (clientX === 0 && clientY === 0) return canDropInside ? "inside" : "after";
  const ratio = (clientY - rect.top) / Math.max(rect.height, 1);
  if (canDropInside) {
    if (ratio < 0.25) return "before";
    if (ratio > 0.75) return "after";
    return "inside";
  }
  return ratio < 0.5 ? "before" : "after";
}

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
  dragStart(pageId: string): void;
  dragEnd(): void;
  dragOver(target: TreeTarget, depth: number, event: DragEvent<HTMLElement>): void;
  dragLeave(pageId: string): void;
  drop(target: TreeTarget, event: DragEvent<HTMLElement>): void;
  stepOrder(pageId: string, delta: -1 | 1): void;
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
  reorderable,
  dragging,
  dropPosition,
  dropDepth,
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
  reorderable: boolean;
  dragging: boolean;
  dropPosition: TreeDropPosition | null;
  dropDepth: number;
  /** Something outside it links to it: a link mark follows its name. */
  linked: boolean;
  /** Who the page is shared with — given for the page that is shared, not
   *  for the pages inside it, which are shared with it. */
  people?: SpaceMember[];
  me?: string;
  actions: TreeActions;
}) {
  const label = pageName(page);
  const canDropInside = editable && page.kind === "document";
  const canDrag = (movable || reorderable) && !renaming;
  return (
    <div
      className={[
        "tree-row",
        selected ? "is-selected" : "",
        dragging ? "is-dragging" : "",
        dropPosition === "inside" ? "is-drop-target" : "",
        dropPosition === "before" ? "is-drop-before" : "",
        dropPosition === "after" ? "is-drop-after" : "",
        menuOpen ? "is-menu-open" : "",
      ].filter(Boolean).join(" ")}
      style={{ "--depth": depth, "--drop-depth": dropDepth } as CSSProperties}
      data-page-id={page.id}
      draggable={canDrag}
      onDragStart={(event) => {
        if (!canDrag) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.setData(PAGE_DRAG, page.id);
        event.dataTransfer.effectAllowed = "move";
        actions.dragStart(page.id);
      }}
      onDragEnd={() => actions.dragEnd()}
      onDragOver={(event) => {
        event.stopPropagation();
        const position = resolveRowDropPosition(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), canDropInside);
        actions.dragOver({ pageId: page.id, position }, depth, event);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) actions.dragLeave(page.id);
      }}
      onDrop={(event) => {
        event.stopPropagation();
        const position = resolveRowDropPosition(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), canDropInside);
        actions.drop({ pageId: page.id, position }, event);
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
          onKeyDown={(event) => {
            if (!reorderable || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || imeComposing(event)) return;
            if (event.key === "ArrowUp") {
              event.preventDefault();
              actions.stepOrder(page.id, -1);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              actions.stepOrder(page.id, 1);
            }
          }}
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

export const ImportTreeRow = memo(function ImportTreeRow({
  job,
  depth,
  selected,
  onSelect,
}: {
  job: ImportJobDto;
  depth: number;
  selected: boolean;
  onSelect(): void;
}) {
  const failed = job.status === "failed";
  const badge = (() => {
    if (failed) return "失败";
    if (job.status === "uploading") {
      const pct = job.totalBytes > 0 ? Math.round((job.uploadedBytes / job.totalBytes) * 100) : 0;
      return `上传 ${pct}%`;
    }
    if (job.status === "queued") return "排队";
    if (job.status === "committing") return "落库";
    if (job.total > 0) return `${Math.round((job.done / job.total) * 100)}%`;
    return "解析中";
  })();

  return (
    <div
      className={`tree-row tree-row--import ${selected ? "is-selected" : ""} ${failed ? "tree-row--import-failed" : ""}`}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      data-import-id={job.id}
      style={{ "--depth": depth } as CSSProperties}
    >
      <span className="tree-row__mark" aria-hidden="true">
        <span className="tree-row__glyph">
          {failed ? <AlertCircle size={14} /> : <Loader2 size={14} className="spin" />}
        </span>
      </span>
      <button
        type="button"
        className="tree-row__main"
        aria-current={selected ? "page" : undefined}
        onClick={onSelect}
      >
        <span className="tree-row__label">{job.title || "导入笔记"}</span>
        <span className="tree-row__import-badge">{badge}</span>
      </button>
    </div>
  );
});

export function measureTree(
  tree: PageTree,
  expanded: ReadonlySet<string>,
  extraChildren?: ReadonlyMap<string, number>,
): TreeMetrics {
  const counts = new Map<string, number>();
  const rowIndex = new Map<string, number>();
  let cursor = 0;
  const walk = (page: NotePage): number => {
    const start = cursor;
    cursor += 1;
    rowIndex.set(page.id, start);
    let size = 1;
    if (expanded.has(page.id)) {
      const extra = extraChildren?.get(page.id) ?? 0;
      size += extra;
      cursor += extra;
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
