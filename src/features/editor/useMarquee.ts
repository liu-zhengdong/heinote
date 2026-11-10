import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { rowsWithin } from "./selection";

/** What box selection needs of the editor. */
interface MarqueeContext {
  readOnly: boolean;
  articleRef: RefObject<HTMLElement | null>;
  blocksRef: RefObject<HTMLDivElement | null>;
  selectBlocks(anchor: string, focus?: string): void;
  clearSelection(): void;
}

/** Notion's box: a drag that starts beside the text — in the margins, or
 *  below the last block — draws it, and every block it passes is selected. */
export function useMarquee({ readOnly, articleRef, blocksRef, selectBlocks, clearSelection }: MarqueeContext) {
  /* A box selection in progress: where it started (in the page's own
     coordinates, so scrolling does not move it) and whether it has moved far
     enough to be a drag rather than a click. */
  const marqueeStart = useRef<{ x: number; y: number; active: boolean } | null>(null);
  const marqueeDragged = useRef(false);
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  /* ── Box selection ────────────────────────────────────────────────────
     A drag that starts beside the text — in the margins, or below the last
     block — draws Notion's box, and every block it passes is selected. */
  const beginMarquee = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const article = articleRef.current;
    const target = event.target as Element;
    marqueeDragged.current = false;
    if (readOnly || event.button !== 0 || !article) return;
    if (target !== article && !target.classList.contains("doc__inner") && !target.classList.contains("doc__pad")) return;
    const bounds = article.getBoundingClientRect();
    marqueeStart.current = { x: event.clientX - bounds.left, y: event.clientY - bounds.top, active: false };
  }, [articleRef, readOnly]);

  useEffect(() => {
    let frame = 0;
    let pointer = { x: 0, y: 0 };
    let reached = "";
    const update = () => {
      const start = marqueeStart.current;
      const article = articleRef.current;
      if (!start || !article) return;
      const bounds = article.getBoundingClientRect();
      const x = pointer.x - bounds.left;
      const y = pointer.y - bounds.top;
      if (!start.active && Math.hypot(x - start.x, y - start.y) < 4) return;
      start.active = true;
      marqueeDragged.current = true;
      const top = Math.min(start.y, y);
      const bottom = Math.max(start.y, y);
      const left = Math.min(start.x, x);
      setMarquee({ left, top, width: Math.abs(x - start.x), height: bottom - top });
      const hits = rowsWithin(blocksRef.current).filter((row) => {
        // A line drawn as what it shows — a page, a block, a database — is
        // reached by that.
        const box = row.querySelector(":scope > :is(.block__content, .mount, .db-frame)")?.getBoundingClientRect();
        return Boolean(box && box.bottom - bounds.top > top && box.top - bounds.top < bottom);
      });
      const first = hits[0]?.dataset.blockId;
      const last = hits.at(-1)?.dataset.blockId;
      const now = first && last ? `${first}:${last}` : "";
      if (now === reached) return;
      reached = now;
      if (first && last) selectBlocks(first, last);
      else clearSelection();
    };
    // Near the top or bottom of the pane the page scrolls under the box.
    const scrollAtEdge = () => {
      const scroller = articleRef.current?.closest<HTMLElement>(".scroller");
      if (!scroller || !marqueeStart.current?.active) return;
      const box = scroller.getBoundingClientRect();
      const step = pointer.y < box.top + 32 ? -12 : pointer.y > box.bottom - 32 ? 12 : 0;
      if (step) {
        scroller.scrollTop += step;
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
    const onUp = () => {
      if (!marqueeStart.current) return;
      marqueeStart.current = null;
      reached = "";
      cancelAnimationFrame(frame);
      setMarquee(null);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
  }, [articleRef, blocksRef, clearSelection, selectBlocks]);

  return { marquee, marqueeStart, marqueeDragged, beginMarquee };
}
