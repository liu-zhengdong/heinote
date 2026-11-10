import { createContext, useContext, useRef, useSyncExternalStore } from "react";
import type { NotePage, WorkspaceState } from "../core/types";
import { emptyWorkspace } from "../core/workspace-state";

/* The workspace as the views read it. Each view subscribes to the part of it
   that it draws (`useWorkspaceState`), so a keystroke in one page redraws
   that page — not the page list, the other pages open, every database. The
   workspace context itself carries only what changes rarely: the actions,
   the selection, the member's spaces and preferences. */

export class WorkspaceStateStore {
  private state: WorkspaceState = emptyWorkspace();
  private readonly listeners = new Set<() => void>();

  readonly getState = (): WorkspaceState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  set(state: WorkspaceState): void {
    if (state === this.state) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

export const WorkspaceStoreContext = createContext<WorkspaceStateStore>(new WorkspaceStateStore());

/** The workspace as it is now, for reading outside a render: in an event, a
 *  callback, an effect. A render reads it through `useWorkspaceState`. */
export function useWorkspaceStore(): WorkspaceStateStore {
  return useContext(WorkspaceStoreContext);
}

/** Part of the workspace, redrawn only when that part changes — `isEqual`
 *  says when it has not (`Object.is` unless given). */
export function useWorkspaceState<T>(
  select: (state: WorkspaceState) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const store = useWorkspaceStore();
  const last = useRef<{ state: WorkspaceState; select: (state: WorkspaceState) => T; value: T } | null>(null);
  const read = (): T => {
    const state = store.getState();
    const previous = last.current;
    if (previous && previous.state === state && previous.select === select) return previous.value;
    const next = select(state);
    const value = previous && isEqual(previous.value, next) ? previous.value : next;
    last.current = { state, select, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, read, read);
}

/** Every page — for a view that draws from all of them. */
export function usePages(): Record<string, NotePage> {
  return useWorkspaceState(selectPages);
}
const selectPages = (state: WorkspaceState) => state.pages;

/** One page, redrawn when it changes and not otherwise. */
export function usePage(pageId: string | null | undefined): NotePage | null {
  return useWorkspaceState((state) => (pageId ? state.pages[pageId] ?? null : null));
}

/** Two lists holding the same things in the same order. */
export function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => Object.is(item, right[index]));
}
