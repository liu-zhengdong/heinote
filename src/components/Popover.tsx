import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPosition, type AnchorRect, type Placement } from "../hooks/useAnchoredPosition";
import { useDismiss, type DismissReason } from "../hooks/useDismiss";
import { useMountTransition } from "../hooks/useMountTransition";

export const POPOVER_EXIT_MS = 110;

/** Every floating surface in Notes — menus, the slash list, the format bar, the
 *  icon picker — is one of these. Portalled to the body so no `overflow` on an
 *  ancestor can clip it, pinned with `position: fixed`, and given the same
 *  short rise-and-fade on the way in and out. */
export function Popover({
  open,
  anchor,
  placement = "bottom-start",
  gap,
  className = "",
  role = "menu",
  label,
  onDismiss,
  closeOnScroll = true,
  group,
  children,
}: {
  open: boolean;
  anchor: AnchorRect | null;
  placement?: Placement;
  gap?: number;
  className?: string;
  role?: string;
  label?: string;
  onDismiss(reason: DismissReason): void;
  closeOnScroll?: boolean;
  /** Popovers sharing a group treat each other as inside, so a submenu does
   *  not dismiss the menu that opened it. */
  group?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { mounted, shown } = useMountTransition(open, POPOVER_EXIT_MS);
  const { style, placement: resolved } = useAnchoredPosition(ref, mounted ? anchor : null, placement, gap);
  useDismiss(open, ref, onDismiss, { closeOnScroll, group });

  if (!mounted || !anchor) return null;
  return createPortal(
    <div
      ref={ref}
      className={`pop ${className} ${shown ? "is-shown" : ""}`}
      data-placement={resolved}
      data-pop-group={group}
      style={style}
      role={role}
      aria-label={label}
    >
      {children}
    </div>,
    document.body,
  );
}
