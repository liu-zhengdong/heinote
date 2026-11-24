import { cloneElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPosition, rectOf, type AnchorRect, type Placement } from "../hooks/useAnchoredPosition";
import { useMountTransition } from "../hooks/useMountTransition";

const OPEN_DELAY = 400;

/** Shared tooltip host for repeated controls (such as editor block rows and
 *  page frames) that declare `data-tooltip` / `data-tooltip-hint` instead of
 *  mounting a separate Tooltip instance per row. */
export function DelegatedTooltip() {
  const ref = useRef<HTMLDivElement | null>(null);
  const timer = useRef(0);
  const activeTarget = useRef<HTMLElement | null>(null);
  const [state, setState] = useState<{ anchor: AnchorRect; label: string; hint?: string; placement: Placement } | null>(null);
  const { shown } = useMountTransition(Boolean(state), 0);
  const { style } = useAnchoredPosition(ref, state?.anchor ?? null, state?.placement ?? "bottom-start", 6);

  useEffect(() => {
    const clear = () => {
      window.clearTimeout(timer.current);
      activeTarget.current = null;
      setState(null);
    };
    const schedule = (target: HTMLElement) => {
      const label = target.dataset.tooltip;
      if (!label) return;
      const hint = target.dataset.tooltipHint || undefined;
      const placement = (target.dataset.tooltipPlacement as Placement | undefined) ?? "bottom-start";
      activeTarget.current = target;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        if (!target.isConnected) return;
        setState({ anchor: rectOf(target), label, hint, placement });
      }, OPEN_DELAY);
    };
    const triggerOf = (node: EventTarget | null): HTMLElement | null => (
      node instanceof Element ? node.closest<HTMLElement>("[data-tooltip]") : null
    );
    const onPointerOver = (event: PointerEvent) => {
      const target = triggerOf(event.target);
      if (!target || target === activeTarget.current) return;
      schedule(target);
    };
    const onPointerOut = (event: PointerEvent) => {
      const target = triggerOf(event.target);
      if (!target || target !== activeTarget.current) return;
      if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
      clear();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = triggerOf(event.target);
      if (!target) return;
      schedule(target);
    };
    const onFocusOut = (event: FocusEvent) => {
      const target = triggerOf(event.target);
      if (!target || target !== activeTarget.current) return;
      if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
      clear();
    };
    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("pointerdown", clear, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    return () => {
      window.clearTimeout(timer.current);
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("pointerdown", clear, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
    };
  }, []);

  if (!state) return null;
  return createPortal(
    <div ref={ref} className={`tooltip ${shown ? "is-shown" : ""}`} role="tooltip" style={style}>
      <span>{state.label}</span>
      {state.hint ? <kbd>{state.hint}</kbd> : null}
    </div>,
    document.body,
  );
}

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
