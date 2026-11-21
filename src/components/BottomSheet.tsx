import { Maximize2, Minimize2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMountTransition } from "../hooks/useMountTransition";
import { useLayer, type LayerPhase } from "./layer-stack";
import "./BottomSheet.css";

export type BottomSheetSize = "auto" | "tall" | "staged" | "peek";

const SHEET_EXIT_MS = 200;

function firstFocusable(root: HTMLElement): HTMLElement | null {
  return [...root.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
  )].find((element) => element.tabIndex >= 0 && element.getClientRects().length > 0 && !element.closest("[inert]")) ?? null;
}

/** Unified bottom sheet container for mobile (<560px) drawers, menus, dialogs,
 *  history preview and row details. Self-contained with zero context coupling
 *  so public and auth routes can mount it too. */
export function BottomSheet({
  open,
  label,
  title,
  header,
  headerActions,
  size = "auto",
  className = "",
  scrimLabel,
  escapePhase = "capture",
  initialFocus = "auto",
  restoreFocusTo,
  onClose,
  children,
}: {
  open: boolean;
  label: string;
  title?: ReactNode;
  /** Replaces the default title row when a surface supplies its own bar (e.g. SidePeek). */
  header?: ReactNode;
  headerActions?: ReactNode;
  size?: BottomSheetSize;
  className?: string;
  scrimLabel?: string;
  escapePhase?: LayerPhase;
  initialFocus?: "auto" | "panel" | "none";
  restoreFocusTo?: () => HTMLElement | null;
  onClose(): void;
  children: ReactNode;
}) {
  const { mounted, shown } = useMountTransition(open, SHEET_EXIT_MS);
  const [expanded, setExpanded] = useState(false);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(restoreFocusTo);
  restoreFocusRef.current = restoreFocusTo;

  useLayer(open, onClose, { phase: escapePhase });

  useEffect(() => {
    if (!open) setExpanded(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const sheet = sheetRef.current;
      const fallback = previousFocusRef.current;
      requestAnimationFrame(() => {
        const active = document.activeElement;
        const focusWasInside = Boolean(sheet && active && sheet.contains(active));
        const focusDropped = !active || active === document.body || active === document.documentElement;
        if (!focusWasInside && !focusDropped) return;
        const target = restoreFocusRef.current?.() ?? fallback;
        if (target && target.isConnected && !target.closest("[inert]")) {
          target.focus({ preventScroll: true });
        }
      });
    };
  }, [open]);

  useEffect(() => {
    if (!open || !mounted) return;
    const frame = requestAnimationFrame(() => {
      const sheet = sheetRef.current;
      if (!sheet || initialFocus === "none") return;
      if (sheet.contains(document.activeElement)) return;
      if (initialFocus === "panel") {
        sheet.focus({ preventScroll: true });
        return;
      }
      (firstFocusable(sheet) ?? sheet).focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [initialFocus, mounted, open]);

  if (!mounted) return null;

  const stagedClass = size === "staged" ? (expanded ? "bottom-sheet--expanded" : "bottom-sheet--mid") : "";

  return createPortal(
    <div className={`bottom-sheet-wrap bottom-sheet-wrap--${size} ${shown ? "is-shown" : ""}`}>
      <button
        type="button"
        tabIndex={-1}
        className="bottom-sheet__scrim"
        aria-label={scrimLabel ?? `关闭 ${label} 浮层`}
        onClick={onClose}
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal={size === "peek" ? undefined : true}
        aria-label={label}
        tabIndex={-1}
        className={`bottom-sheet bottom-sheet--${size} ${stagedClass} ${shown ? "is-shown" : ""} ${className}`.trim()}
      >
        <div className="bottom-sheet__handle" aria-hidden="true">
          <span className="bottom-sheet__pill" />
        </div>
        {header !== undefined ? header : (title || headerActions || size === "staged") ? (
          <header className="bottom-sheet__head">
            <span className="bottom-sheet__title">{title}</span>
            <div className="bottom-sheet__head-actions">
              {headerActions}
              {size === "staged" ? (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={expanded ? "恢复半屏" : "展开全屏"}
                  onClick={() => setExpanded((current) => !current)}
                >
                  {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                </button>
              ) : null}
              <button type="button" className="icon-btn" aria-label={`关闭 ${label}`} onClick={onClose}>
                <X size={17} />
              </button>
            </div>
          </header>
        ) : null}
        <div className="bottom-sheet__body scroller">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
