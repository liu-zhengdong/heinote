import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  BlockMutation,
  CollaboratorPresence,
  NotePage,
  PageVersion,
  SpaceRoster,
  SpaceSummary,
  WorkspacePreferences,
} from "../core/types";
import { canDeletePage as canDeletePageIn, canMovePage as canMovePageIn, canOrderPage as canOrderPageIn, canRestorePage as canRestorePageIn, canShelvePage as canShelvePageIn, canTrashPage as canTrashPageIn, inTrash, isPurging, spaceOfPage } from "../core/page-tree";
import {
  WorkspaceHistory,
  type HistoryFocus,
  type HistoryInput,
} from "../core/workspace-history";
import { selectionPoints } from "../features/editor/selection";
import { createPlatformClient, type KnowledgeBaseClient, type PlatformClient } from "../platform/client";
import { WorkspaceDocument, type SyncStatus, type WorkspaceMutation } from "../platform/workspace-document";
import { WorkspaceStateStore, WorkspaceStoreContext } from "./workspace-store";
import { useWindowCommands } from "./window-commands";
import {
  discardTextRedo,
  openWhenDocument,
  pagePresenceAnchor,
  recordTextManaged,
  setTextHistoryView,
  type SemanticLocalOpInput,
} from "../collaboration/client";
import { hasMetadataChange, isStructureChange } from "../collaboration/protocol";
import { pageOfRef, recordValue, recordsOfPath, refKey } from "../platform/records";
import { consumePrefetchedSpaces, request } from "../platform/http";
import { useSession } from "../features/account/AuthGate";
import { firstPageInSpace, navigationSpaceOf } from "../core/space-navigation";
import { readSpaceNavigation, rememberSpacePage } from "./space-navigation-state";
import { useWorkspaceHistory } from "./workspace-history-hook";
import { useWorkspacePageOps, type CreatePageOptions, type MovePageOptions, type PagePatch } from "./workspace-page-ops";
import { useWorkspaceSpaces } from "./workspace-spaces-hook";

export type { CreatePageOptions, MovePageOptions, PagePatch };

/** Stable workspace actions — separated so action-only consumers do not need
 *  to re-render on selection, preference, or roster changes. */
export interface WorkspaceActionsValue {
  switchSpace(spaceId: string): void;
  activateSpace(spaceId: string, options?: { seedPageId?: string }): Promise<void>;
  ensureAllSpaces(): Promise<void>;
  openLocatedPage(wanted: string): Promise<boolean>;
  setSidebarSort(sort: WorkspacePreferences["sidebar_sort"]): Promise<void>;
  refreshSpaces(): Promise<void>;
  knowledgeBases: KnowledgeBaseClient;
  selectPage(pageId: string): void;
  /** Pulls pages' bodies into the window (UC-48). Idempotent; safe to call
   *  from rendering code whenever a page is about to be shown or read. */
  loadPages(pageIds: readonly string[]): void;
  /** Pulls pages' version history and edit events on demand (UC-56). */
  loadHistory(pageIds: readonly string[]): Promise<void>;
  /** ⌘/Ctrl+S: waits on every write so far, then answers where they stand —
   *  "saved" only once the server really has them. */
  saveNow(): Promise<SyncStatus>;
  openGraph(): void;
  closeGraph(): void;
  createPage(parentId?: string | null, kind?: NotePage["kind"], options?: CreatePageOptions): string | null;
  /** Changes some of a page's fields — only those named, however long ago
   *  the caller read the page, so nothing written since is put back. */
  updatePage(pageId: string, patch: PagePatch): void;
  /** Copies a page tree. `toPersonal`: the copy's root lands at the top
   *  level of the member's own space — the sanctioned way content leaves a
   *  shared space or a knowledge base. */
  duplicatePage(pageId: string, options?: { block?: boolean; sameTitle?: boolean; toPersonal?: boolean }): string | null;
  /** Copies a page and its subtree into another document page — or, with
   *  `parentId` null, to the top level of the member's own space. */
  copyPageTo(pageId: string, parentId: string | null): Promise<string | null>;
  /** Moves a page to another folder and/or updates its manual sidebar order. */
  movePage(pageId: string, parentId: string | null, options?: MovePageOptions): void;
  applyBlockMutations(pageId: string, mutations: BlockMutation[]): void;
  /** Writes a change already worked out as writes — the editor's, sent to
   *  the pages holding what it touched. `record: false` keeps it out of undo. */
  commitWrites(mutations: WorkspaceMutation[], record?: boolean): void;
  /** Commits single-page semantic OT ops directly on the active PageSession.
   *  Returns false if no editable collaborative session is open yet. */
  commitPageOps(pageId: string, ops: readonly SemanticLocalOpInput[], options?: { record?: boolean; fold?: boolean }): boolean;
  /** Keeps a checkpoint of the page in its history. False when the page is
   *  too large for one: nothing is kept. */
  checkpointPage(pageId: string, summary: string): boolean;
  /** Archive (shelve) or unarchive a completed project page tree. */
  setPageShelved(pageId: string, shelved: boolean): void;
  /** To the trash. The page's block leaves its parent's body with it and is
   *  kept for a restore. */
  archivePage(pageId: string): void;
  /** Out of the trash, its row back where it was — and open, unless
   *  `select` is false. */
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
  /** The space a page lives in, if it is shared — itself or through a parent. */
  spaceOf(pageId: string): string | undefined;
  /** False for a page in a space where this member can only view. */
  canEdit(pageId: string): boolean;
  /** Whether a page may move under a target (null: the top level; left out:
   *  anywhere) — the one rule behind dragging a page in the list and "Move
   *  to". */
  canMovePage(pageId: string, targetId?: string | null): boolean;
  /** Whether this member may reorder a page among its current siblings. */
  canOrderPage(pageId: string): boolean;
  /** Whether this member may archive (shelve) or unarchive a page (`canShelvePage`). */
  canShelvePage(pageId: string): boolean;
  /** Whether this member may move a page to the trash (`canTrashPage`). */
  canTrashPage(pageId: string): boolean;
  canRestorePage(pageId: string): boolean;
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
  /** Marks the change being made as typing, so a run of it folds into one step. */
  annotateHistory(input: HistoryInput): void;
}

