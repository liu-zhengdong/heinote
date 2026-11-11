import { RotateCcw, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Modal } from "../../components/Modal";
import { imeComposing } from "../../core/keyboard";
import { pageName } from "../../core/block-tree";
import { inTrash, pageAncestry } from "../../core/page-tree";
import type { NotePage } from "../../core/types";
import { useWorkspace } from "../../app/workspace-context";
import { useUi } from "../../app/ui-context";
import { pageGlyph } from "../editor/block-registry";

function when(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  const days = Math.round((Date.now() - date.getTime()) / 86_400_000);
  if (days < 1) return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  if (days < 7) return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-days, "day");
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

/** The trash tab's whole list area: search, then the trashed pages newest
 *  first, each row carrying where it lived and when it went — and, under the
 *  pointer, Restore and Delete permanently. Permanent deletion asks first. */
export function TrashView({ pages, onOpenPage }: {
  pages: Record<string, NotePage>;
  onOpenPage(pageId: string): void;
}) {
  const { restorePage, deletePage, canEdit, canDeletePage } = useWorkspace();
  const { toast } = useUi();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const deleting = useRef(new Set<string>());
  const listRef = useRef<HTMLDivElement | null>(null);

  const needle = query.trim().toLowerCase();
  const hits = useMemo(() => Object.values(pages)
    .filter((page) => page.archived)
    .map((page) => ({ page, crumb: pageAncestry(pages, page.id).slice(0, -1).map((item) => pageName(item) || "Untitled").join(" / ") }))
    .filter(({ page, crumb }) => !needle || pageName(page).toLowerCase().includes(needle) || crumb.toLowerCase().includes(needle))
    .toSorted((left, right) => (right.page.archived_at ?? "").localeCompare(left.page.archived_at ?? "")), [needle, pages]);

  const removePermanently = async (pageId: string) => {
    setConfirming(null);
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

  const confirmingPage = confirming ? pages[confirming] : undefined;

  return (
    <div className="trash-view">
      <div className="trash-view__search">
        <input
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
              listRef.current?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
            } else if (event.key === "Enter" && hits.length) {
              event.preventDefault();
              onOpenPage(hits[Math.min(active, hits.length - 1)].page.id);
            }
          }}
        />
      </div>
      <div className="move-to__list trash-view__list" ref={listRef} role="listbox" aria-label="Pages in the trash">
        {hits.length ? hits.map(({ page, crumb }, index) => {
          const parentTrashed = Boolean(page.parent_id && inTrash(pages, page.parent_id));
          const pending = pendingIds.has(page.id);
          return <div
            key={page.id}
            role="option"
            aria-selected={index === active}
            className={`move-to__item trash__item ${index === active ? "is-active" : ""}`}
            onPointerMove={() => setActive(index)}
            onClick={() => onOpenPage(page.id)}
          >
            <span className="move-to__icon" aria-hidden="true">{pageGlyph(page, 15)}</span>
            <span className="move-to__copy">
              <span className="move-to__title">{pageName(page) || "Untitled"}</span>
              <span className="move-to__crumb">{[crumb, when(page.archived_at)].filter(Boolean).join(" · ")}</span>
              {parentTrashed ? <span className="move-to__crumb">先恢复父页面</span> : null}
            </span>
            <span className="trash__actions">
              <button
                type="button"
                className="icon-btn icon-btn--sm"
                aria-label={`Restore ${pageName(page)}`}
                disabled={pending || !canEdit(page.id) || parentTrashed}
                title={parentTrashed ? "先恢复父页面" : !canEdit(page.id) ? "当前空间只读" : "Restore"}
                onClick={(event) => { event.stopPropagation(); if (canEdit(page.id) && !parentTrashed && !pending) restorePage(page.id); }}
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
                  onClick={(event) => { event.stopPropagation(); setConfirming(page.id); }}
                >
                  <X size={14} />
                </button>
              ) : null}
            </span>
          </div>;
        }) : <p className="move-to__empty">{needle ? "No pages match" : "Trash is empty"}</p>}
      </div>

      <DeletePageConfirm
        open={Boolean(confirmingPage)}
        title={confirmingPage ? pageName(confirmingPage) || "Untitled" : ""}
        onCancel={() => setConfirming(null)}
        onConfirm={() => confirmingPage && void removePermanently(confirmingPage.id)}
      />
    </div>
  );
}

/** The "gone for good" ask, shared by the trash row, the banner and every
 *  other permanent delete: the page name, then Cancel and the danger verb. */
export function DeletePageConfirm({ open, title, onCancel, onConfirm }: {
  open: boolean;
  title: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <Modal open={open} label="Delete permanently" onClose={onCancel} className="confirm">
      <h2>Delete permanently?</h2>
      <p>「{title}」将被永久删除，连同其中所有内容和历史。此操作不可撤销。</p>
      <div className="confirm__actions">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn--danger" onClick={onConfirm}>Delete permanently</button>
      </div>
    </Modal>
  );
}

/** The confirm shared by the row X and Empty trash: same copy, one more
 *  sweep on top when the button stands for the whole list. */
export function EmptyTrashConfirm({ open, count, onCancel, onConfirm }: {
  open: boolean;
  count: number;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <Modal open={open} label="Empty the trash" onClose={onCancel} className="confirm">
      <h2>Empty the trash?</h2>
      <p>回收站中的 {count} 个页面将被永久删除，连同其中所有内容和历史。此操作不可撤销。</p>
      <div className="confirm__actions">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn--danger" onClick={onConfirm}>Empty trash</button>
      </div>
    </Modal>
  );
}
