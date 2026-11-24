import { Pin, PinOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import type { OutlineItem } from "../core/outline";
import "./page-outline.css";

const PIN_STORAGE_KEY = "heinote.outline.pinned";
/** Minimum scroll container width to show the quiet tick rail. */
const SHOW_MIN_WIDTH = 640;
/** Minimum scroll container width to allow pinning the full outline open. */
const PIN_MIN_WIDTH = 1020;
const HOVER_CLOSE_DELAY_MS = 180;
const CLICK_LOCK_MS = 650;
const FLASH_DURATION_MS = 1400;

function readPinnedPreference(storageKey: string): boolean {
  try {
    return window.localStorage.getItem(storageKey) === "1";
  } catch {
    return false;
  }
}

function writePinnedPreference(storageKey: string, pinned: boolean): void {
  try {
    if (pinned) window.localStorage.setItem(storageKey, "1");
    else window.localStorage.removeItem(storageKey);
  } catch {
    // Storage may be unavailable in private browsing or restricted iframes.
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function findBlockElement(root: HTMLElement | null, blockId: string): HTMLElement | null {
  if (!root) return null;
  const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(blockId)
    : blockId.replace(/["\\]/g, "\\$&");
  return root.querySelector<HTMLElement>(`[data-block-id="${escaped}"]`);
}

function flashTarget(element: HTMLElement): void {
  if (prefersReducedMotion()) return;
  element.classList.remove("outline-flash");
  // Force reflow so re-clicking the same heading replays the highlight.
  void element.offsetWidth;
  element.classList.add("outline-flash");
  window.setTimeout(() => element.classList.remove("outline-flash"), FLASH_DURATION_MS);
}

interface LayoutMetrics {
  width: number;
  rightInset: number;
  topInset: number;
}

export interface PageOutlineProps {
  items: OutlineItem[];
  /** Root element containing the rendered `[data-block-id]` blocks. */
  contentRoot: HTMLElement | null;
  /** Vertical scroll container; auto-discovered from `contentRoot` if omitted. */
  scrollContainer?: HTMLElement | null;
  /** Height of any fixed/absolute bar overlapping the top of the scroll container. */
  topOffset?: number;
  /** Top position for the pinned outline panel relative to the scroll container top. */
  pinnedTopOffset?: number;
  /** localStorage key used to persist the user's pinned preference. */
  pinStorageKey?: string;
  /** Called before jumping if the heading block has not mounted yet (progressive rendering). */
  onEnsureBlock?: (blockId: string) => void;
  /** Bumped as progressive chunks mount so scrollspy observes newly arrived headings. */
  renderRevision?: number;
}

/** Shared Notion-style document outline: a quiet right-edge tick rail at rest,
 *  an interactive floating card on hover/click/focus, and an optional wide-screen
 *  pinned sidebar that stays clear of the text column. */
export function PageOutline({
  items,
  contentRoot,
  scrollContainer: scrollContainerProp,
  topOffset = 44,
  pinnedTopOffset = 72,
  pinStorageKey = PIN_STORAGE_KEY,
  onEnsureBlock,
  renderRevision = 0,
}: PageOutlineProps) {
  const [pinnedPref, setPinnedPref] = useState(() => readPinnedPreference(pinStorageKey));
  const [hovered, setHovered] = useState(false);
  const [clickedOpen, setClickedOpen] = useState(false);
  const [activeId, setActiveId] = useState<string>(() => items[0]?.id ?? "");
  const [metrics, setMetrics] = useState<LayoutMetrics>({ width: 0, rightInset: 16, topInset: 0 });

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const leaveTimerRef = useRef<number | null>(null);
  const clickLockRef = useRef<{ id: string; until: number } | null>(null);

  const scrollContainer = useMemo(() => {
    if (scrollContainerProp) return scrollContainerProp;
    if (!contentRoot) return null;
    return contentRoot.closest<HTMLElement>(".page-surface, .public-reader") ?? contentRoot.parentElement;
  }, [contentRoot, scrollContainerProp]);

  const itemIdsKey = useMemo(() => items.map((item) => item.id).join("\0"), [items]);

  // Measure the scroll container's live geometry so the outline stays tucked
  // inside its right edge (even when a scrollbar or docked SidePeek is present)
  // and cleanly adapts between hidden / tick-rail / pinned modes.
  useEffect(() => {
    if (!scrollContainer) return;
    const measure = () => {
      const rect = scrollContainer.getBoundingClientRect();
      const width = scrollContainer.clientWidth;
      const rightEdge = rect.left + width;
      const rightInset = Math.max(0, Math.round(window.innerWidth - rightEdge));
      const topInset = Math.max(0, Math.round(rect.top));
      setMetrics((prev) =>
        prev.width === width && prev.rightInset === rightInset && prev.topInset === topInset
          ? prev
          : { width, rightInset, topInset },
      );
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(scrollContainer);
    window.addEventListener("resize", measure, { passive: true });
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [scrollContainer]);

  const visible = items.length > 0 && metrics.width >= SHOW_MIN_WIDTH;
  const canPin = metrics.width >= PIN_MIN_WIDTH;
  const isPinned = visible && pinnedPref && canPin;
  const isExpanded = isPinned || hovered || clickedOpen;

  // Keep activeId valid when headings change or when switching pages.
  useEffect(() => {
    if (!items.length) {
      setActiveId("");
      return;
    }
    setActiveId((current) => (items.some((item) => item.id === current) ? current : items[0].id));
  }, [itemIdsKey, items]);

  // Scrollspy: determine the active heading from live positions in the scroll
  // container (also handles flat heading blocks that scroll above the viewport,
  // short bottom sections, and browsers without CSS scroll-target-group).
  const computeActive = useCallback(() => {
    if (!items.length || !scrollContainer || !contentRoot) return;
    const lock = clickLockRef.current;
    if (lock) {
      if (Date.now() < lock.until && items.some((item) => item.id === lock.id)) {
        setActiveId(lock.id);
        return;
      }
      clickLockRef.current = null;
    }

    const containerRect = scrollContainer.getBoundingClientRect();
    const threshold = topOffset + 56;
    const viewportBottom = scrollContainer.clientHeight;
    let currentId = items[0].id;
    let lastVisibleId: string | null = null;

    for (const item of items) {
      const element = findBlockElement(contentRoot, item.id);
      if (!element) continue;
      const relativeTop = element.getBoundingClientRect().top - containerRect.top;
      if (relativeTop <= threshold) {
        currentId = item.id;
      }
      if (relativeTop >= topOffset && relativeTop <= viewportBottom - 24) {
        lastVisibleId = item.id;
      }
      // Headings are in document order; stop once past the viewport so we do
      // not force layout on off-screen `content-visibility: auto` chunks.
      if (relativeTop > viewportBottom) break;
    }

    // When scrolled all the way to the bottom, activate the last visible heading
    // if the final section is too short to reach the top threshold.
    const atBottom =
      scrollContainer.scrollHeight > scrollContainer.clientHeight + 4 &&
      scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - 8;
    if (atBottom && lastVisibleId) {
      currentId = lastVisibleId;
    }

    setActiveId((prev) => (prev === currentId ? prev : currentId));
  }, [contentRoot, items, scrollContainer, topOffset]);

  useEffect(() => {
    if (!visible || !scrollContainer || !contentRoot) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        computeActive();
      });
    };

    computeActive();
    scrollContainer.addEventListener("scroll", schedule, { passive: true });
    scrollContainer.addEventListener("scrollend", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });

    // Also observe heading intersections as an efficient signal for dynamic layout shifts.
    let intersection: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== "undefined") {
      intersection = new IntersectionObserver(schedule, {
        root: scrollContainer,
        rootMargin: `-${topOffset}px 0px -60% 0px`,
        threshold: 0,
      });
      for (const item of items) {
        const element = findBlockElement(contentRoot, item.id);
        if (element) intersection.observe(element);
      }
    }

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      scrollContainer.removeEventListener("scroll", schedule);
      scrollContainer.removeEventListener("scrollend", schedule);
      window.removeEventListener("resize", schedule);
      intersection?.disconnect();
    };
  }, [computeActive, contentRoot, itemIdsKey, items, renderRevision, scrollContainer, topOffset, visible]);

  // Keep the active item visible inside the outline card's own scroll list.
  useEffect(() => {
    if (!isExpanded || !activeId || !listRef.current) return;
    const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(activeId)
      : activeId.replace(/["\\]/g, "\\$&");
    const activeLink = listRef.current.querySelector<HTMLElement>(`[data-outline-id="${escaped}"]`);
    activeLink?.scrollIntoView({ block: "nearest" });
  }, [activeId, isExpanded]);

  // Close click-opened popover on Escape or outside pointer press.
  useEffect(() => {
    if (!clickedOpen || isPinned) return;
    const onPointerDown = (event: PointerEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setClickedOpen(false);
        setHovered(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setClickedOpen(false);
        setHovered(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [clickedOpen, isPinned]);

  useEffect(() => () => {
    if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current);
  }, []);

  const clearLeaveTimer = () => {
    if (leaveTimerRef.current !== null) {
      window.clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
  };

  const handlePointerEnter = () => {
    clearLeaveTimer();
    setHovered(true);
  };

  const handlePointerLeave = () => {
    clearLeaveTimer();
    leaveTimerRef.current = window.setTimeout(() => {
      setHovered(false);
    }, HOVER_CLOSE_DELAY_MS);
  };

  const togglePin = () => {
    setPinnedPref((current) => {
      const next = !current;
      writePinnedPreference(pinStorageKey, next);
      if (!next) {
        setClickedOpen(false);
        setHovered(false);
      }
      return next;
    });
  };

  const jumpTo = (item: OutlineItem, event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (!scrollContainer || !contentRoot) return;
    let target = findBlockElement(contentRoot, item.id);
    if (!target && onEnsureBlock) {
      onEnsureBlock(item.id);
      target = findBlockElement(contentRoot, item.id);
    }
    if (!target) return;

    const containerRect = scrollContainer.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const destination = Math.max(0, scrollContainer.scrollTop + (targetRect.top - containerRect.top) - topOffset - 16);

    clickLockRef.current = { id: item.id, until: Date.now() + CLICK_LOCK_MS };
    setActiveId(item.id);
    scrollContainer.scrollTo({
      top: destination,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    flashTarget(target);

    // Keyboard activation moves focus to the heading target so keyboard readers
    // can immediately navigate or scroll from that section.
    if (event.detail === 0) {
      const hadTabIndex = target.hasAttribute("tabindex");
      if (!hadTabIndex) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
      if (!hadTabIndex) {
        const cleanup = () => target.removeAttribute("tabindex");
        target.addEventListener("blur", cleanup, { once: true });
      }
    }

    if (!isPinned && clickedOpen) {
      setClickedOpen(false);
    }
  };

  if (!visible) return null;

  const denseTicks = items.length > 18;
  const style = {
    "--outline-right": `${metrics.rightInset + 16}px`,
    "--outline-top": `${metrics.topInset + pinnedTopOffset}px`,
  } as CSSProperties;

  return (
    <div
      ref={wrapperRef}
      className={[
        "page-outline",
        isPinned ? "page-outline--pinned" : "",
        isExpanded && !isPinned ? "page-outline--open" : "",
      ].filter(Boolean).join(" ")}
      style={style}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onFocusCapture={() => {
        clearLeaveTimer();
        setHovered(true);
      }}
      onBlurCapture={(event) => {
        if (!wrapperRef.current?.contains(event.relatedTarget as Node | null)) {
          setHovered(false);
          setClickedOpen(false);
        }
      }}
    >
      {!isPinned ? (
        <button
          type="button"
          className={`page-outline__rail${denseTicks ? " page-outline__rail--dense" : ""}`}
          aria-label="页面大纲"
          aria-expanded={isExpanded}
          onClick={() => setClickedOpen((open) => !open)}
        >
          {items.map((item) => {
            const isActive = item.id === activeId;
            return (
              <span
                key={item.id}
                className={`page-outline__tick page-outline__tick--d${item.depth}${isActive ? " is-active" : ""}`}
                aria-hidden="true"
              />
            );
          })}
        </button>
      ) : null}

      {isExpanded ? (
        <nav
          className={`page-outline__card${isPinned ? " page-outline__card--pinned" : ""}`}
          aria-label="页面大纲"
        >
          <div className="page-outline__head">
            <span className="page-outline__title">大纲</span>
            {canPin ? (
              <button
                type="button"
                className={`page-outline__pin${isPinned ? " is-pinned" : ""}`}
                aria-label={isPinned ? "取消固定大纲" : "固定大纲到右侧"}
                aria-pressed={isPinned}
                title={isPinned ? "取消固定" : "固定到右侧"}
                onClick={togglePin}
              >
                {isPinned ? <PinOff size={13} aria-hidden="true" /> : <Pin size={13} aria-hidden="true" />}
              </button>
            ) : null}
          </div>
          <div ref={listRef} className="page-outline__list">
            {items.map((item) => {
              const isActive = item.id === activeId;
              return (
                <a
                  key={item.id}
                  href={`#outline-${encodeURIComponent(item.id)}`}
                  data-outline-id={item.id}
                  className={`page-outline__item page-outline__item--d${item.depth}${isActive ? " is-active" : ""}`}
                  aria-current={isActive ? "location" : undefined}
                  title={item.text}
                  onClick={(event) => jumpTo(item, event)}
                >
                  <span className="page-outline__item-label">{item.text}</span>
                </a>
              );
            })}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