/** What changes rarely — the actions, the selection, the member's spaces
 *  and preferences — so a view reading it is not redrawn by every keystroke.
 *  The pages themselves are read through the workspace store
 *  (`useWorkspaceState`, `usePage`, `usePages`), the save state and who is
 *  here through `useActivity`. */
export interface WorkspaceContextValue extends WorkspaceActionsValue {
  document: WorkspaceDocument | null;
  platform: PlatformClient | null;
  selectedPageId: string;
  loading: boolean;
  directoryLoading: boolean;
  error: string | null;
  preferences: WorkspacePreferences;
  activeSpaceId: string;
  activeSpace: SpaceSummary | null;
  sidebarSort: WorkspacePreferences["sidebar_sort"];
  /** Whether the page pane shows the graph instead of the selected page —
   *  opened there as a note opens there. Choosing a page, even the one that
   *  was open, or making one, puts the page back. */
  graphOpen: boolean;
  /** The spaces this member belongs to, by id: their role in each and what
   *  it lets them do. Kept current by the live membership feed. */
  spaces: Record<string, SpaceSummary>;
  /** Who is in each space and who has been asked in, by space — each kept
   *  current by its own live roster. */
  rosters: Record<string, SpaceRoster>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
const WorkspaceActionsContext = createContext<WorkspaceActionsValue | null>(null);

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

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  /* The views read the workspace from here, each the part it draws; this
     provider subscribes only to low-frequency slices (preferences and the
     selected page's space/existence) so typing never re-renders it. */
  const [store] = useState(() => new WorkspaceStateStore());
  const [document, setDocument] = useState<WorkspaceDocument | null>(null);
  const [platformClient, setPlatform] = useState<PlatformClient | null>(null);
  const sessionUser = useSession().user;
  const platform = useMemo(() => platformClient && sessionUser?.id === platformClient.bootstrap.user.id
    ? { ...platformClient, bootstrap: { ...platformClient.bootstrap, user: { ...platformClient.bootstrap.user, displayName: sessionUser.displayName, avatarUrl: sessionUser.avatarUrl } } }
    : platformClient, [platformClient, sessionUser]);
  const [history] = useState(() => new WorkspaceHistory());
  const [loading, setLoading] = useState(true);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SyncStatus>("saved");
  const [presence, setPresence] = useState<CollaboratorPresence[]>([]);
  const [selectedPageId, setSelectedPageId] = useState("");
  const selectedRef = useRef(selectedPageId);
  const [spaces, setSpaces] = useState<Record<string, SpaceSummary>>({});
  const spacesRef = useRef(spaces);
  const initialSpacesRef = useRef<SpaceSummary[] | undefined>(undefined);
  const initialUrlPage = useRef(typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("page") ?? undefined : undefined).current;
  const setSpaceCatalog = useCallback((list: readonly SpaceSummary[]) => {
    const next = Object.fromEntries(list.map((space) => [space.spaceId, space]));
    spacesRef.current = next;
    setSpaces(next);
  }, []);
  const [emptySpaceId, setEmptySpaceId] = useState("personal");
  const fallbackSpaceId = spaces[emptySpaceId]?.knowledgeBase ? emptySpaceId : "personal";

