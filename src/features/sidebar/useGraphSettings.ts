import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWorkspace } from "../../app/workspace-context";
import type { GraphSettings } from "../../core/types";

/** How long a setting holds still before it is kept. */
const KEEP_AFTER_MS = 400;

/** The graph's settings, changed live and kept a moment later: a slider
 *  dragged or a search typed is drawn at once, and saved — the member's
 *  preference, the same on every device — once it has held still for a
 *  moment, or when the graph closes. Never a save per pixel of a drag. */
export function useGraphSettings(): [GraphSettings, (next: GraphSettings) => void] {
  const { preferences, setPreference } = useWorkspace();
  const [draft, setDraft] = useState<GraphSettings | null>(null);
  const pending = useRef<GraphSettings | null>(null);
  const timer = useRef(0);
  const save = useRef(setPreference);
  useLayoutEffect(() => {
    save.current = setPreference;
  });

  const keep = useCallback(() => {
    window.clearTimeout(timer.current);
    const next = pending.current;
    pending.current = null;
    if (next) save.current("graph", next);
    setDraft(null);
  }, []);

  const change = useCallback((next: GraphSettings) => {
    pending.current = next;
    setDraft(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(keep, KEEP_AFTER_MS);
  }, [keep]);

  // Closed with a change still waiting, it is kept all the same.
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    if (pending.current) save.current("graph", pending.current);
  }, []);

  return [draft ?? preferences.graph, change];
}
