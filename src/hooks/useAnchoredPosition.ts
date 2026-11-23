import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

export interface AnchorRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
}

export type Placement =
  | "bottom-start"
  | "bottom-end"
  | "top-start"
  | "top-end"
  | "right-start"
  | "left-start";

const VIEWPORT_MARGIN = 8;

export function rectOf(element: Element): AnchorRect {
  const { top, left, bottom, right, width, height } = element.getBoundingClientRect();
  return { top, left, bottom, right, width, height };
}

export function pointRect(x: number, y: number): AnchorRect {
  return { top: y, left: x, bottom: y, right: x, width: 0, height: 0 };
}

function viewportBounds(): { minTop: number; maxBottom: number; maxWidth: number } {
  const vv = window.visualViewport;
  const vvTop = vv ? vv.offsetTop : 0;
  const vvBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const editBar = document.querySelector<HTMLElement>(".mobile-edit-bar");
  const editBarTop = editBar ? editBar.getBoundingClientRect().top : Infinity;
  const minTop = vvTop + VIEWPORT_MARGIN;
  const maxBottom = Math.max(minTop + 80, Math.min(vvBottom, editBarTop) - VIEWPORT_MARGIN);
  const maxWidth = vv ? vv.width : window.innerWidth;
  return { minTop, maxBottom, maxWidth };
}

function resolve(
  anchor: AnchorRect,
  size: { width: number; height: number },
  placement: Placement,
  gap: number,
): { left: number; top: number; placement: Placement } {
  const { minTop, maxBottom, maxWidth } = viewportBounds();
  const vertical = placement.startsWith("top") || placement.startsWith("bottom");
  let side = placement.split("-")[0];
  if (vertical) {
    const wantsTop = side === "top";
    const roomBelow = maxBottom - anchor.bottom - gap;
    const roomAbove = anchor.top - gap - minTop;
    // Flip only when the preferred side cannot hold the panel and the other can.
    if (wantsTop && roomAbove < size.height && roomBelow > roomAbove) side = "bottom";
    if (!wantsTop && roomBelow < size.height && roomAbove > roomBelow) side = "top";
  } else {
    const wantsLeft = side === "left";
    const roomRight = maxWidth - anchor.right - gap - VIEWPORT_MARGIN;
    const roomLeft = anchor.left - gap - VIEWPORT_MARGIN;
    if (wantsLeft && roomLeft < size.width && roomRight > roomLeft) side = "right";
    if (!wantsLeft && roomRight < size.width && roomLeft > roomRight) side = "left";
  }

  const alignEnd = placement.endsWith("-end");
  let left = vertical
    ? (alignEnd ? anchor.right - size.width : anchor.left)
    : (side === "left" ? anchor.left - size.width - gap : anchor.right + gap);
  let top = vertical
    ? (side === "top" ? anchor.top - size.height - gap : anchor.bottom + gap)
    : anchor.top;

  left = Math.min(Math.max(VIEWPORT_MARGIN, left), Math.max(VIEWPORT_MARGIN, maxWidth - size.width - VIEWPORT_MARGIN));
  top = Math.min(Math.max(minTop, top), Math.max(minTop, maxBottom - size.height));
  return { left, top, placement: `${side}-${alignEnd ? "end" : "start"}` as Placement };
}

/** Pins a fixed-position floating element to an anchor rectangle, flipping to
 *  the opposite side when the preferred one would run off screen. Re-measures
 *  whenever the panel resizes or the mobile visual viewport changes. */
export function useAnchoredPosition(
  ref: RefObject<HTMLElement | null>,
  anchor: AnchorRect | null,
  placement: Placement = "bottom-start",
  gap = 6,
): { style: CSSProperties; placement: Placement } {
  const [state, setState] = useState<{ left: number; top: number; placement: Placement } | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !anchor) return;
    const measure = () => {
      const size = { width: element.offsetWidth, height: element.offsetHeight };
      if (!size.width || !size.height) return;
      setState((current) => {
        const next = resolve(anchor, size, placement, gap);
        if (current && current.left === next.left && current.top === next.top && current.placement === next.placement) {
          return current;
        }
        return next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", measure);
    vv?.addEventListener("scroll", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      vv?.removeEventListener("resize", measure);
      vv?.removeEventListener("scroll", measure);
    };
  }, [anchor, gap, placement, ref]);

  return {
    style: state
      ? { position: "fixed", left: `${state.left}px`, top: `${state.top}px` }
      : { position: "fixed", left: 0, top: 0, opacity: 0, pointerEvents: "none" },
    placement: state?.placement ?? placement,
  };
}