  /* Subscribe only to the slices WorkspaceProvider itself needs — never the
     full WorkspaceState — so keystrokes do not re-render this provider. */
  const preferences = useSyncExternalStore(store.subscribe, () => store.getState().preferences);
  const selectedSummary = useSyncExternalStore(store.subscribe, () => {
    const current = store.getState();
    const exists = Boolean(selectedPageId && current.pages[selectedPageId]);
    const presenceSpace = exists ? (spaceOfPage(current.pages, selectedPageId) ?? "") : "";
    const activeSpaceKey = exists ? navigationSpaceOf(current.pages, spaces, selectedPageId) : fallbackSpaceId;
    const autoLand = !selectedPageId && activeSpaceKey !== "personal"
      ? (firstPageInSpace(current, spaces, activeSpaceKey, platform ? readSpaceNavigation(platform.bootstrap.user.id).pages[activeSpaceKey] : undefined) || "")
      : "";
    return `${exists ? "1" : "0"}|${presenceSpace}|${activeSpaceKey}|${autoLand}`;
  });
  const [selectedExistsFlag, presenceSpaceRaw, activeSpaceId, autoLandPageId] = selectedSummary.split("|");
  const selectedPageExists = selectedExistsFlag === "1";
  const presenceSpaceId = presenceSpaceRaw || undefined;
  const activeSpace = spaces[activeSpaceId] ?? null;
  const sidebarSort = activeSpace?.knowledgeBase?.sort ?? preferences.sidebar_sort;

  useEffect(() => {
    let active = true;
    let opened: WorkspaceDocument | null = null;
    let unsubscribe = () => {};
    void createPlatformClient(sessionUser)
      .then(async (client) => {
        const remembered = readSpaceNavigation(client.bootstrap.user.id);
        const spacesPromise = consumePrefetchedSpaces<SpaceSummary[]>(client.bootstrap.user.id) ?? client.spaces.installations();
        const locatePromise = initialUrlPage && remembered.pages[remembered.spaceId] !== initialUrlPage
          ? request<{ scope: string; spaceId: string }>(`/api/records/locate?page=${encodeURIComponent(initialUrlPage)}`).catch(() => null)
          : Promise.resolve(null);
        const [initialSpaces, located] = await Promise.all([spacesPromise, locatePromise])
          .catch(async (reason: unknown) => { await client.close(); throw reason; });
        const catalog = Object.fromEntries(initialSpaces.map((space) => [space.spaceId, space]));
        let initialSpaceId = catalog[remembered.spaceId]?.knowledgeBase ? remembered.spaceId : "personal";
        if (located && (located.spaceId === "personal" || catalog[located.spaceId]?.knowledgeBase)) {
          initialSpaceId = located.spaceId;
        }
        const seedPageId = initialUrlPage ?? remembered.pages[initialSpaceId] ?? catalog[initialSpaceId]?.knowledgeBase?.homePageId;
        initialSpacesRef.current = initialSpaces;
        const next = await WorkspaceDocument.open(client, initialSpaces, { activeSpaceId: initialSpaceId, seedPageId })
          .catch(async (reason: unknown) => { await client.close(); throw reason; });
        if (!active) {
          await next.close();
          await client.close();
          return;
        }
        opened = next;
        setPlatform(client);
        setDocument(next);
        setDirectoryLoading(next.directoryLoading);
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
        setSpaceCatalog(initialSpaces);
        setEmptySpaceId(initialSpaceId);
        setSelectedPageId(firstPageInSpace(next.state, catalog, initialSpaceId, initialUrlPage ?? remembered.pages[initialSpaceId]));
        store.set(next.state);
        const stopChanges = next.onChange((nextState) => {
          // Deliberately NOT a transition. An editor keystroke that inserts or
          // splits a block has to be on screen before the next keystroke
          // arrives, or the character lands in the block that is about to be
          // replaced.
          store.set(nextState);
          setDirectoryLoading(next.directoryLoading);
          if (selectedRef.current && isPurging(nextState.pages, selectedRef.current)) {
            setEmptySpaceId(navigationSpaceOf(nextState.pages, spacesRef.current, selectedRef.current));
            setSelectedPageId("");
          }
        });
        unsubscribe = () => {
          stopChanges();
          stopSync();
          window.removeEventListener("pagehide", saveNow);
          window.removeEventListener("beforeunload", onBeforeUnload);
          globalThis.document.removeEventListener("visibilitychange", onVisibility);
        };
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "HeiNote could not open"))
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
    if (!platform || !selectedPageId || !document?.state.pages[selectedPageId] || inTrash(document.state.pages, selectedPageId)) return;
    rememberSpacePage(platform.bootstrap.user.id, activeSpaceId, selectedPageId);
  }, [document, platform, activeSpaceId, selectedPageId]);

