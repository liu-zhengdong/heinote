import { useEffect, type ReactNode } from "react";
import { imeComposing } from "../core/keyboard";
import { createPortal } from "react-dom";
import { useMountTransition } from "../hooks/useMountTransition";

const EXIT_MS = 150;

/** Centered dialog over a dimmed page. The scrim and the card animate together
 *  so the page never appears to dim before the card has arrived. */
export function Modal({
  open,
  label,
  className = "",
  onClose,
  children,
}: {
  open: boolean;
  label: string;
  className?: string;
  onClose(): void;
  children: ReactNode;
}) {
  const { mounted, shown } = useMountTransition(open, EXIT_MS);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !imeComposing(event)) {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, open]);

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
