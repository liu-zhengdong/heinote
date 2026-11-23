import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { flushSync } from "react-dom";
import { inTrash } from "../core/page-tree";
import {
  HistoryConflict,
  WorkspaceHistory,
  historyInputFor,
  type HistoryFocus,
  type HistoryInput,
} from "../core/workspace-history";
import {
  HISTORY_REPLAY_EVENT,
  keepsNativeUndo,
  readHistoryCursor,
  restoreHistoryCursor,
  revealBlocks,
} from "../features/editor/history-cursor";
import { latestTextHistory, replayTextHistory, stopTextHistory } from "../collaboration/client";
import { publishRecovery } from "../collaboration/recovery";
import type { PlatformClient } from "../platform/client";
import { withStrictRecordReplay } from "../platform/live";
import type { WorkspaceDocument, WorkspaceMutation } from "../platform/workspace-document";

/* Presses that end a step of history, beside the key presses and typing the
   provider listens to on its own. */
const PRESS_EVENTS = ["pointerdown", "paste", "cut", "drop", "dragstart"] as const;

export interface WorkspaceHistoryDeps {
  document: WorkspaceDocument | null;
  platform: PlatformClient | null;
  history: WorkspaceHistory;
  selectedRef: MutableRefObject<string>;
  setSelectedPageId: Dispatch<SetStateAction<string>>;
}

export function useWorkspaceHistory({
  document,
  platform,
  history,
  selectedRef,
  setSelectedPageId,
}: WorkspaceHistoryDeps) {
  /* Undo and redo write to the document directly, since a replay is not a
     new step. It happens on the page the change was made on, and the caret
     goes back to where it was — or, for a change made from a menu or a
     handle, the change is brought into view. */
  const replayHistory = useCallback((direction: "undo" | "redo", afterSave = false): boolean => {
    if (!document || !platform) return false;
    history.boundary(readHistoryCursor(selectedRef.current));
    const text = latestTextHistory(direction);
    if (!afterSave && text && text.order > history.lastOrder(direction)) {
      const saved = replayTextHistory(text.pageId, direction);
      if (saved) {
        document.track(saved);
        const view = text.view || text.pageId;
        if (document.state.pages[view] && view !== selectedRef.current) setSelectedPageId(view);
        queueMicrotask(() => window.dispatchEvent(new Event(HISTORY_REPLAY_EVENT)));
        return true;
      }
    }
    if (!afterSave && document.unsaved) {
      void document.afterWrites(async () => { replayHistory(direction, true); }).catch((error) => publishRecovery(platform.bootstrap.user.id, { message: error instanceof Error ? error.message : "结构撤销未保存。", writes: [] }));
      return true;
    }
    let replay;
    try { replay = direction === "undo" ? history.undo(document.state) : history.redo(document.state); }
    catch (error) {
      if (!(error instanceof HistoryConflict)) throw error;
      publishRecovery(platform.bootstrap.user.id, { message: error.message, writes: [...error.changes] });
      return false;
    }
    if (!replay) return false;
    const now = new Date().toISOString();
    const stamps: WorkspaceMutation[] = replay.pageIds.flatMap((pageId) => [
      { type: "set" as const, path: ["pages", pageId, "updated_at"], value: now },
      { type: "set" as const, path: ["pages", pageId, "updated_by"], value: platform.bootstrap.user.displayName },
    ]);
    // A block keeps its own text while it holds the caret (see InlineEditor),
    // so it lets go first and is redrawn from what the replay wrote.
    const active = globalThis.document.activeElement;
    if (active instanceof HTMLElement && active.closest(".block__editable")) active.blur();
    flushSync(() => {
      withStrictRecordReplay(() => document.transact([...replay.mutations, ...stamps]));
      const { pages, roots } = document.state;
      const openable = (id: string) => Boolean(pages[id] && !inTrash(pages, id));
      const view = replay.cursor?.view;
      // Undone on another page, the change is shown there.
      if (view && openable(view)) {
        setSelectedPageId(view);
      } else if (!openable(selectedRef.current)) {
        setSelectedPageId(roots.find(openable) ?? "");
      }
    });
    window.dispatchEvent(new Event(HISTORY_REPLAY_EVENT));
    if (!restoreHistoryCursor(replay.cursor)) revealBlocks(replay.blockIds);
    return true;
  }, [document, history, platform, selectedRef, setSelectedPageId]);

  /* The edges of a step. Anything the person does — a key, a press, a paste,
     a drop — ends the step in progress and starts the next from where the
     caret is now. ⌘Z, ⌘⇧Z (Ctrl+Y) and the browser's own Undo command are
     taken here, ahead of the browser's undo, which knows nothing of the
     document — except in a field whose text is not the document's yet. */
  useEffect(() => {
    const cursor = () => readHistoryCursor(selectedRef.current);
    const onKeyDown = (event: KeyboardEvent) => {
      history.boundary(cursor());
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.altKey || !(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      const direction = key === "z"
        ? (event.shiftKey ? "redo" : "undo")
        : key === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey ? "redo" : null;
      if (!direction || keepsNativeUndo(globalThis.document.activeElement)) return;
      event.preventDefault();
      replayHistory(direction);
    };
    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
        if (keepsNativeUndo(event.target instanceof Element ? event.target : null)) return;
        event.preventDefault();
        replayHistory(event.inputType === "historyUndo" ? "undo" : "redo");
        return;
      }
      history.boundary(cursor(), historyInputFor(event.inputType));
    };
    const onPress = () => history.boundary(cursor());
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("beforeinput", onBeforeInput, true);
    for (const type of PRESS_EVENTS) window.addEventListener(type, onPress, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("beforeinput", onBeforeInput, true);
      for (const type of PRESS_EVENTS) window.removeEventListener(type, onPress, true);
    };
  }, [history, replayHistory, selectedRef]);

  const undo = useCallback(() => replayHistory("undo"), [replayHistory]);
  const redo = useCallback(() => replayHistory("redo"), [replayHistory]);
  const canUndo = useCallback(() => history.canUndo() || Boolean(latestTextHistory("undo")), [history]);
  const canRedo = useCallback(() => history.canRedo() || Boolean(latestTextHistory("redo")), [history]);
  const checkpointHistory = useCallback((focus?: HistoryFocus | null) => {
    stopTextHistory();
    history.checkpoint(focus === undefined ? undefined : { view: selectedRef.current, focus });
  }, [history, selectedRef]);
  const annotateHistory = useCallback((input: HistoryInput) => history.annotate(input), [history]);

  return { undo, redo, canUndo, canRedo, checkpointHistory, annotateHistory };
}
