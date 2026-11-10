import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Modal } from "../../components/Modal";
import { imeComposing } from "../../core/keyboard";
import { inlinePlainText, inlineReadableText } from "../../core/inline-content";
import { tableCells, tableGrid } from "../../core/simple-table";
import { readableDescriber } from "../editor/mentions";
import { orderedBlocks, pageName } from "../../core/block-tree";
import type { NotePage } from "../../core/types";
import { useWorkspace } from "../../app/workspace-context";
import { pageAncestry } from "../../core/page-tree";
import { useUi } from "../../app/ui-context";
import { useWorkspaceState } from "../../app/workspace-store";
import { pageGlyph } from "../editor/block-registry";

export interface Hit {
  page: NotePage;
  crumb: string;
  excerpt?: string;
}

/** What ⌘K finds for `query`: names that start with it, then names that
 *  hold it, then pages a line of which holds it (that line, shortened) — at
 *  most 12, each with the pages above it. Without words, the eight pages
 *  changed last. Pages in the trash are never found. The window's agents
 *  find pages with it too (`findPages`). */
export function quickFind(allPages: Record<string, NotePage>, query: string): Hit[] {
  const normalized = query.trim().toLowerCase();
  const pages = Object.values(allPages).filter((page) => !page.archived);
  const describe = (page: NotePage): string => pageAncestry(allPages, page.id)
    .slice(0, -1)
    .map((item) => pageName(item))
    .join(" / ");

  if (!normalized) {
    return pages
      .toSorted((left, right) => right.updated_at.localeCompare(left.updated_at))
      .slice(0, 8)
      .map((page) => ({ page, crumb: describe(page) }));
  }

  const scored: Array<{ hit: Hit; rank: number }> = [];
  // A mention is found — and shown — by the title it reads as.
  const readable = readableDescriber((pageId) => {
    const target = allPages[pageId];
    return target ? pageName(target) : "";
  });
  for (const page of pages) {
    // A block is a page, found by its name — or, unnamed, its first line.
    const title = pageName(page).toLowerCase();
    if (title.startsWith(normalized)) {
      scored.push({ hit: { page, crumb: describe(page) }, rank: 0 });
      continue;
    }
    if (title.includes(normalized)) {
      scored.push({ hit: { page, crumb: describe(page) }, rank: 1 });
      continue;
    }
    const match = orderedBlocks(page.block_tree)
      // A table's words are its cells'.
      .map((block) => (block.kind === "table"
        ? tableCells(tableGrid(block.table)).flat().map(inlinePlainText).filter(Boolean).join(" · ")
        : inlineReadableText(block.content, readable)))
      .find((text) => text.toLowerCase().includes(normalized));
    if (match) {
      scored.push({ hit: { page, crumb: describe(page), excerpt: match.slice(0, 90) }, rank: 2 });
    }
  }
  return scored.toSorted((left, right) => left.rank - right.rank).slice(0, 12).map((entry) => entry.hit);
}

/** ⌘K. Titles first, then the first line of body text that matches — enough to
 *  tell two similarly named pages apart without becoming a search product. */
export function QuickFind() {
  const { selectPage } = useWorkspace();
  const { quickFindOpen, setQuickFindOpen } = useUi();
  // Closed, it reads nothing — and is not redrawn as pages change.
  const allPages = useWorkspaceState((state) => (quickFindOpen ? state.pages : null));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (quickFindOpen) {
      setQuery("");
      setActive(0);
    }
  }, [quickFindOpen]);

  const hits = useMemo<Hit[]>(() => (allPages ? quickFind(allPages, query) : []), [allPages, query]);

  const open = (page: NotePage) => {
    selectPage(page.id);
    setQuickFindOpen(false);
  };

  return (
    <Modal open={quickFindOpen} label="Search pages" className="quickfind" onClose={() => setQuickFindOpen(false)}>
      <div className="quickfind__input">
        <Search size={18} />
        <input
          autoFocus
          value={query}
          placeholder="Search pages…"
          aria-label="Search pages"
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={(event) => {
            if (imeComposing(event)) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const delta = event.key === "ArrowDown" ? 1 : -1;
              setActive((index) => (index + delta + hits.length) % Math.max(1, hits.length));
              return;
            }
            if (event.key === "Enter" && hits[active]) {
              event.preventDefault();
              open(hits[active].page);
            }
          }}
        />
      </div>

      <div className="menu scroller" role="listbox" aria-label="Results">
        {hits.length ? hits.map((hit, index) => (
          <button
            type="button"
            key={hit.page.id}
            role="option"
            aria-selected={index === active}
            className={`menu__item ${index === active ? "is-active" : ""}`}
            onPointerMove={() => setActive(index)}
            onClick={() => open(hit.page)}
          >
            <span className="menu__icon" aria-hidden="true">{pageGlyph(hit.page)}</span>
            <span className="menu__copy">
              <span className="menu__label">{pageName(hit.page)}</span>
              {hit.excerpt ? <span className="menu__description">{hit.excerpt}</span> : null}
            </span>
            {hit.crumb ? <span className="quickfind__crumb">{hit.crumb}</span> : null}
          </button>
        )) : (
          <div className="slash__empty">{query.trim() ? `No pages match “${query.trim()}”` : "No pages yet"}</div>
        )}
      </div>
    </Modal>
  );
}
