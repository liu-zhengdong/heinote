import { useEffect, useRef, type RefObject } from "react";
import { useLayer } from "../components/layer-stack";

/** Why a popover went: Escape, a press outside it, or a scroll. */
export type DismissReason = "escape" | "outside" | "scroll";

/** Closes a popover on Escape (via the unified top-most layer stack), on a
 *  pointer press outside it, and on any scroll that isn't inside the popover. */
export function useDismiss(
  active: boolean,
  ref: RefObject<HTMLElement | null>,
  onDismiss: (reason: DismissReason) => void,
  options: { closeOnScroll?: boolean; group?: string; escape?: boolean } = {},
): void {
  const { closeOnScroll = true, group, escape = true } = options;
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  const { isTop } = useLayer(active, () => dismissRef.current("escape"), { escape, phase: "capture" });

  useEffect(() => {
    if (!active) return;
    let armed = false;
    const frame = requestAnimationFrame(() => { armed = true; });
    const onPointerDown = (event: PointerEvent) => {
      if (!armed) return;
      const target = event.target as Node | null;
      if (target && ref.current?.contains(target)) return;
      if (group && target instanceof Element && target.closest(`[data-pop-group="${group}"]`)) return;
      if (!isTop()) return;
      dismissRef.current("outside");
    };
    const onScroll = (event: Event) => {
      if (!armed || !closeOnScroll) return;
      const target = event.target as Node | null;
      if (target && ref.current?.contains(target)) return;
      if (group && target instanceof Element && target.closest(`[data-pop-group="${group}"]`)) return;
      dismissRef.current("scroll");
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [active, closeOnScroll, group, isTop, ref]);
}
