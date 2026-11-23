import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFold } from "../hooks/useFold";
import { useMountTransition } from "../hooks/useMountTransition";
import { BottomSheet } from "./BottomSheet";
import { useLayer } from "./layer-stack";

const EXIT_MS = 150;

/** Centered dialog over a dimmed page on desktop, or a unified BottomSheet on
 *  narrow viewports unless the dialog owns a full-screen mobile flow. */
export function Modal({
  open,
  label,
  className = "",
  mobilePresentation = "sheet",
  onClose,
  children,
}: {
  open: boolean;
  label: string;
  className?: string;
  mobilePresentation?: "sheet" | "fullscreen";
  onClose(): void;
  children: ReactNode;
}) {
  const mobile = useFold();
  const useSheet = mobile && mobilePresentation === "sheet";
  const { mounted, shown } = useMountTransition(open && !useSheet, EXIT_MS);
  useLayer(open && !useSheet, onClose, { phase: "capture" });

  if (useSheet) {
    const size = className.includes("quickfind") ? "tall" : "auto";
    return (
      <BottomSheet
        open={open}
        label={label}
        size={size}
        className={`overlay__card ${className}`.trim()}
        initialFocus="none"
        onClose={onClose}
      >
        {children}
      </BottomSheet>
    );
  }

  if (!mounted) return null;
  return createPortal(
    <div className={`overlay ${shown ? "is-shown" : ""}`}>
      <div className="overlay__scrim" onPointerDown={onClose} />
      <div
        className={`overlay__card ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