  useEffect(() => {
    if (!document || !selectedPageId || !selectedPageExists) return;
    const scope = spaceOfPage(document.state.pages, selectedPageId) ?? "personal";
    void openWhenDocument(scope, selectedPageId).catch(() => undefined);
  }, [document, selectedPageId, selectedPageExists]);

  useEffect(() => {
    if (!platform || !selectedPageId) {
      setPresence([]);
      return;
    }
    const spaceId = presenceSpaceId;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    let selection = spaceId ? selectionPoints() : null;
    let said = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSaid = 0;
    const say = () => {
      timer = null;
      lastSaid = Date.now();
      const anchored = spaceId && selection ? pagePresenceAnchor(spaceId, selectedPageId, selection) : null;
      const nextPresence = anchored?.selection
        ? {
          pageId: selectedPageId,
          status: "editing" as const,
          ...(anchored.epoch !== undefined ? { epoch: anchored.epoch } : {}),
          ...(anchored.seq !== undefined ? { seq: anchored.seq } : {}),
          selection: anchored.selection,
        }
        : { pageId: selectedPageId, status: "viewing" as const };
      const text = JSON.stringify(nextPresence);
      if (text === said) return;
      said = text;
      void platform.presence.set(nextPresence, spaceId).catch(() => undefined);
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
    if (pages[pageId]) {
      setEmptySpaceId(navigationSpaceOf(pages, spacesRef.current, pageId));
      const scope = spaceOfPage(pages, pageId) ?? "personal";
      void openWhenDocument(scope, pageId).catch(() => undefined);
    }
    if (pageId) void document?.loadPages([pageId]).catch(() => undefined);
    setSelectedPageId(pageId);
    setGraphFor(null);
  }, [store, document]);

  const loadPages = useCallback((pageIds: readonly string[]) => {
    void document?.loadPages(pageIds).catch(() => undefined);
  }, [document]);

  const loadHistory = useCallback(async (pageIds: readonly string[]) => {
    if (!document) return;
    await document.loadHistory(pageIds).catch(() => undefined);
  }, [document]);

  const activateSpace = useCallback(async (spaceId: string, options: { seedPageId?: string } = {}) => {
    if (!document) return;
    await document.activateSpace(spaceId, options);
  }, [document]);

  const ensureAllSpaces = useCallback(async () => {
    if (!document) return;
    await document.ensureAllSpaces();
  }, [document]);

  const openLocatedPage = useCallback(async (wanted: string): Promise<boolean> => {
    if (!document || !platform) return false;
    const candidate = wanted.startsWith("#") ? wanted.slice(1) : wanted;
    if (!candidate) return false;
    if (document.state.pages[candidate]) { selectPage(candidate); return true; }
    const located = await request<{ scope: string; spaceId: string }>(
      `/api/records/locate?page=${encodeURIComponent(candidate)}`,
    ).catch(() => null);
    if (!located) return false;
    if (located.spaceId !== "personal" && !spacesRef.current[located.spaceId]?.knowledgeBase) return false;
    setEmptySpaceId(located.spaceId);
    await document.activateSpace(located.spaceId, { seedPageId: candidate });
    if (!document.state.pages[candidate]) return false;
    selectPage(candidate);
    return true;
  }, [document, platform, selectPage]);

  const openGraph = useCallback(() => setGraphFor(selectedRef.current), []);
  const closeGraph = useCallback(() => setGraphFor(null), []);

  /* The open page leaving the workspace — its space left, the member removed
     from it, someone else deleting it — gives way to the member's first page,
     before the empty pane is ever drawn. */
  useLayoutEffect(() => {
    if (!selectedPageId) {
      if (emptySpaceId === "personal" || spaces[emptySpaceId]?.knowledgeBase) return;
    } else if (selectedPageExists) return;
    setEmptySpaceId("personal");
    const remembered = platform ? readSpaceNavigation(platform.bootstrap.user.id) : null;
    setSelectedPageId(firstPageInSpace(store.getState(), spacesRef.current, "personal", remembered?.pages.personal));
  }, [selectedPageId, selectedPageExists, emptySpaceId, spaces, store, platform]);

  useLayoutEffect(() => {
    if (!selectedPageId && autoLandPageId) setSelectedPageId(autoLandPageId);
  }, [selectedPageId, autoLandPageId]);

  useLayoutEffect(() => {
    selectedRef.current = selectedPageId;
  }, [selectedPageId]);

  /* Every write goes through here and into the history — except page-history
     checkpoints, the person's preferences and a permanent delete, which are
     not steps. */
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

  const commitPageOps = useCallback((
    pageId: string,
    ops: readonly SemanticLocalOpInput[],
    options: { record?: boolean; fold?: boolean } = {},
  ): boolean => {
    if (!document || !ops.length) return false;
    setTextHistoryView(selectedRef.current);
    const applied = document.commitPageOps(pageId, ops, options);
    if (applied && options.record !== false) {
      history.discardRedo();
    }
    return applied;
  }, [document, history]);

  const setPreference = useCallback(<K extends keyof WorkspacePreferences>(key: K, value: WorkspacePreferences[K]) => {
    if (!document) return;
    commit([{ type: "set", path: ["preferences", key], value }]);
  }, [commit, document]);

  const pageOps = useWorkspacePageOps({
    document,
    platform,
    activeSpaceId,
    selectedPageId,
    selectedRef,
    spaces,
    spacesRef,
    commit,
    selectPage,
    setSelectedPageId,
    setEmptySpaceId,
  });

  const { rosters, ...spaceOps } = useWorkspaceSpaces({
    document,
    platform,
    spaces,
    spacesRef,
    initialSpacesRef,
    activeSpaceId,
    presenceSpaceId,
    selectedRef,
    setSpaceCatalog,
    setEmptySpaceId,
    selectPage,
    setPreference,
  });

  const historyOps = useWorkspaceHistory({
    document,
    platform,
    history,
    selectedRef,
    setSelectedPageId,
  });

  const spaceOf = useCallback((pageId: string) => spaceOfPage(store.getState().pages, pageId), [store]);

  const canEdit = useCallback((pageId: string) => {
    const spaceId = spaceOfPage(store.getState().pages, pageId);
    return !spaceId || (!spaces[spaceId]?.knowledgeBase?.archived && ["owner", "admin", "editor"].includes(spaces[spaceId]?.role ?? ""));
  }, [spaces, store]);

  const canMovePage = useCallback(
    (pageId: string, targetId?: string | null) => canMovePageIn(store.getState().pages, spaces, pageId, targetId),
    [spaces, store],
  );

  const canOrderPage = useCallback(
    (pageId: string) => canOrderPageIn(store.getState().pages, spaces, pageId),
    [spaces, store],
  );

  const canShelvePage = useCallback(
    (pageId: string) => canShelvePageIn(store.getState().pages, spaces, pageId),
    [spaces, store],
  );

  const canTrashPage = useCallback(
    (pageId: string) => canTrashPageIn(store.getState().pages, spaces, pageId),
    [spaces, store],
  );

  const canRestorePage = useCallback(
    (pageId: string) => canRestorePageIn(store.getState().pages, spaces, pageId),
    [spaces, store],
  );

  const canDeletePage = useCallback((pageId: string) => canDeletePageIn(store.getState().pages, spaces, pageId), [spaces, store]);

  const isFavorite = useCallback((pageId: string) => preferences.favorites.includes(pageId), [preferences.favorites]);

  const toggleFavorite = useCallback((pageId: string) => {
    const current = document?.state.preferences.favorites ?? [];
    setPreference("favorites", current.includes(pageId) ? current.filter((id) => id !== pageId) : [...current, pageId]);
  }, [document, setPreference]);

  const saveNow = useCallback(async (): Promise<SyncStatus> => {
    if (!document) return "saved";
    try { await document.flush(); }
    catch { /* The status itself says what remains: in flight or refused. */ }
    return document.status;
  }, [document]);

  const actions = useMemo<WorkspaceActionsValue>(() => ({
    switchSpace: spaceOps.switchSpace,
    activateSpace,
    ensureAllSpaces,
    openLocatedPage,
    setSidebarSort: spaceOps.setSidebarSort,
    refreshSpaces: spaceOps.refreshSpaces,
    knowledgeBases: spaceOps.knowledgeBases,
    selectPage,
    loadPages,
    loadHistory,
    saveNow,
    openGraph,
    closeGraph,
    createPage: pageOps.createPage,
    updatePage: pageOps.updatePage,
    duplicatePage: pageOps.duplicatePage,
    copyPageTo: pageOps.copyPageTo,
    movePage: pageOps.movePage,
    applyBlockMutations: pageOps.applyBlockMutations,
    commitWrites: commit,
    commitPageOps,
    checkpointPage: pageOps.checkpointPage,
    setPageShelved: pageOps.setPageShelved,
    archivePage: pageOps.archivePage,
    restorePage: pageOps.restorePage,
    deletePage: pageOps.deletePage,
    restoreVersion: pageOps.restoreVersion,
    ensureShareSpace: spaceOps.ensureShareSpace,
    stopSharing: spaceOps.stopSharing,
    leaveShare: spaceOps.leaveShare,
    spaceOf,
    canEdit,
    canMovePage,
    canOrderPage,
    canShelvePage,
    canTrashPage,
    canRestorePage,
    canDeletePage,
    isFavorite,
    toggleFavorite,
    setPreference,
    undo: historyOps.undo,
    redo: historyOps.redo,
    canUndo: historyOps.canUndo,
    canRedo: historyOps.canRedo,
    checkpointHistory: historyOps.checkpointHistory,
    annotateHistory: historyOps.annotateHistory,
  }), [
    spaceOps.switchSpace,
    activateSpace,
    ensureAllSpaces,
    openLocatedPage,
    spaceOps.setSidebarSort,
    spaceOps.refreshSpaces,
    spaceOps.knowledgeBases,
    selectPage,
    loadPages,
    loadHistory,
    saveNow,
    openGraph,
    closeGraph,
    pageOps.createPage,
    pageOps.updatePage,
    pageOps.duplicatePage,
    pageOps.copyPageTo,
    pageOps.movePage,
    pageOps.applyBlockMutations,
    commit,
    commitPageOps,
    pageOps.checkpointPage,
    pageOps.setPageShelved,
    pageOps.archivePage,
    pageOps.restorePage,
    pageOps.deletePage,
    pageOps.restoreVersion,
    spaceOps.ensureShareSpace,
    spaceOps.stopSharing,
    spaceOps.leaveShare,
    spaceOf,
    canEdit,
    canMovePage,
    canOrderPage,
    canShelvePage,
    canTrashPage,
    canRestorePage,
    canDeletePage,
    isFavorite,
    toggleFavorite,
    setPreference,
    historyOps.undo,
    historyOps.redo,
    historyOps.canUndo,
    historyOps.canRedo,
    historyOps.checkpointHistory,
    historyOps.annotateHistory,
  ]);

  const value = useMemo<WorkspaceContextValue>(() => ({
    ...actions,
    document,
    platform,
    selectedPageId,
    loading,
    directoryLoading,
    error,
    preferences,
    activeSpaceId,
    activeSpace,
    sidebarSort,
    graphOpen,
    spaces,
    rosters,
  }), [
    actions,
    document,
    platform,
    selectedPageId,
    loading,
    directoryLoading,
    error,
    preferences,
    activeSpaceId,
    activeSpace,
    sidebarSort,
    graphOpen,
    spaces,
    rosters,
  ]);

  const activity = useMemo<ActivityValue>(() => ({ saveStatus, presence }), [presence, saveStatus]);

  useWindowCommands(document && platform
    ? { workspace: value, document, author: platform.bootstrap.user.displayName, selectedPageId }
    : null);

  return (
    <WorkspaceStoreContext.Provider value={store}>
      <WorkspaceActionsContext.Provider value={actions}>
        <WorkspaceContext.Provider value={value}>
          <ActivityContext.Provider value={activity}>{children}</ActivityContext.Provider>
        </WorkspaceContext.Provider>
      </WorkspaceActionsContext.Provider>
    </WorkspaceStoreContext.Provider>
  );
}

/** Where this window's writes are, and who else is on the page. */
export function useActivity(): ActivityValue {
  return useContext(ActivityContext);
}

/** Stable workspace actions only, decoupled from navigation and roster state. */
export function useWorkspaceActions(): WorkspaceActionsValue {
  const context = useContext(WorkspaceActionsContext);
  if (!context) throw new Error("useWorkspaceActions must be used inside WorkspaceProvider");
  return context;
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
