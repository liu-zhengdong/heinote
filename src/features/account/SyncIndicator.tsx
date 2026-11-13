import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import "../collaboration/collaboration.css";

/** Quiet non-modal marker for batches still retrying or rebasing after a
 *  recoverable failure. Editing continues underneath; nothing is demanded. */
export function SyncIndicator() {
  const [pending, setPending] = useState(0);
  useEffect(() => {
    const changed = (event: Event) => setPending(Number((event as CustomEvent<{ pending?: number }>).detail?.pending ?? 0));
    window.addEventListener("notes:sync-state", changed);
    return () => window.removeEventListener("notes:sync-state", changed);
  }, []);
  if (!pending) return null;
  return <div className="sync-indicator" role="status" aria-live="polite">
    <RefreshCw size={13} aria-hidden className="sync-indicator__spin" />
    同步中…
  </div>;
}
