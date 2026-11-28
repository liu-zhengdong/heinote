import { Archive, ChevronRight, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Modal } from "../../components/Modal";
import { imeComposing } from "../../core/keyboard";
import { inlinePlainText, inlineReadableText } from "../../core/inline-content";
import { tableCells, tableGrid } from "../../core/simple-table";
import { readableDescriber } from "../editor/mentions";
import { isLoadedPage, orderedBlocks, pageName } from "../../core/block-tree";
import type { NotePage } from "../../core/types";
import { useWorkspace } from "../../app/workspace-context";
import { inTrash, isShelved, pageAncestry } from "../../core/page-tree";
import { navigationSpaceOf, pagesInSpace } from "../../core/space-navigation";
import "./quickfind.css";
import { useUi } from "../../app/ui-context";
import { useWorkspaceState } from "../../app/workspace-store";
import { pageGlyph } from "../editor/block-registry";
import { request } from "../../platform/http";

export interface Hit {
  page: NotePage;
  crumb: string;
  excerpt?: string;
  spaceId?: string;
  archived?: boolean;
  memoParentId?: string;
  memoComment?: boolean;
}

export interface QuickFindBuckets {
  active: Hit[];
  archived: Hit[];
  archivedTotal: number;
}

type RemoteHit = {
  id: string;
  title: string;
  spaceId: string;
  icon?: string;
  kind?: NotePage["kind"];
  crumb: string;
  excerpt?: string;
  space: string;
  archived?: boolean;
  memoParentId?: string;
  memoComment?: boolean;
};

type QuickFindEntry =
  | { kind: "hit"; hit: Hit }
  | { kind: "expand"; count: number };

/** The matched characters, marked — enough to see *where* a long title or
 *  excerpt won without turning the row into a colored object. Plain text when
 *  there is no query (the list is then "recent pages", not a search result). */
function markText(content: string, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return content;
  const source = content.toLowerCase();
  const out: ReactNode[] = [];
  let cursor = 0;
  let index = source.indexOf(needle);
  while (index !== -1) {
    if (index > cursor) out.push(content.slice(cursor, index));
    out.push(<mark key={index}>{content.slice(index, index + needle.length)}</mark>);
    cursor = index + needle.length;
    index = source.indexOf(needle, cursor);
  }
  if (cursor < content.length) out.push(content.slice(cursor));
  return out;
}

/** Splits ⌘K matches into active and archived buckets (each ranked by title
 *  prefix, title substring, body line, then newest first). Without words,
 *  returns up to 8 active recently changed pages. Pages in the trash are never
 *  found. */
