import { useEffect, type RefObject } from "react";
import { imeComposing } from "../core/keyboard";

/** Why a popover went: Escape, a press outside it, or a scroll. */
export type DismissReason = "escape" | "outside" | "scroll";

/** Closes a popover on Escape, on a pointer press outside it, and on any scroll
 *  that isn't inside the popover — the three ways Notion's menus go away.
 *
 *  The pointer listener is registered in the capture phase so a click that also
 *  opens another menu closes this one first, and it is armed on the next frame
 *  so the very press that opened the popover cannot immediately close it. */
export function useDismiss(
  active: boolean,
  ref: RefObject<HTMLElement | null>,
  onDismiss: (reason: DismissReason) => void,
  options: { closeOnScroll?: boolean; group?: string } = {},
): void {
  const { closeOnScroll = true, group } = options;
  useEffect(() => {
    if (!active) return;
    let armed = false;
    const frame = requestAnimationFrame(() => { armed = true; });
    const onPointerDown = (event: PointerEvent) => {
      if (!armed) return;
      const target = event.target as Node | null;
      if (target && ref.current?.contains(target)) return;
      // A popover that opens its own sub-popover shares a group with it, so a
      // press inside the child is not a press outside the parent.
      if (group && target instanceof Element && target.closest(`[data-pop-group="${group}"]`)) return;
      onDismiss("outside");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // The Escape that cancels a composition in a field inside is not a close.
      if (event.key !== "Escape" || imeComposing(event)) return;
      event.stopPropagation();
      onDismiss("escape");
    };
    const onScroll = (event: Event) => {
      if (!armed || !closeOnScroll) return;
      const target = event.target as Node | null;
      if (target && ref.current?.contains(target)) return;
      // Scrolling a sub-popover's list (a grid of icons, a long list of
      // options) is not scrolling away from the menu that opened it.
      if (group && target instanceof Element && target.closest(`[data-pop-group="${group}"]`)) return;
      onDismiss("scroll");
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [active, closeOnScroll, group, onDismiss, ref]);
}
