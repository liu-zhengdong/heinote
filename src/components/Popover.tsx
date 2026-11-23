import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPosition, type AnchorRect, type Placement } from "../hooks/useAnchoredPosition";
import { useDismiss, type DismissReason } from "../hooks/useDismiss";
import { useFold } from "../hooks/useFold";
import { useMountTransition } from "../hooks/useMountTransition";
import { BottomSheet } from "./BottomSheet";

export const POPOVER_EXIT_MS = 110;

/** Every floating surface in HeiNote — menus, the slash list, the format bar, the
 *  icon picker. On desktop it anchors to `anchor` in a body portal; when
 *  `mobileSheet` is enabled on narrow viewports (<560px) it becomes a BottomSheet. */
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
  mobileSheet,
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
  /** Render this menu/panel inside a mobile BottomSheet when <560px. */
  mobileSheet?: boolean | { title?: string };
  children: ReactNode;
}) {
  const mobile = useFold();
  const asSheet = Boolean(mobile && mobileSheet);
  const lastChildrenRef = useRef<ReactNode>(null);
  if (open && children != null) lastChildrenRef.current = children;

  const ref = useRef<HTMLDivElement | null>(null);
  const { mounted, shown } = useMountTransition(open && !asSheet, POPOVER_EXIT_MS);
  const { style, placement: resolved } = useAnchoredPosition(ref, mounted && !asSheet ? anchor : null, placement, gap);
  useDismiss(open && !asSheet, ref, onDismiss, { closeOnScroll, group });

  if (asSheet) {
    const title = typeof mobileSheet === "object" ? mobileSheet.title : undefined;
    return (
      <BottomSheet
        open={open}
        label={label ?? (typeof title === "string" ? title : "菜单")}
        title={title}
        size="auto"
        className={`pop--sheet ${className}`.trim()}
        initialFocus="auto"
        onClose={() => onDismiss("escape")}
      >
        {open ? children : lastChildrenRef.current}
      </BottomSheet>
    );
  }

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