export function quickFindBuckets(
  allPages: Record<string, NotePage>,
  query: string,
  options: { isArchived?: (page: NotePage) => boolean } = {},
): QuickFindBuckets {
  const normalized = query.trim().toLowerCase();
  const pages = Object.values(allPages).filter((page) => !inTrash(allPages, page.id));
  const checkArchived = options.isArchived ?? ((page: NotePage) => isShelved(allPages, page.id));
  const describe = (page: NotePage): string => pageAncestry(allPages, page.id)
    .slice(0, -1)
    .map((item) => pageName(item))
    .join(" / ");

  if (!normalized) {
    const active = pages
      .filter((page) => !checkArchived(page))
      .toSorted((left, right) => right.updated_at.localeCompare(left.updated_at))
      .slice(0, 8)
      .map((page) => ({ page, crumb: describe(page) }));
    return { active, archived: [], archivedTotal: 0 };
  }

  const activeScored: Array<{ hit: Hit; rank: number }> = [];
  const archivedScored: Array<{ hit: Hit; rank: number }> = [];
  // A mention is found — and shown — by the title it reads as.
  const readable = readableDescriber((pageId) => {
    const target = allPages[pageId];
    return target ? pageName(target) : "";
  });
  for (const page of pages) {
    // A block is a page, found by its name — or, unnamed, its first line.
    const title = pageName(page).toLowerCase();
    let rank: number | null = null;
    let excerpt: string | undefined;
    if (title.startsWith(normalized)) {
      rank = 0;
    } else if (title.includes(normalized)) {
      rank = 1;
    } else if (isLoadedPage(page)) {
      const match = orderedBlocks(page.block_tree)
        // A table's words are its cells'.
        .map((block) => (block.kind === "table"
          ? tableCells(tableGrid(block.table)).flat().map(inlinePlainText).filter(Boolean).join(" · ")
          : inlineReadableText(block.content, readable)))
        .find((text) => text.toLowerCase().includes(normalized));
      if (match) {
        rank = 2;
        excerpt = match.slice(0, 90);
      }
    }
    if (rank === null) continue;
    const archived = checkArchived(page);
    const hit: Hit = {
      page,
      crumb: describe(page),
      ...(excerpt !== undefined ? { excerpt } : {}),
      ...(archived ? { archived: true } : {}),
    };
    if (archived) archivedScored.push({ hit, rank });
    else activeScored.push({ hit, rank });
  }
  const byRank = (left: { hit: Hit; rank: number }, right: { hit: Hit; rank: number }) =>
    left.rank - right.rank || (right.hit.page.updated_at ?? "").localeCompare(left.hit.page.updated_at ?? "");
  activeScored.sort(byRank);
  archivedScored.sort(byRank);
  return {
    active: activeScored.slice(0, 12).map((entry) => entry.hit),
    archived: archivedScored.slice(0, 12).map((entry) => entry.hit),
    archivedTotal: archivedScored.length,
  };
}

/** What ⌘K finds for `query`: active pages first (up to 12). Without words,
 *  the eight active pages changed last. Pages in the trash are never found.
 *  The window's agents find pages with it too (`findPages`). */
export function quickFind(allPages: Record<string, NotePage>, query: string): Hit[] {
  return quickFindBuckets(allPages, query).active;
}

/** ⌘K. Titles first, then the first line of body text that matches — enough to
 *  tell two similarly named pages apart without becoming a search product.
 *  Archived (shelved) pages and archived knowledge bases stay folded at the
 *  bottom until expanded, or expand automatically when active hits are empty. */
