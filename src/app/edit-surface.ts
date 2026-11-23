import { useSyncExternalStore } from "react";
import type { ToggleableMark } from "../core/inline-content";
import type { BlockKind, ContentColor } from "../core/types";

export type EditSurfaceMode = "block" | "cell" | "title" | "plain";

export interface ActiveEditSurface {
  surfaceId: string;
  mode: EditSurfaceMode;
  container: "main" | "peek";
  pageId: string;
  blockId?: string | null;
  blockKind?: BlockKind;
  marks?: Partial<Record<ToggleableMark, boolean>>;
  canUndo?: boolean;
  canRedo?: boolean;
  subOverlayOpen?: boolean;
  link?: string;
  color?: ContentColor;
  backgroundColor?: ContentColor;
  cellAlign?: { h?: "left" | "center" | "right"; v?: "top" | "middle" | "bottom" };
  canMergeCell?: boolean;
  canSplitCell?: boolean;
  undo?: () => void;
  redo?: () => void;
  done: () => void;
  toggleMark?: (mark: ToggleableMark) => void;
  turnInto?: (kind: BlockKind) => void;
  insertBlock?: (kind: BlockKind) => void;
  openLink?: () => void;
  setLink?: (href: string | undefined) => void;
  setColor?: (color: ContentColor | undefined, where?: "text" | "background") => void;
  alignCell?: (h?: "left" | "center" | "right", v?: "top" | "middle" | "bottom") => void;
  mergeCell?: () => void;
  splitCell?: () => void;
  setSubOverlayOpen?: (open: boolean) => void;
}

let active: ActiveEditSurface | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

export function registerEditSurface(surface: ActiveEditSurface): void {
  active = surface;
  notify();
}

export function updateEditSurface(surfaceId: string, patch: Partial<ActiveEditSurface>): void {
  if (!active || active.surfaceId !== surfaceId) return;
  active = { ...active, ...patch };
  notify();
}

export function clearEditSurface(surfaceId: string): void {
  if (!active || active.surfaceId !== surfaceId) return;
  active = null;
  notify();
}

export function getActiveEditSurface(): ActiveEditSurface | null {
  return active;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useActiveEditSurface(): ActiveEditSurface | null {
  return useSyncExternalStore(subscribe, getActiveEditSurface, () => null);
}

export function useIsMobileEditing(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => active !== null,
    () => false,
  );
}
