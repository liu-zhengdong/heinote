import { cloneElement, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPosition, rectOf, type AnchorRect, type Placement } from "../hooks/useAnchoredPosition";
import { useMountTransition } from "../hooks/useMountTransition";

const OPEN_DELAY = 400;

/** Notion labels almost every icon-only control on hover after a short delay.
 *  The delay is the point: it stops the tooltip firing while the pointer is
 *  only passing over a toolbar. */
export function Tooltip({
  label,
  hint,
  placement = "bottom-start",
  children,
}: {
  label: ReactNode;
  hint?: string;
  placement?: Placement;
  children: ReactElement<{
    onPointerEnter?: (event: React.PointerEvent) => void;
    onPointerLeave?: () => void;
    onPointerDown?: () => void;
    onFocus?: (event: React.FocusEvent) => void;
    onBlur?: () => void;
  }>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const timer = useRef(0);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const { shown } = useMountTransition(Boolean(anchor), 0);
  const { style } = useAnchoredPosition(ref, anchor, placement, 6);

  const show = (element: Element) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAnchor(rectOf(element)), OPEN_DELAY);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setAnchor(null);
  };

  return (
    <>
      {cloneElement(children, {
        onPointerEnter: (event: React.PointerEvent) => show(event.currentTarget as Element),
        onPointerLeave: hide,
        // Pressing the control is the answer to "what is this?", and whatever
        // the press opens must not have a tooltip sitting on top of it.
        onPointerDown: hide,
        onFocus: (event: React.FocusEvent) => show(event.currentTarget),
        onBlur: hide,
      })}
      {anchor
        ? createPortal(
            <div ref={ref} className={`tooltip ${shown ? "is-shown" : ""}`} role="tooltip" style={style}>
              <span>{label}</span>
              {hint ? <kbd>{hint}</kbd> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
