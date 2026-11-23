import { useEffect, useId, useRef } from "react";
import { imeComposing } from "../core/keyboard";

export type LayerPhase = "capture" | "bubble";

interface LayerEntry {
  id: string;
  phase: LayerPhase;
  escape: boolean;
  dismiss: () => void;
}

const stack: LayerEntry[] = [];
let listening = false;

function topEscapeLayer(): LayerEntry | undefined {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index].escape) return stack[index];
  }
  return undefined;
}

function handleEscape(phase: LayerPhase, event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.defaultPrevented || imeComposing(event)) return;
  if (typeof document !== "undefined" && document.querySelector('[popover="auto"]:popover-open')) return;
  const top = topEscapeLayer();
  if (!top || top.phase !== phase) return;
  event.preventDefault();
  event.stopPropagation();
  top.dismiss();
}

const onCaptureKeyDown = (event: KeyboardEvent) => handleEscape("capture", event);
const onBubbleKeyDown = (event: KeyboardEvent) => handleEscape("bubble", event);

function syncListeners(): void {
  if (stack.length && !listening) {
    window.addEventListener("keydown", onCaptureKeyDown, true);
    window.addEventListener("keydown", onBubbleKeyDown, false);
    listening = true;
  } else if (!stack.length && listening) {
    window.removeEventListener("keydown", onCaptureKeyDown, true);
    window.removeEventListener("keydown", onBubbleKeyDown, false);
    listening = false;
  }
}

export function pushLayer(entry: LayerEntry): () => void {
  const existing = stack.findIndex((item) => item.id === entry.id);
  if (existing >= 0) stack.splice(existing, 1);
  stack.push(entry);
  syncListeners();
  return () => {
    const index = stack.findIndex((item) => item.id === entry.id);
    if (index >= 0) stack.splice(index, 1);
    syncListeners();
  };
}

export function updateLayer(id: string, patch: Partial<Omit<LayerEntry, "id">>): void {
  const found = stack.find((item) => item.id === id);
  if (found) Object.assign(found, patch);
}

export function isTopLayer(id: string): boolean {
  return stack.at(-1)?.id === id;
}

export function clearLayersForTest(): void {
  stack.length = 0;
  syncListeners();
}

/** Registers an active overlay surface in the unified LIFO layer stack so
 *  Escape and outer-dismiss checks always apply strictly to the top-most layer. */
export function useLayer(
  active: boolean,
  onDismiss: () => void,
  options: { escape?: boolean; phase?: LayerPhase } = {},
): { id: string; isTop: () => boolean } {
  const id = useId();
  const { escape = true, phase = "capture" } = options;
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!active) return;
    return pushLayer({
      id,
      phase,
      escape,
      dismiss: () => dismissRef.current(),
    });
  }, [active, id]);

  useEffect(() => {
    if (!active) return;
    updateLayer(id, { phase, escape });
  }, [active, escape, id, phase]);

  return {
    id,
    isTop: () => isTopLayer(id),
  };
}
