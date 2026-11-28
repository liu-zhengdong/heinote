import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

interface SidebarMarqueeOptions {
  enabled: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  visibleOrderRef: RefObject<readonly string[]>;
  rowIndexRef: RefObject<ReadonlyMap<string, number>>;
  rowHeight: number;
  rootImportCount: number;
  currentSelectionRef: RefObject<ReadonlySet<string>>;
  onSelectionChange(next: ReadonlySet<string>): void;
}

interface MarqueeStartState {
  x: number;
  y: number;
  active: boolean;
  additive: boolean;
  base: Set<string>;
}

/** Rubber-band box selection inside the sidebar Files tree: starts in empty
 *  scroll space or a row's left/right gutter, supports Shift/Cmd/Ctrl additive
 *  mode, auto-scrolls near the edges, and hit-tests virtualized rows too. */
export function useSidebarMarquee({
  enabled,
  scrollRef,
  visibleOrderRef,
  rowIndexRef,
  rowHeight,
  rootImportCount,
  currentSelectionRef,
  onSelectionChange,
}: SidebarMarqueeOptions) {
  const marqueeStart = useRef<MarqueeStartState | null>(null);
  const marqueeDragged = useRef(false);
  const clearDraggedTimerRef = useRef<number | null>(null);
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  const rowHeightRef = useRef(rowHeight);
  rowHeightRef.current = rowHeight;
  const rootImportCountRef = useRef(rootImportCount);
  rootImportCountRef.current = rootImportCount;
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;

  const beginMarquee = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const scroller = scrollRef.current;
    const target = event.target as Element | null;
    if (clearDraggedTimerRef.current !== null) {
      window.clearTimeout(clearDraggedTimerRef.current);
      clearDraggedTimerRef.current = null;
    }
    marqueeDragged.current = false;
    if (!enabled || event.button !== 0 || event.pointerType === "touch" || !scroller || !target) {
      marqueeStart.current = null;
      return;
    }
    if (target.closest(".sidebar__archived, input, .tree-row__actions, .tree-row__mark, .rail-invite, .tree-row--import")) {
      marqueeStart.current = null;
      return;
    }
    const row = target.closest<HTMLElement>(".tree-row");
    if (row) {
      if (!row.dataset.pageId) {
        marqueeStart.current = null;
        return;
      }
      const mark = row.querySelector<HTMLElement>(".tree-row__mark");
      const inLeftGutter = Boolean(mark && event.clientX < mark.getBoundingClientRect().left);
      const inRightGutter = event.clientX > row.getBoundingClientRect().right - 10;
      if (!inLeftGutter && !inRightGutter) {
        marqueeStart.current = null;
        return;
      }
    }
    const rect = scroller.getBoundingClientRect();
    marqueeStart.current = {
      x: event.clientX - rect.left + scroller.scrollLeft,
      y: event.clientY - rect.top + scroller.scrollTop,
      active: false,
      additive: event.metaKey || event.ctrlKey || event.shiftKey,
      base: new Set(currentSelectionRef.current),
    };
  }, [currentSelectionRef, enabled, scrollRef]);

  const onMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    // Prevent native text selection and HTML5 dragstart from hijacking a
    // marquee drag that begins in a row's left/right gutter.
    if (marqueeStart.current) event.preventDefault();
  }, []);

  useEffect(() => {
    let frame = 0;
    let pointer = { x: 0, y: 0 };
    let lastSignature = "";

    const update = () => {
      const start = marqueeStart.current;
      const scroller = scrollRef.current;
      if (!start || !scroller) return;
      const rect = scroller.getBoundingClientRect();
      const maxX = Math.max(scroller.clientWidth, scroller.scrollWidth);
      const maxY = Math.max(scroller.clientHeight, scroller.scrollHeight);
      const x = Math.max(0, Math.min(maxX, pointer.x - rect.left + scroller.scrollLeft));
      const y = Math.max(0, Math.min(maxY, pointer.y - rect.top + scroller.scrollTop));
      if (!start.active && Math.hypot(x - start.x, y - start.y) < 4) return;
      start.active = true;
      marqueeDragged.current = true;

      const left = Math.min(start.x, x);
      const top = Math.min(start.y, y);
      const bottom = Math.max(start.y, y);
      const width = Math.abs(x - start.x);
      const height = bottom - top;
      setMarquee({ left, top, width, height });

      const mounted = new Map<string, { top: number; bottom: number }>();
      let firstMounted: { index: number; top: number } | undefined;
      const rowIndex = rowIndexRef.current;
      const currentRowHeight = rowHeightRef.current;
      for (const el of scroller.querySelectorAll<HTMLElement>(":scope > .tree-branch .tree-row[data-page-id]")) {
        const id = el.dataset.pageId;
        if (!id) continue;
        const box = el.getBoundingClientRect();
        const rowTop = box.top - rect.top + scroller.scrollTop;
        const rowBottom = box.bottom - rect.top + scroller.scrollTop;
        mounted.set(id, { top: rowTop, bottom: rowBottom });
        if (!firstMounted) {
          const idx = rowIndex.get(id);
          if (idx !== undefined) firstMounted = { index: idx, top: rowTop };
        }
      }
      const treeTopOffset = firstMounted
        ? firstMounted.top - firstMounted.index * currentRowHeight
        : 4 + rootImportCountRef.current * (currentRowHeight + 1);

      const hits: string[] = [];
      const order = visibleOrderRef.current;
      for (let index = 0; index < order.length; index += 1) {
        const id = order[index];
        const box = mounted.get(id) ?? {
          top: treeTopOffset + index * currentRowHeight,
          bottom: treeTopOffset + (index + 1) * currentRowHeight,
        };
        if (box.bottom > top && box.top < bottom) hits.push(id);
      }

      const next = start.additive ? new Set([...start.base, ...hits]) : new Set(hits);
      const signature = [...next].join("\0");
      if (signature === lastSignature) return;
      lastSignature = signature;
      onSelectionChangeRef.current(next);
    };

    const scrollAtEdge = () => {
      const scroller = scrollRef.current;
      if (!scroller || !marqueeStart.current?.active) return;
      const rect = scroller.getBoundingClientRect();
      const edge = 28;
      let delta = 0;
      if (pointer.y < rect.top + edge) {
        delta = -Math.max(4, Math.min(18, Math.round((rect.top + edge - pointer.y) * 0.45)));
      } else if (pointer.y > rect.bottom - edge) {
        delta = Math.max(4, Math.min(18, Math.round((pointer.y - (rect.bottom - edge)) * 0.45)));
      }
      if (delta !== 0) {
        scroller.scrollTop += delta;
        update();
      }
      frame = requestAnimationFrame(scrollAtEdge);
    };

    const onMove = (event: PointerEvent) => {
      const start = marqueeStart.current;
      if (!start) return;
      pointer = { x: event.clientX, y: event.clientY };
      const wasActive = start.active;
      update();
      if (!wasActive && start.active) frame = requestAnimationFrame(scrollAtEdge);
    };

    const onEnd = () => {
      if (!marqueeStart.current) return;
      const wasDragged = marqueeStart.current.active;
      marqueeStart.current = null;
      lastSignature = "";
      cancelAnimationFrame(frame);
      setMarquee(null);
      if (wasDragged) {
        clearDraggedTimerRef.current = window.setTimeout(() => {
          marqueeDragged.current = false;
          clearDraggedTimerRef.current = null;
        }, 0);
      }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onEnd);
    document.addEventListener("pointercancel", onEnd);
    return () => {
      cancelAnimationFrame(frame);
      if (clearDraggedTimerRef.current !== null) {
        window.clearTimeout(clearDraggedTimerRef.current);
        clearDraggedTimerRef.current = null;
      }
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onEnd);
      document.removeEventListener("pointercancel", onEnd);
    };
  }, [rowIndexRef, scrollRef, visibleOrderRef]);

  return {
    marquee,
    marqueeStartRef: marqueeStart,
    marqueeDraggedRef: marqueeDragged,
    beginMarquee,
    onMouseDown,
  };
}
