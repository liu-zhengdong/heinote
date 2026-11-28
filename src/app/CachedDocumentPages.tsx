import { Activity, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { NotePage } from "../core/types";
import { inTrash, isPurging } from "../core/page-tree";
import { DocumentEditor } from "../features/editor/DocumentEditor";
import { useWorkspace } from "./workspace-context";
import { sameItems, usePage, useWorkspaceState } from "./workspace-store";

/** Baseline number of recently visited document pages kept warm per pane.
 *  Pinned tabs are retained above this baseline up to MAX_CACHED_CAP. */
const BASE_CACHED_PAGES = 6;
const MAX_CACHED_CAP = 10;

function trimCachedIds(
  current: readonly string[],
  activePageId: string | null,
  pinnedIds: readonly string[],
): string[] {
  const pinnedSet = new Set(pinnedIds);
  const ordered = activePageId
    ? [...current.filter((id) => id !== activePageId), activePageId]
    : [...current];
  const limit = Math.min(MAX_CACHED_CAP, Math.max(BASE_CACHED_PAGES, pinnedSet.size + 2));
  if (ordered.length <= limit) return ordered;
  const result = [...ordered];
  for (let i = 0; i < result.length && result.length > limit;) {
    const id = result[i];
    if (id !== activePageId && !pinnedSet.has(id)) result.splice(i, 1);
    else i += 1;
  }
  return result.length > limit ? result.slice(-limit) : result;
}

/** The open page's editor, redrawn as the page changes — the shell around it
 *  is not. A page whose body is still being pulled in (UC-48) shows a quiet
 *  loading row where its words will be. */
export function OpenPage({
  pageId,
  preview,
  readOnly,
}: {
  pageId: string;
  preview: NotePage | null;
  readOnly: boolean;
}) {
  const page = usePage(pageId);
  const { loadPages } = useWorkspace();
  useEffect(() => { loadPages([pageId]); }, [loadPages, pageId]);
  if (!page) return null;
  if (!preview && page.block_tree === undefined) {
    return (
      <div className="page-loading" aria-busy="true">
        <span className="page-loading__line" />
        <span className="page-loading__line" />
        <span className="page-loading__line" />
      </div>
    );
  }
  return <DocumentEditor page={preview ?? page} readOnly={readOnly} historical={Boolean(preview)} />;
}

/** Synchronously swaps the active page's detached portal container into the
 *  live `.page-cache-host` BEFORE any restored `<Activity>` child's
 *  `useLayoutEffect` runs, and saves/restores scroll position per page. */
function SlotSync({
  hostRef,
  surfaceEl,
  activePageId,
  slotsRef,
  scrollsRef,
}: {
  hostRef: RefObject<HTMLDivElement | null>;
  surfaceEl: HTMLElement | null;
  activePageId: string | null;
  slotsRef: RefObject<Map<string, HTMLDivElement>>;
  scrollsRef: RefObject<Map<string, number>>;
}) {
  const previousActiveRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const prevId = previousActiveRef.current;

    if (host) {
      const targetSlot = activePageId ? slotsRef.current.get(activePageId) ?? null : null;
      for (const child of [...host.children]) {
        if (child !== targetSlot) child.remove();
      }
      if (targetSlot && targetSlot.parentElement !== host) {
        host.appendChild(targetSlot);
      }
    }

    if (activePageId && activePageId !== prevId && surfaceEl) {
      surfaceEl.scrollTop = scrollsRef.current.get(activePageId) ?? 0;
    }
    previousActiveRef.current = activePageId;

    if (!activePageId || !surfaceEl) return;
    const onScroll = () => {
      scrollsRef.current.set(activePageId, surfaceEl.scrollTop);
    };
    surfaceEl.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      surfaceEl.removeEventListener("scroll", onScroll);
    };
  }, [activePageId, hostRef, scrollsRef, slotsRef, surfaceEl]);

  return null;
}

/** Keeps up to `MAX_CACHED_PAGES` recently viewed document pages warm via
 *  React 19 `<Activity>` inside detached portal containers.
 *
 *  Inactive pages stay detached from `document` with `<Activity mode="hidden">`,
 *  so their effects pause, their layout/paint cost drops to zero, and live
 *  document queries (`document.querySelector`, `Cmd+F`, accessibility tree)
 *  never see hidden pages — while switching back re-attaches the already-built
 *  DOM subtree in a single operation. */
export function CachedDocumentPages({
  activePageId,
  pinnedIds = [],
  surfaceEl,
  canEdit,
}: {
  activePageId: string | null;
  pinnedIds?: readonly string[];
  surfaceEl: HTMLElement | null;
  canEdit(pageId: string): boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const slotsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollsRef = useRef<Map<string, number>>(new Map());
  const [lruIds, setLruIds] = useState<string[]>(() => (activePageId ? [activePageId] : []));

  // Maintain bounded LRU order including the active page right during render
  // while keeping pinned tabs warm so switching ordinary tabs never drops them.
  const orderedIds = trimCachedIds(lruIds, activePageId, pinnedIds);

  // Evict cached pages that were deleted, moved to trash, purging, or converted
  // away from `document` — without re-rendering on ordinary typing.
  const validIds = useWorkspaceState(
    (state) => orderedIds.filter((id) => {
      const page = state.pages[id];
      return Boolean(page && page.kind === "document" && !inTrash(state.pages, id) && !isPurging(state.pages, id));
    }),
    sameItems,
  );

  // Sync trimmed/evicted LRU list back into state and discard evicted DOM slots.
  const validKey = validIds.join("\0");
  useEffect(() => {
    setLruIds((prev) => (sameItems(prev, validIds) ? prev : validIds));
    const keep = new Set(validIds);
    for (const [id, slot] of slotsRef.current) {
      if (!keep.has(id)) {
        slot.remove();
        slotsRef.current.delete(id);
        scrollsRef.current.delete(id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validKey]);

  useEffect(() => () => {
    for (const slot of slotsRef.current.values()) slot.remove();
    slotsRef.current.clear();
    scrollsRef.current.clear();
  }, []);

  const getSlot = (id: string): HTMLDivElement => {
    let slot = slotsRef.current.get(id);
    if (!slot) {
      slot = document.createElement("div");
      slot.className = "page-cache-slot";
      slotsRef.current.set(id, slot);
    }
    return slot;
  };

  // Pre-create the slot for every valid cached page before SlotSync runs.
  for (const id of validIds) getSlot(id);

  return (
    <>
      <SlotSync
        hostRef={hostRef}
        surfaceEl={surfaceEl}
        activePageId={activePageId && validIds.includes(activePageId) ? activePageId : null}
        slotsRef={slotsRef}
        scrollsRef={scrollsRef}
      />
      <div ref={hostRef} className="page-cache-host" hidden={!activePageId} />
      {validIds.map((id) => createPortal(
        <Activity key={id} mode={id === activePageId ? "visible" : "hidden"}>
          <OpenPage pageId={id} preview={null} readOnly={!canEdit(id)} />
        </Activity>,
        getSlot(id),
        id,
      ))}
    </>
  );
}