export function QuickFind() {
  const { selectPage, openInNewTab, openInRightSplit, activateSpace, activeSpaceId, activeSpace, spaces, preferences, setPreference } = useWorkspace();
  const { quickFindOpen, setQuickFindOpen, openMemo } = useUi();
  // Closed, it reads nothing — and is not redrawn as pages change.
  const allPages = useWorkspaceState((state) => (quickFindOpen ? state.pages : null));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [scope, setScope] = useState<"current" | "all">("current");
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const searchKey = JSON.stringify([scope === "all" ? null : activeSpaceId, query.trim().toLowerCase()]);
  const [remote, setRemote] = useState<{
    key: string;
    hits: RemoteHit[];
    archivedTotal: number;
  } | null>(null);
  const [remoteArchived, setRemoteArchived] = useState<{
    key: string;
    hits: RemoteHit[];
  } | null>(null);

  useEffect(() => {
    if (quickFindOpen) {
      setQuery("");
      setActive(0);
      setScope("current");
      setArchivedExpanded(false);
    }
  }, [quickFindOpen]);

  const localBuckets = useMemo<QuickFindBuckets>(() => {
    if (!allPages) return { active: [], archived: [], archivedTotal: 0 };
    const scoped = scope === "all" ? allPages : pagesInSpace(allPages, spaces, activeSpaceId);
    const isArchived = (page: NotePage) => {
      if (isShelved(allPages, page.id)) return true;
      const source = navigationSpaceOf(allPages, spaces, page.id);
      return Boolean(spaces[source]?.knowledgeBase?.archived);
    };
    const buckets = quickFindBuckets(scoped, query, { isArchived });
    if (scope === "current") return buckets;
    const prefixSpace = (hit: Hit): Hit => {
      const source = navigationSpaceOf(allPages, spaces, hit.page.id);
      const name = spaces[source]?.name ?? "个人空间";
      return { ...hit, crumb: [name, hit.crumb].filter(Boolean).join(" / ") };
    };
    return {
      active: buckets.active.map(prefixSpace),
      archived: buckets.archived.map(prefixSpace),
      archivedTotal: buckets.archivedTotal,
    };
  }, [allPages, query, scope, spaces, activeSpaceId]);

  useEffect(() => {
    if (!quickFindOpen || !query.trim()) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ q: query.trim() });
    if (scope === "current") params.set("space", activeSpaceId);
    const timer = window.setTimeout(() => {
      void request<{ hits: RemoteHit[]; archivedTotal?: number }>(`/api/v1/search?${params}`, { signal: controller.signal })
        .then((result) => {
          if (!controller.signal.aborted) {
            setRemote({ key: searchKey, hits: result.hits, archivedTotal: result.archivedTotal ?? 0 });
          }
        })
        .catch(() => { /* Cached text and unsaved local matches remain searchable offline. */ });
    }, 120);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [quickFindOpen, query, scope, activeSpaceId, searchKey]);

  const mergeRemote = useMemo(() => {
    if (!allPages) return (_remoteHits: RemoteHit[], local: Hit[], _expectArchived: boolean) => local;
    const loadedSpaces = new Set(Object.values(allPages).map((entry) => navigationSpaceOf(allPages, spaces, entry.id)));
    return (remoteHits: RemoteHit[], local: Hit[], expectArchived: boolean): Hit[] => {
      // Results in already-loaded spaces resolve through allPages so deleted,
      // trashed, or freshly archived items stay consistent; unactivated authorized KBs synthesize rows.
      const found = remoteHits.flatMap((hit): Hit[] => {
        const targetSpace = hit.spaceId || activeSpaceId;
        if (scope === "current" && targetSpace !== activeSpaceId) return [];
        const page = allPages[hit.id];
        const crumb = scope === "all" ? [hit.space, hit.crumb].filter(Boolean).join(" / ") : hit.crumb;
        if (hit.kind === "memo") {
          if (expectArchived || hit.archived) return [];
          const placeholder: NotePage = {
            id: hit.id,
            kind: "memo",
            icon: hit.icon ?? "",
            title: hit.title,
            title_content: [{ text: hit.title }],
            parent_id: hit.memoParentId ?? null,
            created_at: "",
            updated_at: "",
            created_by: "",
            updated_by: "",
          };
          return [{
            page: placeholder,
            excerpt: hit.excerpt,
            crumb,
            spaceId: targetSpace,
            ...(hit.memoParentId ? { memoParentId: hit.memoParentId } : {}),
            ...(hit.memoComment ? { memoComment: true } : {}),
          }];
        }
        if (page) {
          if (inTrash(allPages, hit.id)) return [];
          const currentlyArchived = isShelved(allPages, hit.id) || Boolean(spaces[targetSpace]?.knowledgeBase?.archived);
          if (currentlyArchived !== expectArchived) return [];
          return [{ page, excerpt: hit.excerpt, crumb, spaceId: targetSpace, ...(expectArchived ? { archived: true } : {}) }];
        }
        const spaceLoaded = loadedSpaces.has(targetSpace) || targetSpace === activeSpaceId;
        const authorized = targetSpace === "personal" || Boolean(spaces[targetSpace]);
        if (spaceLoaded || scope !== "all" || !authorized) return [];
        const placeholder: NotePage = {
          id: hit.id,
          kind: hit.kind ?? "document",
          icon: hit.icon ?? "",
          title: hit.title,
          title_content: [{ text: hit.title }],
          parent_id: null,
          created_at: "",
          updated_at: "",
          created_by: "",
          updated_by: "",
        };
        return [{ page: placeholder, excerpt: hit.excerpt, crumb, spaceId: targetSpace, ...(expectArchived ? { archived: true } : {}) }];
      });
      const included = new Set(found.map((hit) => hit.page.id));
      return [...found, ...local.filter((hit) => !included.has(hit.page.id))].slice(0, 12);
    };
  }, [allPages, spaces, activeSpaceId, scope]);

  const activeHits = useMemo<Hit[]>(() => {
    if (!allPages || remote?.key !== searchKey || !query.trim()) return localBuckets.active;
    return mergeRemote(remote.hits, localBuckets.active, false);
  }, [allPages, remote, searchKey, query, localBuckets.active, mergeRemote]);

  const archivedHits = useMemo<Hit[]>(() => {
    if (!allPages || !query.trim()) return [];
    if (remoteArchived?.key !== searchKey) return localBuckets.archived;
    return mergeRemote(remoteArchived.hits, localBuckets.archived, true);
  }, [allPages, remoteArchived, searchKey, query, localBuckets.archived, mergeRemote]);

  const archivedTotal = query.trim()
    ? Math.max(remote?.key === searchKey ? remote.archivedTotal : 0, localBuckets.archivedTotal, archivedHits.length)
    : 0;
  const autoExpanded = Boolean(query.trim()) && activeHits.length === 0 && archivedTotal > 0;
  const showArchived = archivedExpanded || autoExpanded;

  useEffect(() => {
    if (!quickFindOpen || !query.trim() || !showArchived) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ q: query.trim(), include_archived: "only" });
    if (scope === "current") params.set("space", activeSpaceId);
    void request<{ hits: RemoteHit[] }>(`/api/v1/search?${params}`, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setRemoteArchived({ key: searchKey, hits: result.hits });
      })
      .catch(() => { /* Cached local archived matches remain available offline. */ });
    return () => controller.abort();
  }, [quickFindOpen, query, scope, activeSpaceId, searchKey, showArchived]);

  const entries = useMemo<QuickFindEntry[]>(() => {
    const list: QuickFindEntry[] = activeHits.map((hit) => ({ kind: "hit", hit }));
    if (archivedTotal > 0) {
      if (!showArchived) list.push({ kind: "expand", count: archivedTotal });
      else for (const hit of archivedHits) list.push({ kind: "hit", hit });
    }
    return list;
  }, [activeHits, archivedHits, archivedTotal, showArchived]);

  const activeIndex = entries.length ? Math.min(active, entries.length - 1) : 0;

  useEffect(() => {
    if (!quickFindOpen) return;
    resultsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, entries, quickFindOpen]);

  const open = (hit: Hit, mode: "default" | "new-tab" | "split-right" = "default") => {
    if (hit.page.kind === "memo") {
      const finishMemo = () => {
        setPreference("sidebar_view", "memos");
        openMemo(hit.memoParentId ?? hit.page.id, hit.memoComment ? hit.page.id : undefined);
        setQuickFindOpen(false);
      };
      if (activeSpaceId !== "personal") {
        void activateSpace("personal").then(finishMemo).catch(() => undefined);
      } else {
        finishMemo();
      }
      return;
    }
    const finish = () => {
      if (preferences.sidebar_view === "memos") setPreference("sidebar_view", "files");
      if (mode === "new-tab") openInNewTab(hit.page.id);
      else if (mode === "split-right") openInRightSplit(hit.page.id);
      else selectPage(hit.page.id);
      setQuickFindOpen(false);
    };
    if (allPages?.[hit.page.id] || !hit.spaceId) { finish(); return; }
    void activateSpace(hit.spaceId, { seedPageId: hit.page.id }).then(finish).catch(() => undefined);
  };

  const expandArchived = () => {
    setArchivedExpanded(true);
    setActive(activeHits.length);
    inputRef.current?.focus();
  };

  const renderHitRow = (hit: Hit, index: number) => (
    <button
      type="button"
      key={hit.page.id}
      role="option"
      aria-selected={index === activeIndex}
      className={`menu__item ${index === activeIndex ? "is-active" : ""} ${hit.archived ? "quickfind__item--archived" : ""}`}
      onPointerMove={() => setActive(index)}
      onClick={(event) => {
        const mode = event.altKey ? "split-right" : (event.metaKey || event.ctrlKey) ? "new-tab" : "default";
        open(hit, mode);
      }}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onMouseUp={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          open(hit, "new-tab");
        }
      }}
    >
      <span className="menu__icon" aria-hidden="true">{pageGlyph(hit.page)}</span>
      <span className="menu__copy">
        <span className="menu__label">{markText(pageName(hit.page), query)}</span>
        {hit.excerpt ? <span className="menu__description">{markText(hit.excerpt, query)}</span> : null}
      </span>
      {hit.crumb ? <span className="quickfind__crumb">{hit.crumb}</span> : null}
      {hit.page.kind === "memo" ? <span className="quickfind__badge">{hit.memoComment ? "批注" : "闪念"}</span> : null}
      {hit.archived ? <span className="quickfind__badge">已归档</span> : null}
    </button>
  );

  return (
    <Modal open={quickFindOpen} label="Search pages" className="quickfind" onClose={() => setQuickFindOpen(false)}>
      <div className="quickfind__input">
        <Search size={18} />
        <input
          ref={inputRef}
          autoFocus
          value={query}
          placeholder="搜索页面…"
          aria-label="Search pages"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setArchivedExpanded(false);
          }}
          onKeyDown={(event) => {
            if (imeComposing(event)) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const delta = event.key === "ArrowDown" ? 1 : -1;
              setActive((index) => (index + delta + entries.length) % Math.max(1, entries.length));
              return;
            }
            if (event.key === "Enter" && entries[activeIndex]) {
              event.preventDefault();
              const entry = entries[activeIndex];
              if (entry.kind === "expand") expandArchived();
              else open(entry.hit);
            }
          }}
        />
        {/* The scope is a two-way choice the user changes rarely — a segment
         *  in the input row keeps it visible and one click away without
         *  giving it a row of its own. */}
        <div className="quickfind__seg" role="radiogroup" aria-label="搜索范围">
          <button
            type="button" role="radio" aria-checked={scope === "current"}
            className={scope === "current" ? "is-on" : ""}
            onClick={() => { setScope("current"); setActive(0); setArchivedExpanded(false); }}
          >{activeSpace?.name ?? "个人空间"}</button>
          <button
            type="button" role="radio" aria-checked={scope === "all"}
            className={scope === "all" ? "is-on" : ""}
            onClick={() => { setScope("all"); setActive(0); setArchivedExpanded(false); }}
          >所有空间</button>
        </div>
      </div>

      <div ref={resultsRef} className="menu scroller" role="listbox" aria-label="Results">
        {entries.length ? (
          <>
            {activeHits.map((hit, index) => renderHitRow(hit, index))}
            {archivedTotal > 0 && !showArchived ? (
              <button
                type="button"
                role="option"
                aria-selected={activeHits.length === activeIndex}
                className={`menu__item quickfind__archived-toggle ${activeHits.length === activeIndex ? "is-active" : ""}`}
                onPointerMove={() => setActive(activeHits.length)}
                onClick={expandArchived}
              >
                <span className="menu__icon" aria-hidden="true"><Archive size={15} /></span>
                <span className="menu__copy">
                  <span className="menu__label">已归档结果（{archivedTotal}）</span>
                </span>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            ) : null}
            {archivedTotal > 0 && showArchived ? (
              <>
                <div className={`quickfind__archived-head ${activeHits.length === 0 ? "quickfind__archived-head--solo" : ""}`}>
                  <span>已归档结果（{archivedTotal}）</span>
                  {activeHits.length > 0 ? (
                    <button
                      type="button"
                      className="quickfind__archived-collapse"
                      onClick={() => { setArchivedExpanded(false); setActive(0); inputRef.current?.focus(); }}
                    >收起</button>
                  ) : null}
                </div>
                {archivedHits.map((hit, offset) => renderHitRow(hit, activeHits.length + offset))}
              </>
            ) : null}
          </>
        ) : (
          <div className="slash__empty">{query.trim() ? `没有「${query.trim()}」的页面` : "还没有页面"}</div>
        )}
      </div>
    </Modal>
  );
}
