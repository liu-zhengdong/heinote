import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { createId } from "../core/ids";
import { BLOCK_ORDER_STEP, linesFor, newPage, orderedBlocks, pageLine, pageName, relinkContent } from "../core/block-tree";
import { emptyWorkspace } from "../core/workspace-state";
import { newDatabaseConfig } from "../features/database/database-model";
import type {
  BlockMutation,
  BlockTree,
  CollaboratorPresence,
  DatabaseConfig,
  NotePage,
  PageVersion,
  SpaceRoster,
  SpaceSummary,
  WorkspacePreferences,
  WorkspaceState,
} from "../core/types";
import { canDeletePage as canDeletePageIn, canMovePage as canMovePageIn, canTrashPage as canTrashPageIn, descendantPageIds, inTrash, spaceOfPage } from "../core/page-tree";
import { renamedTitle } from "../core/title";
import {
  WorkspaceHistory,
  HistoryConflict,
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
import { databaseRows, rowKey, rowOrderAfter } from "../features/database/database-model";
import { bodyPath, linkIntoParent, trashWrites } from "./page-rows";
import { reidentify } from "../features/editor/editor-commands";
import { selectionPoints } from "../features/editor/selection";
import { createPlatformClient, type KnowledgeBaseClient, type PlatformClient } from "../platform/client";
import { SpaceRosters } from "../platform/rosters";
import { WorkspaceDocument, type SyncStatus, type WorkspaceMutation } from "../platform/workspace-document";
import { WorkspaceStateStore, WorkspaceStoreContext } from "./workspace-store";
import { useWindowCommands } from "./window-commands";
import { discardTextRedo, latestTextHistory, pageBasis, recordTextManaged, replayTextHistory, setTextHistoryView, stopTextHistory } from "../collaboration/client";
import { hasMetadataChange, isStructureChange } from "../collaboration/protocol";
import { publishRecovery } from "../collaboration/recovery";
import { pageOfRef, recordValue, recordsOfPath, refKey } from "../platform/records";
import { withStrictRecordReplay } from "../platform/live";
import { ApiError, request } from "../platform/http";
import { useSession } from "../features/account/AuthGate";
import { firstPageInSpace, navigationSpaceOf } from "../core/space-navigation";
import { readSpaceNavigation, rememberSpacePage } from "./space-navigation-state";
import { collaborationAccount } from "../collaboration/client";

/** What changes rarely — the actions, the selection, the member's spaces
 *  and preferences — so a view reading it is not redrawn by every keystroke.
 *  The pages themselves are read through the workspace store
 *  (`useWorkspaceState`, `usePage`, `usePages`), the save state and who is
 *  here through `useActivity`. */
export interface WorkspaceContextValue {
  document: WorkspaceDocument | null;
  platform: PlatformClient | null;
  selectedPageId: string;
  loading: boolean;
  error: string | null;
  preferences: WorkspacePreferences;
  activeSpaceId: string;
  activeSpace: SpaceSummary | null;
  sidebarSort: WorkspacePreferences["sidebar_sort"];
  switchSpace(spaceId: string): void;
  setSidebarSort(sort: WorkspacePreferences["sidebar_sort"]): Promise<void>;
  refreshSpaces(): Promise<void>;
  knowledgeBases: KnowledgeBaseClient;
  selectPage(pageId: string): void;
  /** Whether the page pane shows the graph instead of the selected page —
   *  opened there as a note opens there. Choosing a page, even the one that
   *  was open, or making one, puts the page back. */
  graphOpen: boolean;
  openGraph(): void;
  closeGraph(): void;
  createPage(parentId?: string | null, kind?: NotePage["kind"], options?: CreatePageOptions): string | null;
  /** Changes some of a page's fields — only those named, however long ago
   *  the caller read the page, so nothing written since is put back. */
  updatePage(pageId: string, patch: PagePatch): void;
  /** Copies a page and everything under it. The copy's row goes right after
   *  the original's in their parent — unless `block` is false, for a caller
   *  (the editor) that places the row itself. `sameTitle` keeps the name as it
   *  is, as a block copied in its page does. */
  duplicatePage(pageId: string, options?: { block?: boolean; sameTitle?: boolean }): string | null;
  /** Moves a page to another folder: every link to it stays where it is. */
  movePage(pageId: string, parentId: string | null): void;
  /** `record: false` keeps a change out of undo — for bookkeeping the
   *  writer did not do themselves, like moving a file into a shared space. */
  applyBlockMutations(pageId: string, mutations: BlockMutation[]): void;
  /** Writes a change already worked out as writes — the editor's, sent to
   *  the pages holding what it touched. `record: false` keeps it out of undo. */
  commitWrites(mutations: WorkspaceMutation[], record?: boolean): void;
  /** Keeps a checkpoint of the page in its history. False when the page is
   *  too large for one: nothing is kept. */
  checkpointPage(pageId: string, summary: string): boolean;
  /** To the trash. The page's block leaves its parent's body with it and is
   *  kept for a restore — or, when the editor is deleting that block itself,
   *  it passes the block to be kept. */
  archivePage(pageId: string): void;
  /** Out of the trash, its row back where it was — and open, unless
   *  `select` is false (an agent's restore leaves the window where it is). */
  restorePage(pageId: string, options?: { select?: boolean }): void;
  deletePage(pageId: string): Promise<void>;
  restoreVersion(pageId: string, version: PageVersion): void;
  /** The space a shared page lives in — its own, or its shared parent's —
   *  created (and the page tree carried into it) the first time. */
  ensureShareSpace(pageId: string): Promise<string>;
  /** Brings a shared page tree back to this member's own pages, and removes
   *  everyone else from its space. The owner's to do. */
  stopSharing(pageId: string): Promise<void>;
  /** Leaves the space a page was shared through; its pages go with it. */
  leaveShare(pageId: string): Promise<void>;
  /** The spaces this member belongs to, by id: their role in each and what
   *  it lets them do. Kept current by Terminus's live membership feed. */
  spaces: Record<string, SpaceSummary>;
  /** Who is in each space and who has been asked in, by space — each kept
   *  current by its own live roster. */
  rosters: Record<string, SpaceRoster>;
  /** The space a page lives in, if it is shared — itself or through a parent. */
  spaceOf(pageId: string): string | undefined;
  /** False for a page in a space where this member can only view. */
  canEdit(pageId: string): boolean;
  /** Whether a page may move under a target (null: the top level; left out:
   *  anywhere) — the one rule behind dragging a page in the list and "Move
   *  to". */
  canMovePage(pageId: string, targetId?: string | null): boolean;
  /** Whether this member may move a page to the trash (`canTrashPage`). */
  canTrashPage(pageId: string): boolean;
  canDeletePage(pageId: string): boolean;
  isFavorite(pageId: string): boolean;
  toggleFavorite(pageId: string): void;
  setPreference<K extends keyof WorkspacePreferences>(key: K, value: WorkspacePreferences[K]): void;
  /** ⌘Z and ⌘⇧Z: take back, or put back, this window's last change, and put
   *  the caret where it was. False when there is nothing to take back. */
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Ends the step in progress, so the editor's next write is a step of its
   *  own; `focus` is where that step leaves the caret. */
  checkpointHistory(focus?: HistoryFocus | null): void;
  /** Corrects what the history could not see for itself about the write just
   *  made: where the caret was before it, or that it was typing. */
  /** Marks the change being made as typing, so a run of it folds into one step. */
  annotateHistory(input: HistoryInput): void;
}

/** The fields of a page a caller may change directly; its body is the
 *  editor's, written block by block. */
export type PagePatch = Partial<Omit<NotePage, "id" | "block_tree" | "created_at" | "created_by" | "updated_at" | "updated_by">>;

export interface CreatePageOptions {
  /** Open the page once it exists. On by default: creating a page is usually
   *  the start of writing in it. An inline database is the exception — it is
   *  made to be drawn where you already are, not to take you somewhere else. */
  select?: boolean;
  /** A database's starting shape, in place of the blank one-table default. */
  database?: DatabaseConfig;
  /** Leave the page's block at the end of its parent's body, as Notion does
   *  for a page made from the sidebar. The editor, which leaves its own block
   *  where the caret is, does not ask. */
  block?: boolean;
  /** Its name from the start — a page made from a mention is named by what
   *  was typed after the `@`. */
  title?: string;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/** What this window is doing now: where its writes are — stored, on their
 *  way, or refused — and who else is on the page. Apart from the rest, as it
 *  changes with every save. */
interface ActivityValue {
  saveStatus: SyncStatus;
  presence: CollaboratorPresence[];
}
const ActivityContext = createContext<ActivityValue>({ saveStatus: "saved", presence: [] });

/** How often a window says where its caret is, at most: ten times a second,
 *  so a caret drawn elsewhere follows typing without a message a key. */
const SELECTION_MS = 100;

/* Presses that end a step of history, beside the key presses and typing the
   provider listens to on its own. */
const PRESS_EVENTS = ["pointerdown", "paste", "cut", "drop", "dragstart"] as const;

/** A copied page's body: every paragraph under a fresh id — so the copy and
 *  the original can be drawn side by side, a block beside its copy — and its
 *  links to the pages copied with it pointing at their copies. */
function remapPageBlocks(tree: BlockTree, copies: ReadonlyMap<string, string>): BlockTree {
  const fresh = reidentify(tree, () => createId("block"));
  return {
    by_id: Object.fromEntries(Object.values(fresh.by_id).map((block) => [block.id, { ...block, content: relinkContent(block.content, copies) }])),
  };
}

function blankPage(id: string, kind: NotePage["kind"], parentId: string | null, author: string): NotePage {
  return {
    ...newPage(id, kind, parentId, { now: new Date().toISOString(), author }, createId("block")),
    // A database starts as Notion's blank one: a table, and every row's name.
    ...(kind === "database" ? { database: newDatabaseConfig("table", createId("view"), () => createId("property")) } : {}),
    // An app starts unconfigured: no source, no bindings.
    ...(kind === "app" ? { app: {} } : {}),
  };
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WorkspaceState>(() => emptyWorkspace());
  /* The views read the workspace from here, each the part it draws; this
     provider keeps its own copy only for the few things it decides itself. */
  const [store] = useState(() => new WorkspaceStateStore());
  const [document, setDocument] = useState<WorkspaceDocument | null>(null);
  const [platformClient, setPlatform] = useState<PlatformClient | null>(null);
  const { user: sessionUser } = useSession();
  // Keep the live client and document. Derive author details from the session.
  const platform = useMemo(() => platformClient && sessionUser?.id === platformClient.bootstrap.user.id
    ? { ...platformClient, bootstrap: { ...platformClient.bootstrap, user: sessionUser } }
    : platformClient, [platformClient, sessionUser]);
  const [selectedPageId, setSelectedPageId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SyncStatus>("saved");
  const [presence, setPresence] = useState<CollaboratorPresence[]>([]);
  /* One history per window, as in Notion's: it holds only what this window
     did, and it lasts as long as the window does. */
  const [history] = useState(() => new WorkspaceHistory());
  const selectedRef = useRef(selectedPageId);
  // A page inside a shared page is as shared as its parent: its presence
  // lives in the same space.
  const presenceSpaceId = spaceOfPage(state.pages, selectedPageId);
  const [spaces, setSpaces] = useState<Record<string, SpaceSummary>>({});
  const spacesRef = useRef(spaces);
  const setSpaceCatalog = useCallback((list: readonly SpaceSummary[]) => {
    const next = Object.fromEntries(list.map((space) => [space.spaceId, space]));
    spacesRef.current = next;
    setSpaces(next);
  }, []);
  const [emptySpaceId, setEmptySpaceId] = useState("personal");
  const fallbackSpaceId = spaces[emptySpaceId]?.knowledgeBase ? emptySpaceId : "personal";
  const activeSpaceId = state.pages[selectedPageId] ? navigationSpaceOf(state.pages, spaces, selectedPageId) : fallbackSpaceId;
  const activeSpace = spaces[activeSpaceId] ?? null;
  const sidebarSort = activeSpace?.knowledgeBase?.sort ?? state.preferences.sidebar_sort;
  const [rosters, setRosters] = useState<Record<string, SpaceRoster>>({});

  useEffect(() => {
    let active = true;
    let opened: WorkspaceDocument | null = null;
    let unsubscribe = () => {};
    void createPlatformClient()
      .then(async (client) => {
        const initialSpaces = await client.spaces.installations().catch(async (reason: unknown) => { await client.close(); throw reason; });
        const next = await WorkspaceDocument.open(client, initialSpaces).catch(async (reason: unknown) => { await client.close(); throw reason; });
        if (!active) {
          await next.close();
          await client.close();
          return;
        }
        opened = next;
        setPlatform(client);
        setDocument(next);
        setState(next.state);
        const stopSync = next.onSyncStatus(setSaveStatus);
        // Hidden or closing, the window saves at once rather than after the
        // usual pause; a tab closed with writes still unsaved asks first.
        const saveNow = () => {
          if (next.unsaved) void next.flush().catch(() => undefined);
        };
        const onVisibility = () => {
          if (globalThis.document.visibilityState === "hidden") saveNow();
        };
        const onBeforeUnload = (event: BeforeUnloadEvent) => {
          if (!next.unsaved) return;
          saveNow();
          event.preventDefault();
        };
        window.addEventListener("pagehide", saveNow);
        window.addEventListener("beforeunload", onBeforeUnload);
        globalThis.document.addEventListener("visibilitychange", onVisibility);
        // The member's first page — or, for someone whose pages are all
        // shared with them, the first of those.
        setSpaceCatalog(initialSpaces);
        const remembered = readSpaceNavigation(client.bootstrap.user.id);
        const catalog = Object.fromEntries(initialSpaces.map((space) => [space.spaceId, space]));
        const initialSpaceId = catalog[remembered.spaceId]?.knowledgeBase ? remembered.spaceId : "personal";
        setEmptySpaceId(initialSpaceId);
        setSelectedPageId(firstPageInSpace(next.state, catalog, initialSpaceId, remembered.pages[initialSpaceId]));
        // The views read it now — after the first page is chosen, so a link
        // to a page in the address, read as the pages arrive, is chosen last.
        store.set(next.state);
        const stopChanges = next.onChange((nextState) => {
          // Deliberately NOT a transition. An editor keystroke that inserts or
          // splits a block has to be on screen before the next keystroke
          // arrives, or the character lands in the block that is about to be
          // replaced.
          store.set(nextState);
          setState(nextState);
        });
        unsubscribe = () => {
          stopChanges();
          stopSync();
          window.removeEventListener("pagehide", saveNow);
          window.removeEventListener("beforeunload", onBeforeUnload);
          globalThis.document.removeEventListener("visibilitychange", onVisibility);
        };
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Notes could not open"))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      if (opened) {
        unsubscribe();
        void opened.close().finally(() => opened?.platform.close());
      }
    };
  }, [store, setSpaceCatalog]);

  useEffect(() => {
    if (!platform || !selectedPageId || !document?.state.pages[selectedPageId] || document.state.pages[selectedPageId].archived) return;
    rememberSpacePage(platform.bootstrap.user.id, activeSpaceId, selectedPageId);
  }, [document, platform, activeSpaceId, selectedPageId]);

  useEffect(() => {
    if (!platform || !selectedPageId) {
      setPresence([]);
      return;
    }
    const spaceId = presenceSpaceId;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    /* The page, and where the caret is in its text and what is selected
       there, which the others on the page are drawn (RemoteCarets): said as
       it changes, at most every SELECTION_MS. Presence is best-effort: the
       space can be left between two looks. */
    let selection = spaceId ? selectionPoints() : null;
    let said = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSaid = 0;
    const say = () => {
      timer = null;
      lastSaid = Date.now();
      const state = selection ? { pageId: selectedPageId, status: "editing" as const, selection } : { pageId: selectedPageId, status: "viewing" as const };
      const text = JSON.stringify(state);
      if (text === said) return;
      said = text;
      void platform.presence.set(state, spaceId).catch(() => undefined);
    };
    const moved = () => {
      selection = selectionPoints();
      if (!timer) timer = setTimeout(say, Math.max(0, lastSaid + SELECTION_MS - Date.now()));
    };
    say();
    if (spaceId) window.document.addEventListener("selectionchange", moved);
    void platform.presence.watch((next) => {
      if (active) setPresence(next);
    }, spaceId).then((stop) => {
      if (active) unsubscribe = stop;
      else stop();
    }).catch(() => {
      if (active) setPresence([]);
    });
    return () => {
      active = false;
      window.document.removeEventListener("selectionchange", moved);
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      void platform.presence.set(null, spaceId).catch(() => undefined);
    };
  }, [platform, presenceSpaceId, selectedPageId]);

  /* The graph in the page pane is open FOR the page that was selected when
     it opened: selecting any page (the same one too) closes it, and so does
     anything else that moves the selection, like a page just made. */
  const [graphFor, setGraphFor] = useState<string | null>(null);
  const graphOpen = graphFor !== null && graphFor === selectedPageId;

  const selectPage = useCallback((pageId: string) => {
    const pages = store.getState().pages;
    if (pages[pageId]) setEmptySpaceId(navigationSpaceOf(pages, spacesRef.current, pageId));
    setSelectedPageId(pageId);
    setGraphFor(null);
  }, [store]);

  const openGraph = useCallback(() => setGraphFor(selectedRef.current), []);
  const closeGraph = useCallback(() => setGraphFor(null), []);

  /* The open page leaving the workspace — its space left, the member removed
     from it, someone else deleting it — gives way to the member's first page,
     before the empty pane is ever drawn. (Deleting it for good here clears
     the selection instead: "No page open".) */
  useLayoutEffect(() => {
    if (!selectedPageId) {
      if (emptySpaceId === "personal" || spaces[emptySpaceId]?.knowledgeBase) return;
    } else if (state.pages[selectedPageId]) return;
    setEmptySpaceId("personal");
    const remembered = platform ? readSpaceNavigation(platform.bootstrap.user.id) : null;
    setSelectedPageId(firstPageInSpace(state, spacesRef.current, "personal", remembered?.pages.personal));
  }, [selectedPageId, emptySpaceId, spaces, state, platform]);

  useLayoutEffect(() => {
    if (selectedPageId || activeSpaceId === "personal" || !platform) return;
    const remembered = readSpaceNavigation(platform.bootstrap.user.id);
    const pageId = firstPageInSpace(state, spacesRef.current, activeSpaceId, remembered.pages[activeSpaceId]);
    if (pageId) setSelectedPageId(pageId);
  }, [selectedPageId, activeSpaceId, platform, state]);

  useLayoutEffect(() => {
    selectedRef.current = selectedPageId;
  }, [selectedPageId]);

  /* Every write goes through here and into the history — except page-history
     checkpoints, the person's preferences and a permanent delete, which are
     not steps. (Nothing an older step would bring back survives a permanent
     delete: a replay only rewrites a path still holding what the step left.) */
  const commit = useCallback((mutations: WorkspaceMutation[], record = true) => {
    if (!document || !mutations.length) return;
    const before = document.state;
    setTextHistoryView(selectedRef.current);
    document.transact(mutations);
    if (record && before !== document.state) {
      history.discardRedo(); discardTextRedo();
      const affected = new Map(mutations.flatMap((mutation) => [...recordsOfPath(before, mutation.path), ...recordsOfPath(document.state, mutation.path)]).map((ref) => [refKey(ref), ref]));
      const unmanaged = [...affected.values()].some((ref) => {
        const pageId = pageOfRef(ref); if (!pageId) return false;
        const scope = spaceOfPage(before.pages, pageId) ?? spaceOfPage(document.state.pages, pageId) ?? "personal";
        return !recordTextManaged(scope, ref.collection, ref.id, recordValue(before, ref) as Record<string, unknown> | undefined, recordValue(document.state, ref) as Record<string, unknown> | undefined);
      });
      const mixed = unmanaged || [...affected.values()].some((ref) => hasMetadataChange(ref.collection, recordValue(before, ref) as Record<string, unknown> | undefined, recordValue(document.state, ref) as Record<string, unknown> | undefined));
      const atomic = [...affected.values()].some((ref) => isStructureChange(ref.collection, recordValue(before, ref) as Record<string, unknown> | undefined, recordValue(document.state, ref) as Record<string, unknown> | undefined));
      history.record(before, document.state, mixed ? mutations : mutations.filter((mutation) => mutation.path[0] !== "pages"), atomic);
    }
  }, [document, history]);

  /* Leaving a page checkpoints it. Without this, page history only ever holds
     renames, and the panel has nothing worth restoring. `checkpointPage`
     discards a snapshot identical to the last one, so simply walking the tree
     records nothing. */
  const previousPageId = useRef("");

  const createPage = useCallback((
    parentId: string | null = null,
    kind: NotePage["kind"] = "document",
    options: CreatePageOptions = {},
  ) => {
    if (!document || !platform) return null;
    parentId ??= spacesRef.current[activeSpaceId]?.knowledgeBase?.homePageId ?? null;
    if (parentId && (!document.state.pages[parentId] || inTrash(document.state.pages, parentId))) return null;
    const scope = parentId ? spaceOfPage(document.state.pages, parentId) : undefined;
    const targetSpace = scope ? spacesRef.current[scope] : undefined;
    if (scope && (!targetSpace || targetSpace.knowledgeBase?.archived || !["owner", "admin", "editor"].includes(targetSpace.role))) return null;
    const id = createId(kind === "database" ? "database" : "page");
    const blank = blankPage(id, kind, parentId, platform.bootstrap.user.displayName);
    const named = options.title ? { ...blank, title: options.title } : blank;
    const page = kind === "database" && options.database ? { ...named, database: options.database } : named;
    const mutations: WorkspaceMutation[] = [{ type: "set", path: ["pages", id], value: page }];
    const parent = parentId ? document.state.pages[parentId] : null;
    if (!parentId) mutations.push({ type: "set", path: ["roots"], value: [...document.state.roots, id] });
    if (options.block) mutations.push(...linkIntoParent(parent, pageLine(createId("block"), id)));
    commit(mutations);
    if (options.select !== false) setSelectedPageId(id);
    return id;
  }, [commit, document, platform, activeSpaceId]);

  const updatePage = useCallback((pageId: string, patch: PagePatch) => {
    if (!document || !platform) return;
    const current = document.state.pages[pageId];
    if (!current) return;
    // A name renamed as plain words — the page list, "Name…", a database's
    // title — keeps its links on the words the rename did not touch.
    const fields: PagePatch = patch.title !== undefined && !("title_content" in patch)
      ? { ...patch, ...renamedTitle(current, patch.title) }
      : patch;
    /* An emoji icon and a picture icon set one another out. Setting `icon`
     *  to anything — emoji or nothing — drops `icon_image`; setting
     *  `icon_image` empties `icon` (a page record keeps it always: "" is its
     *  empty). */
    if ("icon" in fields && !("icon_image" in fields)) fields.icon_image = undefined;
    else if ("icon_image" in fields && !("icon" in fields)) fields.icon = "";
    const mutations: WorkspaceMutation[] = [];
    for (const [key, value] of Object.entries(fields)) {
      if (JSON.stringify(current[key as keyof NotePage]) === JSON.stringify(value)) continue;
      if (value === undefined) mutations.push({ type: "delete", path: ["pages", pageId, key] });
      else mutations.push({ type: "set", path: ["pages", pageId, key], value });
    }
    if (!mutations.length) return;
    commit([
      ...mutations,
      { type: "set", path: ["pages", pageId, "updated_at"], value: new Date().toISOString() },
      { type: "set", path: ["pages", pageId, "updated_by"], value: platform.bootstrap.user.displayName },
    ]);
  }, [commit, document, platform]);

  const duplicatePage = useCallback((pageId: string, options: { block?: boolean; sameTitle?: boolean } = {}) => {
    if (!document || !platform) return null;
    const source = document.state.pages[pageId];
    if (!source) return null;
    const sourceScope = spaceOfPage(document.state.pages, pageId);
    const sourceSpace = sourceScope ? spacesRef.current[sourceScope] : undefined;
    if (sourceSpace?.knowledgeBase && (sourceSpace.knowledgeBase.homePageId === pageId || sourceSpace.knowledgeBase.archived || sourceSpace.role === "viewer")) return null;
    const now = new Date().toISOString();
    const author = platform.bootstrap.user.displayName;
    const idByOriginal = new Map<string, string>([[pageId, createId(source.kind === "database" ? "database" : "page")]]);
    for (const id of descendantPageIds(document.state.pages, pageId)) idByOriginal.set(id, createId("page"));

    const mutations: WorkspaceMutation[] = [];
    for (const [originalId, copyId] of idByOriginal) {
      const original = document.state.pages[originalId];
      if (!original) continue;
      const title = originalId === pageId && !options.sameTitle ? `${pageName(original)} (copy)` : original.title;
      const copy: NotePage = {
        ...structuredClone(original),
        block_tree: remapPageBlocks(structuredClone(original.block_tree), idByOriginal),
        id: copyId,
        // The copy's name keeps the original's links.
        ...renamedTitle(original, title),
        parent_id: original.parent_id && idByOriginal.has(original.parent_id)
          ? idByOriginal.get(original.parent_id)!
          : original.parent_id,
        created_at: now,
        updated_at: now,
        created_by: author,
        updated_by: author,
      };
      delete copy.share_space_id;
      // A row copied with its database keeps its place among the rows; the
      // row copied by itself goes right after the original.
      const database = original.parent_id ? document.state.pages[original.parent_id] : undefined;
      if (database?.kind === "database") {
        copy.row_order = originalId === pageId
          ? rowOrderAfter(databaseRows(document.state.pages, database.id), pageId, Date.now())
          : rowKey(original);
      }
      mutations.push({ type: "set", path: ["pages", copyId], value: copy });
    }

    const rootCopyId = idByOriginal.get(pageId)!;
    // The copy's line goes right after the original's, in their parent.
    const holder = source.parent_id ? document.state.pages[source.parent_id] : undefined;
    const home = options.block !== false && holder?.kind === "document" ? linesFor(holder.block_tree, pageId)[0] : undefined;
    if (holder && home) {
      const siblings = orderedBlocks(holder.block_tree, home.parent_id);
      const next = siblings[siblings.findIndex((block) => block.id === home.id) + 1];
      const blockId = createId("block");
      mutations.push({
        type: "set",
        path: bodyPath(holder.id, blockId),
        value: { ...home, id: blockId, content: relinkContent(home.content, new Map([[pageId, rootCopyId]])), order: next ? (home.order + next.order) / 2 : home.order + BLOCK_ORDER_STEP },
      });
    }
    if (!source.parent_id) {
      const roots = [...document.state.roots];
      roots.splice(roots.indexOf(pageId) + 1, 0, rootCopyId);
      mutations.push({ type: "set", path: ["roots"], value: roots });
    }
    commit(mutations);
    return rootCopyId;
  }, [commit, document, platform]);

  /** Re-parents a page. Refuses to drop a page inside its own subtree, which is
   *  the only move that could orphan a branch. */
  const movePage = useCallback((pageId: string, parentId: string | null) => {
    if (!document) return;
    const page = document.state.pages[pageId];
    if (!page || page.parent_id === parentId || pageId === parentId) return;
    if (!canMovePageIn(document.state.pages, spacesRef.current, pageId, parentId)) return;
    if (parentId && descendantPageIds(document.state.pages, pageId).includes(parentId)) return;
    const mutations: WorkspaceMutation[] = [
      { type: "set", path: ["pages", pageId, "parent_id"], value: parentId },
    ];
    const roots = document.state.roots.filter((id) => id !== pageId);
    mutations.push({ type: "set", path: ["roots"], value: parentId ? roots : [...roots, pageId] });
    const nextParent = parentId ? document.state.pages[parentId] : null;
    // Into a database, it is the newest of its rows.
    if (nextParent?.kind === "database") mutations.push({ type: "set", path: ["pages", pageId, "row_order"], value: Date.now() });
    commit(mutations);
  }, [commit, document]);

  const applyBlockMutations = useCallback((pageId: string, mutations: BlockMutation[]) => {
    if (!document || !platform || !mutations.length) return;
    const now = new Date().toISOString();
    commit([
      ...mutations.map((mutation) => mutation.action === "put" ? {
        type: "set" as const,
        path: ["pages", pageId, "block_tree", "by_id", mutation.block.id],
        value: mutation.block,
      } : {
        type: "delete" as const,
        path: ["pages", pageId, "block_tree", "by_id", mutation.blockId],
      }),
      { type: "set", path: ["pages", pageId, "updated_at"], value: now },
      { type: "set", path: ["pages", pageId, "updated_by"], value: platform.bootstrap.user.displayName },
    ]);
  }, [commit, document, platform]);

  const checkpointPage = useCallback((pageId: string, summary: string) => {
    if (!document || !platform) return true;
    const page = document.state.pages[pageId];
    if (!page) return true;
    // A page this member may only read keeps the history its editors write:
    // a viewer's checkpoint would be turned away by the space.
    const spaceId = spaceOfPage(document.state.pages, pageId);
    if (spaceId && (!spaces[spaceId] || spaces[spaceId].role === "viewer" || spaces[spaceId].knowledgeBase?.archived)) return true;
    void document.afterWrites(() => request(`/api/v1/pages/${encodeURIComponent(pageId)}/checkpoint`, { method: "POST", body: JSON.stringify({ summary }) })).catch((error) => publishRecovery(platform.bootstrap.user.id, { message: error instanceof Error ? error.message : "版本未保存。", writes: [] }));
    return true;
  }, [document, platform, spaces]);

  useEffect(() => {
    const leaving = previousPageId.current;
    previousPageId.current = selectedPageId;
    if (leaving && leaving !== selectedPageId) checkpointPage(leaving, "Edited page");
  }, [checkpointPage, selectedPageId]);

  const archivePage = useCallback((pageId: string) => {
    if (!document) return;
    const page = document.state.pages[pageId];
    if (!page || !canTrashPageIn(document.state.pages, spacesRef.current, pageId)) return;
    const affected = new Set([pageId, ...descendantPageIds(document.state.pages, pageId)]);
    const spaceId = navigationSpaceOf(document.state.pages, spacesRef.current, pageId);
    // Links stay in place and identify the page as being in the trash.
    commit(trashWrites(pageId));
    if (affected.has(selectedRef.current)) {
      setEmptySpaceId(spaceId);
      setSelectedPageId(page.parent_id ?? firstPageInSpace(document.state, spacesRef.current, spaceId));
    }
  }, [commit, document]);

  const restorePage = useCallback((pageId: string, options: { select?: boolean } = {}) => {
    if (!document) return;
    const page = document.state.pages[pageId];
    if (!page) return;
    const scope = spaceOfPage(document.state.pages, pageId);
    const space = scope ? spacesRef.current[scope] : undefined;
    if (scope && (!space || space.role === "viewer" || space.knowledgeBase?.archived)) return;
    if (page.parent_id && inTrash(document.state.pages, page.parent_id)) return;
    const mutations: WorkspaceMutation[] = [
      { type: "delete", path: ["pages", pageId, "archived"] },
      { type: "delete", path: ["pages", pageId, "archived_at"] },
    ];
    const parent = page.parent_id ? document.state.pages[page.parent_id] : undefined;
    // A restored page whose parent is gone comes back at the top level.
    if (page.parent_id && !parent) {
      const home = space?.knowledgeBase?.homePageId ?? null;
      mutations.push({ type: "set", path: ["pages", pageId, "parent_id"], value: home });
      if (!home) mutations.push({ type: "set", path: ["roots"], value: [...document.state.roots.filter((id) => id !== pageId), pageId] });
    }
    commit(mutations);
    if (options.select !== false) selectPage(pageId);
  }, [commit, document, selectPage]);

  /** Permanent removal from the trash: the page, its whole subtree, and any
   *  root reference to them. */
  const deletePage = useCallback(async (pageId: string) => {
    if (!document) return;
    const page = document.state.pages[pageId];
    if (!page) return;
    if (!canDeletePageIn(document.state.pages, spacesRef.current, pageId)) throw new ApiError("当前角色不能永久删除此页面。", 403, "forbidden");
    const navigationSpace = navigationSpaceOf(document.state.pages, spacesRef.current, pageId);
    const ids = [pageId, ...descendantPageIds(document.state.pages, pageId)];
    const removed = new Set(ids);
    const mutations: WorkspaceMutation[] = ids.flatMap((id) => [
      { type: "delete" as const, path: ["pages", id] },
      { type: "delete" as const, path: ["versions", id] },
    ]);
    mutations.push({
      type: "set",
      path: ["roots"],
      value: document.state.roots.filter((id) => !removed.has(id)),
    });
    // Deleting for good is not a step: it cannot be undone.
    commit(mutations, false);
    if (removed.has(selectedRef.current)) setEmptySpaceId(navigationSpace);
    setSelectedPageId((current) => (removed.has(current) ? "" : current));
    await document.flush();
  }, [commit, document]);

  const restoreVersion = useCallback((pageId: string, version: PageVersion) => {
    if (!document || !platform) return;
    void document.afterWrites(async () => {
      const scope = spaceOfPage(document.state.pages, pageId) ?? "personal";
      const basis = pageBasis(scope, pageId);
      await request(`/api/v1/pages/${encodeURIComponent(pageId)}/restore`, { method: "POST", body: JSON.stringify({ versionId: version.id, baseRevision: basis?.revision }) });
    }).catch((error) => publishRecovery(platform.bootstrap.user.id, { message: error instanceof Error ? error.message : "版本未恢复。", writes: [] }));
  }, [document, platform]);

  /* The spaces this member belongs to, kept current by Terminus's live
     membership feed — a page shared with them appears, a space they were
     removed from (or left) goes — and each space's roster by a feed of its
     own, read again only when that space says someone joined, left, was
     moved or was invited. The SDK catches up after a gap in the stream, so
     nothing is read again for a window coming back into focus. */
  useEffect(() => {
    if (!platform || !document) return;
    let active = true;
    let stop: (() => void) | null = null;
    const book = new SpaceRosters(platform.spaces.watchRoster, (next) => {
      if (active) setRosters(next);
    });
    const apply = (list: SpaceSummary[]) => {
      if (!active) return;
      setSpaceCatalog(list);
      book.follow(list.map((space) => space.spaceId));
      // The spaces read, and — moved to Can view — the ones written to no more.
      void document.refreshSpaces(list);
    };
    void platform.spaces.watchInstallations(apply)
      .then((unsubscribe) => {
        if (active) stop = unsubscribe;
        else unsubscribe();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      stop?.();
      book.close();
    };
  }, [document, platform, setSpaceCatalog]);

  const ensureShareSpace = useCallback(async (pageId: string) => {
    if (!document || !platform) throw new Error("Notes is still opening");
    const page = document.state.pages[pageId];
    if (!page) throw new Error("Page no longer exists");
    // Inside a shared tree, a page is shared through its root's space: one
    // page lives in one space.
    const inherited = spaceOfPage(document.state.pages, pageId);
    if (inherited) return inherited;
    const created = await platform.spaces.create(`Notes · ${pageName(page)}`);
    await document.sharePageTree(pageId, created.spaceId);
    // Nothing is read again: the platform tells a space's maker it opened,
    // in every window, so the live list — and the space's roster — follow.
    return created.spaceId;
  }, [document, platform]);

  const stopSharing = useCallback(async (pageId: string) => {
    if (!document || !platform) return;
    const spaceId = document.state.pages[pageId]?.share_space_id;
    if (!spaceId) return;
    if (spacesRef.current[spaceId]?.knowledgeBase) throw new Error("团队知识库不能转换为个人页面。");
    // The server moves the tree and revokes members, invitations and public
    // links in the same transaction. The owner retains access to old files.
    await document.stopSharing(pageId);
  }, [document, platform]);

  const leaveShare = useCallback(async (pageId: string) => {
    if (!document || !platform) return;
    const spaceId = spaceOfPage(document.state.pages, pageId);
    if (!spaceId) return;
    await platform.spaces.leave(spaceId);
    // Its pages go with it; the open one gives way to the member's first page.
    document.removeSpace(spaceId);
  }, [document, platform]);

  /* Asked of the workspace as it is at the moment of asking, so the answers
     keep one identity from one keystroke to the next. */
  const spaceOf = useCallback((pageId: string) => spaceOfPage(store.getState().pages, pageId), [store]);

  const canEdit = useCallback((pageId: string) => {
    const spaceId = spaceOfPage(store.getState().pages, pageId);
    return !spaceId || (!spaces[spaceId]?.knowledgeBase?.archived && ["owner", "admin", "editor"].includes(spaces[spaceId]?.role ?? ""));
  }, [spaces, store]);

  const canMovePage = useCallback(
    (pageId: string, targetId?: string | null) => canMovePageIn(store.getState().pages, spaces, pageId, targetId),
    [spaces, store],
  );

  const canTrashPage = useCallback(
    (pageId: string) => canTrashPageIn(store.getState().pages, spaces, pageId),
    [spaces, store],
  );

  const setPreference = useCallback(<K extends keyof WorkspacePreferences>(key: K, value: WorkspacePreferences[K]) => {
    if (!document) return;
    commit([{ type: "set", path: ["preferences", key], value }]);
  }, [commit, document]);

  const refreshSpaces = useCallback(async () => {
    if (!platform || !document) return;
    const list = await platform.spaces.installations();
    setSpaceCatalog(list);
    await document.refreshSpaces(list);
  }, [document, platform, setSpaceCatalog]);

  const switchSpace = useCallback((spaceId: string) => {
    if (!document || !platform) return;
    const catalog = spacesRef.current;
    if (spaceId !== "personal" && !catalog[spaceId]?.knowledgeBase) return;
    const remembered = readSpaceNavigation(platform.bootstrap.user.id);
    setEmptySpaceId(spaceId);
    selectPage(firstPageInSpace(document.state, catalog, spaceId, remembered.pages[spaceId]));
    if (spaceId !== "personal") void document.addSpace(spaceId);
    setPreference("sidebar_view", "files");
  }, [document, platform, selectPage, setPreference]);

  const unknownRequests = useRef(new Set<string>());
  const knowledgeBases = useMemo<KnowledgeBaseClient>(() => {
    const perform = async (requestId: string, action: () => Promise<SpaceSummary>, waitForWrites = true): Promise<SpaceSummary> => {
      if (!platform || !document) throw new Error("Notes 尚未打开。");
      const work = async () => {
        if (collaborationAccount() !== platform.bootstrap.user.id) throw new Error("账号已改变，请重新打开操作。");
        let result = unknownRequests.current.has(requestId) ? await platform.knowledgeBases.operation(requestId) : undefined;
        if (!result) {
          try { result = await action(); }
          catch (reason) {
            if (reason instanceof ApiError && reason.status < 500) throw reason;
            unknownRequests.current.add(requestId);
            try { result = await platform.knowledgeBases.operation(requestId); } catch { /* Keep the operation id for the next query. */ }
            if (!result) throw new ApiError("操作结果未确认。请保留输入并重试查询。", 503, "result_unknown");
          }
        }
        try { await refreshSpaces(); }
        catch {
          unknownRequests.current.add(requestId);
          throw new ApiError("操作已提交，但空间列表未同步。请重试读取结果。", 503, "result_unknown");
        }
        unknownRequests.current.delete(requestId);
        return result;
      };
      return waitForWrites ? document.afterWrites(work) : work();
    };
    return {
      async create(input) {
        if (!platform) throw new Error("Notes 尚未打开。");
        const result = await perform(input.requestId, () => platform.knowledgeBases.create(input), false);
        switchSpace(result.spaceId);
        return result;
      },
      update: (spaceId, input) => perform(input.requestId, () => {
        if (!platform) throw new Error("Notes 尚未打开。");
        return platform.knowledgeBases.update(spaceId, input);
      }),
      archive: (spaceId, input) => perform(input.requestId, () => {
        if (!platform) throw new Error("Notes 尚未打开。");
        return platform.knowledgeBases.archive(spaceId, input);
      }),
      transfer: (spaceId, input) => perform(input.requestId, () => {
        if (!platform) throw new Error("Notes 尚未打开。");
        return platform.knowledgeBases.transfer(spaceId, input);
      }),
      async operation(requestId) {
        if (!platform) throw new Error("Notes 尚未打开。");
        return platform.knowledgeBases.operation(requestId);
      },
    };
  }, [document, platform, refreshSpaces, switchSpace]);

  const unknownSort = useRef(new Map<string, { requestId: string; revision: number; sort: WorkspacePreferences["sidebar_sort"] }>());
  const setSidebarSort = useCallback(async (sort: WorkspacePreferences["sidebar_sort"]) => {
    const spaceId = activeSpaceId;
    let space = spacesRef.current[spaceId];
    if (!space?.knowledgeBase) { setPreference("sidebar_sort", sort); return; }
    const pending = unknownSort.current.get(spaceId);
    if (pending) {
      try { await knowledgeBases.update(spaceId, pending); }
      catch (reason) {
        if (!(reason instanceof ApiError && reason.code === "result_unknown")) unknownSort.current.delete(spaceId);
        throw reason;
      }
      if (unknownSort.current.get(spaceId) === pending) unknownSort.current.delete(spaceId);
      space = spacesRef.current[spaceId];
    }
    if (!space?.knowledgeBase || space.knowledgeBase.sort === sort) return;
    const input = { requestId: crypto.randomUUID(), revision: space.knowledgeBase.revision, sort };
    try { await knowledgeBases.update(spaceId, input); }
    catch (reason) {
      if (reason instanceof ApiError && reason.code === "result_unknown") unknownSort.current.set(spaceId, input);
      throw reason;
    }
  }, [activeSpaceId, knowledgeBases, setPreference]);

  const canDeletePage = useCallback((pageId: string) => canDeletePageIn(store.getState().pages, spaces, pageId), [spaces, store]);

  const isFavorite = useCallback((pageId: string) => state.preferences.favorites.includes(pageId), [state.preferences.favorites]);

  const toggleFavorite = useCallback((pageId: string) => {
    const current = document?.state.preferences.favorites ?? [];
    setPreference("favorites", current.includes(pageId) ? current.filter((id) => id !== pageId) : [...current, pageId]);
  }, [document, setPreference]);

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
      const openable = (id: string) => Boolean(pages[id] && !pages[id].archived);
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
  }, [document, history, platform]);

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
  }, [history, replayHistory]);

  const undo = useCallback(() => replayHistory("undo"), [replayHistory]);
  const redo = useCallback(() => replayHistory("redo"), [replayHistory]);
  const canUndo = useCallback(() => history.canUndo() || Boolean(latestTextHistory("undo")), [history]);
  const canRedo = useCallback(() => history.canRedo() || Boolean(latestTextHistory("redo")), [history]);
  const checkpointHistory = useCallback((focus?: HistoryFocus | null) => {
    stopTextHistory();
    history.checkpoint(focus === undefined ? undefined : { view: selectedRef.current, focus });
  }, [history]);
  const annotateHistory = useCallback((input: HistoryInput) => history.annotate(input), [history]);

  const value = useMemo<WorkspaceContextValue>(() => ({
    document,
    platform,
    selectedPageId,
    loading,
    error,
    preferences: state.preferences,
    activeSpaceId,
    activeSpace,
    sidebarSort,
    switchSpace,
    setSidebarSort,
    refreshSpaces,
    knowledgeBases,
    selectPage,
    graphOpen,
    openGraph,
    closeGraph,
    createPage,
    updatePage,
    duplicatePage,
    movePage,
    applyBlockMutations,
    commitWrites: commit,
    checkpointPage,
    archivePage,
    restorePage,
    deletePage,
    restoreVersion,
    ensureShareSpace,
    stopSharing,
    leaveShare,
    spaces,
    rosters,
    spaceOf,
    canEdit,
    canMovePage,
    canTrashPage,
    canDeletePage,
    isFavorite,
    toggleFavorite,
    setPreference,
    undo,
    redo,
    canUndo,
    canRedo,
    checkpointHistory,
    annotateHistory,
  }), [
    document,
    platform,
    selectedPageId,
    loading,
    error,
    state.preferences,
    activeSpaceId,
    activeSpace,
    sidebarSort,
    switchSpace,
    setSidebarSort,
    refreshSpaces,
    knowledgeBases,
    selectPage,
    graphOpen,
    openGraph,
    closeGraph,
    createPage,
    updatePage,
    duplicatePage,
    movePage,
    applyBlockMutations,
    commit,
    checkpointPage,
    archivePage,
    restorePage,
    deletePage,
    restoreVersion,
    ensureShareSpace,
    stopSharing,
    leaveShare,
    spaces,
    rosters,
    spaceOf,
    canEdit,
    canMovePage,
    canTrashPage,
    canDeletePage,
    isFavorite,
    toggleFavorite,
    setPreference,
    undo,
    redo,
    canUndo,
    canRedo,
    checkpointHistory,
    annotateHistory,
  ]);

  const activity = useMemo<ActivityValue>(() => ({ saveStatus, presence }), [presence, saveStatus]);

  /* What this window does for people, offered to the agents the person lets
     use Notes (schema.ts's window operations): the Terminus desktop runs them
     here, in the window as it is when the call comes. */
  useWindowCommands(document && platform
    ? { workspace: value, document, author: platform.bootstrap.user.displayName, selectedPageId }
    : null);

  return (
    <WorkspaceStoreContext.Provider value={store}>
      <WorkspaceContext.Provider value={value}>
        <ActivityContext.Provider value={activity}>{children}</ActivityContext.Provider>
      </WorkspaceContext.Provider>
    </WorkspaceStoreContext.Provider>
  );
}

/** Where this window's writes are, and who else is on the page. */
export function useActivity(): ActivityValue {
  return useContext(ActivityContext);
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return context;
}

/* The public reader renders outside any workspace — hooks that only need
 *  preferences fall back to null there. */
export function useWorkspaceOptional(): WorkspaceContextValue | null {
  return useContext(WorkspaceContext);
}
