import { RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "../../components/Popover";
import { imeComposing } from "../../core/keyboard";
import { pageName } from "../../core/block-tree";
import { inTrash, pageAncestry } from "../../core/page-tree";
import { pagesInSpace } from "../../core/space-navigation";
import type { AnchorRect } from "../../hooks/useAnchoredPosition";
import { useWorkspace } from "../../app/workspace-context";
import { useUi } from "../../app/ui-context";
import { usePages } from "../../app/workspace-store";
import { pageGlyph } from "../editor/block-registry";

function when(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  const days = Math.round((Date.now() - date.getTime()) / 86_400_000);
  if (days < 1) return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  if (days < 7) return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-days, "day");
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

/** Notion's trash: the pages in it, the last one thrown away first, found by
 *  name or by the page each was in. A page opens to be read where it is, in
 *  the trash; Restore and Delete permanently stand beside each. */
export function TrashMenu({ anchor, onClose }: { anchor: AnchorRect | null; onClose(): void }) {
  const { selectPage, restorePage, deletePage, canEdit, canDeletePage, spaces, activeSpaceId } = useWorkspace();
  const { toast } = useUi();
  const allPages = usePages();
  const pages = useMemo(() => pagesInSpace(allPages, spaces, activeSpaceId), [allPages, spaces, activeSpaceId]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const deleting = useRef(new Set<string>());
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { setQuery(""); setActive(0); }, [activeSpaceId]);

  const needle = query.trim().toLowerCase();
  const hits = useMemo(() => Object.values(pages)
    .filter((page) => page.archived)
    .map((page) => ({ page, crumb: pageAncestry(pages, page.id).slice(0, -1).map((item) => pageName(item) || "Untitled").join(" / ") }))
    .filter(({ page, crumb }) => !needle || pageName(page).toLowerCase().includes(needle) || crumb.toLowerCase().includes(needle))
    .toSorted((left, right) => (right.page.archived_at ?? "").localeCompare(left.page.archived_at ?? "")), [needle, pages]);

  useEffect(() => {
    setActive((index) => Math.min(index, Math.max(0, hits.length - 1)));
  }, [hits.length]);

  useEffect(() => {
    listRef.current?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const removePermanently = async (pageId: string) => {
    if (deleting.current.has(pageId) || !canDeletePage(pageId)) return;
    deleting.current.add(pageId);
    setPendingIds(new Set(deleting.current));
    try {
      await deletePage(pageId);
      toast("Deleted permanently", "success");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "无法永久删除页面，请重试。", "error");
    } finally {
      deleting.current.delete(pageId);
      setPendingIds(new Set(deleting.current));
    }
  };

  const open = (pageId: string) => {
    selectPage(pageId);
    onClose();
  };

  return (
    <Popover open anchor={anchor} placement="top-start" role="dialog" label="Trash" onDismiss={onClose}>
      <div className="move-to trash">
        <input
          autoFocus
          className="move-to__search"
          value={query}
          placeholder="Search the trash"
          aria-label="Search the trash"
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={(event) => {
            if (imeComposing(event)) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const delta = event.key === "ArrowDown" ? 1 : -1;
              setActive((index) => (index + delta + hits.length) % Math.max(1, hits.length));
            } else if (event.key === "Enter" && hits.length) {
              event.preventDefault();
              open(hits[Math.min(active, hits.length - 1)].page.id);
            }
          }}
        />
        <div className="move-to__list" ref={listRef} role="listbox" aria-label="Pages in the trash">
          {hits.length ? hits.map(({ page, crumb }, index) => {
            const parentTrashed = Boolean(page.parent_id && inTrash(allPages, page.parent_id));
            const pending = pendingIds.has(page.id);
            return <div
              key={page.id}
              role="option"
              aria-selected={index === active}
              className={`move-to__item trash__item ${index === active ? "is-active" : ""}`}
              onPointerMove={() => setActive(index)}
              onClick={() => open(page.id)}
            >
              <span className="move-to__icon" aria-hidden="true">{pageGlyph(page, 15)}</span>
              <span className="move-to__copy">
                <span className="move-to__title">{pageName(page) || "Untitled"}</span>
                {crumb ? <span className="move-to__crumb">{crumb}</span> : null}
                {parentTrashed ? <span className="move-to__crumb">先恢复父页面</span> : null}
              </span>
              <span className="trash__when">{when(page.archived_at)}</span>
              <span className="trash__actions">
                <button
                  type="button"
                  className="icon-btn icon-btn--sm"
                  aria-label={`Restore ${pageName(page)}`}
                  disabled={pending || !canEdit(page.id) || parentTrashed}
                  title={parentTrashed ? "先恢复父页面" : !canEdit(page.id) ? "当前空间只读" : "Restore"}
                  onClick={(event) => { event.stopPropagation(); if (canEdit(page.id) && !parentTrashed && !pending) { restorePage(page.id); onClose(); } }}
                >
                  <RotateCcw size={14} />
                </button>
                {canDeletePage(page.id) ? (
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    aria-label={`Delete ${pageName(page)} permanently`}
                    disabled={pending}
                    aria-busy={pending}
                    onClick={(event) => { event.stopPropagation(); void removePermanently(page.id); }}
                  >
                    <X size={14} />
                  </button>
                ) : null}
              </span>
            </div>;
          }) : <p className="move-to__empty">{needle ? "No pages match" : "Trash is empty"}</p>}
        </div>
      </div>
    </Popover>
  );
}
