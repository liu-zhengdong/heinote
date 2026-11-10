import { FileText, Files, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "../../components/Popover";
import { imeComposing } from "../../core/keyboard";
import { pageName } from "../../core/block-tree";
import type { AnchorRect } from "../../hooks/useAnchoredPosition";
import type { NotePage } from "../../core/types";
import { useWorkspace } from "../../app/workspace-context";
import { pageAncestry } from "../../core/page-tree";
import { usePages } from "../../app/workspace-store";

/** Notion's "Move to": the page picker that sends blocks — or a whole page —
 *  to another page. Recently edited pages come first; typing filters by title
 *  and by the path above a page, so two pages with the same name can be told
 *  apart. */
export function MoveToMenu({
  anchor,
  pages,
  count,
  placeholder,
  onMove,
  onMoveToTop,
  onClose,
}: {
  anchor: AnchorRect;
  pages: NotePage[];
  count: number;
  /** What the search asks for; by default, where the blocks should go. */
  placeholder?: string;
  onMove(pageId: string): void;
  /** Offered only where a page may go back to the top of Files: it leads
   *  the list, as Notion's Private does. */
  onMoveToTop?(): void;
  onClose(): void;
}) {
  const { spaceOf } = useWorkspace();
  const allPages = usePages();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const needle = query.trim().toLowerCase();
  const hits = useMemo(() => {
    return pages
      .map((page) => ({
        page,
        crumb: pageAncestry(allPages, page.id).slice(0, -1).map((item) => pageName(item)).join(" / "),
        // Whatever moves under a shared page is shared with everyone in it.
        shared: Boolean(spaceOf(page.id)),
      }))
      .filter(({ page, crumb }) => !needle
        || pageName(page).toLowerCase().includes(needle)
        || crumb.toLowerCase().includes(needle))
      .toSorted((left, right) => right.page.updated_at.localeCompare(left.page.updated_at))
      .slice(0, 50);
  }, [allPages, needle, pages, spaceOf]);
  // Null is the top of Files, first when it is offered at all.
  const top = Boolean(onMoveToTop) && (!needle || "top level".includes(needle) || "files".includes(needle));
  const options: Array<(typeof hits)[number] | null> = top ? [null, ...hits] : hits;
  const choose = (option: (typeof hits)[number] | null) => {
    if (option) onMove(option.page.id);
    else onMoveToTop?.();
  };

  useEffect(() => {
    listRef.current?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <Popover open anchor={anchor} placement="bottom-start" role="dialog" label="Move to" onDismiss={onClose}>
      <div className="move-to">
        <input
          autoFocus
          className="move-to__search"
          value={query}
          placeholder={placeholder ?? (count > 1 ? `Move ${count} paragraphs to…` : "Move to…")}
          aria-label="Page to move to"
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={(event) => {
            if (imeComposing(event)) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const delta = event.key === "ArrowDown" ? 1 : -1;
              setActive((index) => (index + delta + options.length) % Math.max(1, options.length));
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (options.length) choose(options[Math.min(active, options.length - 1)]);
            }
          }}
        />
        <div className="move-to__list" ref={listRef} role="listbox" aria-label="Pages">
          {options.length ? options.map((hit, index) => (
            <button
              key={hit?.page.id ?? "top"}
              type="button"
              role="option"
              aria-selected={index === active}
              className={`move-to__item ${index === active ? "is-active" : ""}`}
              onPointerMove={() => setActive(index)}
              onClick={() => choose(hit)}
            >
              <span className="move-to__icon" aria-hidden="true">
                {hit ? hit.page.icon || <FileText size={15} /> : <Files size={15} />}
              </span>
              <span className="move-to__copy">
                <span className="move-to__title">{hit ? pageName(hit.page) : "Top level"}</span>
                {hit ? (hit.crumb ? <span className="move-to__crumb">{hit.crumb}</span> : null) : <span className="move-to__crumb">Files</span>}
              </span>
              {hit?.shared ? (
                <span className="move-to__shared" role="img" aria-label="Shared" title="Shared — what moves here is shared with everyone in it">
                  <Users size={13} />
                </span>
              ) : null}
            </button>
          )) : <p className="move-to__empty">No pages match</p>}
        </div>
      </div>
    </Popover>
  );
}
