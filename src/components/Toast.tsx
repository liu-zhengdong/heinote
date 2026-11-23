import { CircleAlert, Check, Info, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMountTransition } from "../hooks/useMountTransition";

export type ToastTone = "info" | "success" | "error";

export interface ToastMessage {
  id: string;
  message: string;
  tone: ToastTone;
}

const VISIBLE_MS = 3600;
const EXIT_MS = 200;

function ToastRow({ toast, onClose }: { toast: ToastMessage; onClose(): void }) {
  const [open, setOpen] = useState(true);
  const { mounted, shown } = useMountTransition(open, EXIT_MS);

  useEffect(() => {
    const hide = window.setTimeout(() => setOpen(false), VISIBLE_MS);
    return () => window.clearTimeout(hide);
  }, []);

  useEffect(() => {
    if (mounted) return;
    onClose();
  }, [mounted, onClose]);

  if (!mounted) return null;
  return (
    <div className={`toast toast--${toast.tone} ${shown ? "is-shown" : ""}`} role="status">
      <span className="toast__icon">
        {toast.tone === "success" ? <Check size={16} /> : toast.tone === "error" ? <CircleAlert size={16} /> : <Info size={16} />}
      </span>
      <span className="toast__message">{toast.message}</span>
      <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Dismiss message">
        <X size={13} />
      </button>
    </div>
  );
}

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastMessage[];
  onDismiss(id: string): void;
}) {
  if (!toasts.length) return null;
  return <>{toasts.map((toast) => (
    <ToastRow key={toast.id} toast={toast} onClose={() => onDismiss(toast.id)} />
  ))}</>;
}

/* The corner's single container: persistent activity pills answer from the
   bottom (the sync indicator, the draft pill) and transient toasts push on
   top of them — one stack, not three elements racing the same fixed point.
   Portal'd once so the order never depends on where siblings mount. */
export function CornerStack({ activity, children }: { activity?: ReactNode; children?: ReactNode }) {
  return createPortal(
    <div className="corner-stack">
      {activity}
      {children}
    </div>,
    document.body,
  );
}
