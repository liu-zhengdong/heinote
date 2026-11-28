import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createId } from "../core/ids";
import { CornerStack, ToastStack, type ToastMessage, type ToastTone } from "../components/Toast";
import type { GithubResult } from "../core/github-auth";
import { SaveRecovery } from "../features/account/SaveRecovery";
import { SyncIndicator } from "../features/account/SyncIndicator";
import { useSession } from "../features/account/AuthGate";
import { useImportJobs, type ImportJobDto } from "../features/account/useImports";
import { useFold } from "../hooks/useFold";
import { useIsMobileEditing } from "./edit-surface";
import { useWorkspace } from "./workspace-context";

export type MemoQuickFilter = "all" | "pinned" | "commented" | "untagged";

export interface MemoJumpTarget {
  memoId: string;
  commentId?: string;
  nonce: number;
}

interface UiContextValue {
  toast(message: string, tone?: ToastTone): void;
  quickFindOpen: boolean;
  setQuickFindOpen(open: boolean): void;
  drawerOpen: boolean;
  setDrawerOpen(open: boolean): void;
  memoQuickFilter: MemoQuickFilter;
  setMemoQuickFilter(filter: MemoQuickFilter): void;
  memoTagFilter: string | null;
  setMemoTagFilter(tag: string | null): void;
  memoTarget: MemoJumpTarget | null;
  openMemo(memoId?: string, commentId?: string): void;
  memoRefreshNonce: number;
  bumpMemoRefresh(): void;
  memoFocusNonce: number;
  focusMemoComposer(): void;
  /** The page whose sharing is open, or null. Keyed by page rather than a
   *  boolean so that opening Share *as part of* a navigation — creating a page
   *  and immediately sharing it — cannot be undone by the navigation. */
  sharePageId: string | null;
  requestShare(pageId: string): void;
  closeShare(): void;
  /** The page open in the side peek, Notion's — a database row opened beside
   *  the page it is in, or a link followed (a block is a page) — or null. One
   *  at a time, for the window. */
  peekPageId: string | null;
  openPeek(pageId: string): void;
  closePeek(): void;
  /** The admin console view. Seamless integrated workspace on desktop, full-screen on mobile. */
  adminOpen: boolean;
  setAdminOpen(open: boolean): void;
  openAdmin(): void;
  closeAdmin(): void;
  /** Whether the page history sheet/panel is open. */
  historyOpen: boolean;
  setHistoryOpen(open: boolean): void;
  /** Account settings dialog state lives at app level so viewport changes across
   *  the 560px breakpoint do not unmount open settings inside Sidebar. */
  accountSettingsOpen: boolean;
  accountSettingsNotice: GithubResult | null;
  openAccountSettings(notice?: GithubResult | null): void;
  closeAccountSettings(): void;
  importJobs: ImportJobDto[];
  selectedImportId: string | null;
  selectImport(id: string | null): void;
  refreshImports(): Promise<void>;
  cancelImportJob(id: string): Promise<void>;
  dismissImportJob(id: string): Promise<void>;
}

const UiContext = createContext<UiContextValue | null>(null);

/** Applies the member's theme choice to the document element, always as a
 *  concrete value: "system" is resolved here against the media query and
 *  re-resolved when the desk changes underneath it. */
function useThemeAttribute(theme: string): void {
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "light" || theme === "dark") {
      root.dataset.theme = theme;
      return;
    }
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { root.dataset.theme = query.matches ? "dark" : "light"; };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [theme]);
}

export function UiProvider({ children }: { children: ReactNode }) {
  const { preferences } = useWorkspace();
  const { user } = useSession();
  const { jobs: importJobs, refresh: refreshImports, cancelJob: cancelImportJob, dismissJob: dismissImportJob } = useImportJobs(Boolean(user));
  const [selectedImportId, setSelectedImportId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [quickFindOpen, setQuickFindOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sharePageId, setSharePageId] = useState<string | null>(null);
  const [peekPageId, setPeekPageId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [accountSettingsNotice, setAccountSettingsNotice] = useState<GithubResult | null>(null);
  const [memoQuickFilter, setMemoQuickFilter] = useState<MemoQuickFilter>("all");
  const [memoTagFilter, setMemoTagFilter] = useState<string | null>(null);
  const [memoTarget, setMemoTarget] = useState<MemoJumpTarget | null>(null);
  const [memoRefreshNonce, setMemoRefreshNonce] = useState(0);
  const [memoFocusNonce, setMemoFocusNonce] = useState(0);
  // `/admin` is a real URL: deep links and reloads land back on the console.
  const [adminOpen, setAdminOpen] = useState(() => window.location.pathname === "/admin");
  const mobile = useFold();
  const mobileEditing = useIsMobileEditing();

  useThemeAttribute(preferences.theme);

  useEffect(() => {
    const root = document.documentElement;
    if (!mobile) {
      root.style.removeProperty("--mobile-bottom-offset");
      return;
    }
    if (mobileEditing) {
      root.style.setProperty("--mobile-bottom-offset", "calc(var(--vv-keyboard, 0px) + 56px)");
      return;
    }
    const overlayActive = drawerOpen || quickFindOpen || Boolean(peekPageId) || historyOpen || Boolean(sharePageId) || adminOpen || accountSettingsOpen;
    root.style.setProperty(
      "--mobile-bottom-offset",
      overlayActive
        ? "calc(max(12px, env(safe-area-inset-bottom, 0px)) + 16px)"
        : "calc(max(12px, env(safe-area-inset-bottom, 0px)) + 68px)",
    );
  }, [accountSettingsOpen, adminOpen, drawerOpen, historyOpen, mobile, mobileEditing, peekPageId, quickFindOpen, sharePageId]);

  const toast = useCallback((message: string, tone: ToastTone = "info") => {
    setToasts((current) => [...current.slice(-2), { id: createId("toast"), message, tone }]);
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const requestShare = useCallback((pageId: string) => setSharePageId(pageId), []);
  const closeShare = useCallback(() => setSharePageId(null), []);
  const openPeek = useCallback((pageId: string) => setPeekPageId(pageId), []);
  const closePeek = useCallback(() => setPeekPageId(null), []);
  const openAccountSettings = useCallback((notice: GithubResult | null = null) => {
    setAccountSettingsNotice(notice);
    setAccountSettingsOpen(true);
  }, []);
  const closeAccountSettings = useCallback(() => {
    setAccountSettingsOpen(false);
    setAccountSettingsNotice(null);
  }, []);
  const openAdmin = useCallback(() => {
    if (window.location.pathname !== "/admin") window.history.pushState(null, "", "/admin");
    setAdminOpen(true);
  }, []);
  const closeAdmin = useCallback(() => {
    // The console opened by pushing /admin, so back returns to the
    // workspace; landing straight on the URL has nothing to go back to.
    if (window.location.pathname === "/admin" && window.history.length > 1) window.history.back();
    else if (window.location.pathname === "/admin") window.history.replaceState(null, "", "/");
    setAdminOpen(false);
  }, []);
  const openMemo = useCallback((memoId?: string, commentId?: string) => {
    setAdminOpen(false);
    setDrawerOpen(false);
    setQuickFindOpen(false);
    if (memoId) {
      setMemoQuickFilter("all");
      setMemoTagFilter(null);
      setMemoTarget((prev) => ({ memoId, ...(commentId ? { commentId } : {}), nonce: (prev?.nonce ?? 0) + 1 }));
    }
  }, []);
  const bumpMemoRefresh = useCallback(() => {
    setMemoRefreshNonce((value) => value + 1);
  }, []);
  const focusMemoComposer = useCallback(() => {
    setMemoFocusNonce((value) => value + 1);
  }, []);
  const selectImport = useCallback((id: string | null) => {
    setSelectedImportId(id);
    if (id) {
      setAdminOpen(false);
      setPeekPageId(null);
      setHistoryOpen(false);
    }
  }, []);

  useEffect(() => {
    if (selectedImportId && !importJobs.some((job) => job.id === selectedImportId)) {
      setSelectedImportId(null);
    }
  }, [importJobs, selectedImportId]);

  const value = useMemo<UiContextValue>(
    () => ({
      toast,
      quickFindOpen,
      setQuickFindOpen,
      drawerOpen,
      setDrawerOpen,
      memoQuickFilter,
      setMemoQuickFilter,
      memoTagFilter,
      setMemoTagFilter,
      memoTarget,
      openMemo,
      memoRefreshNonce,
      bumpMemoRefresh,
      memoFocusNonce,
      focusMemoComposer,
      sharePageId,
      requestShare,
      closeShare,
      peekPageId,
      openPeek,
      closePeek,
      adminOpen,
      setAdminOpen,
      openAdmin,
      closeAdmin,
      historyOpen,
      setHistoryOpen,
      accountSettingsOpen,
      accountSettingsNotice,
      openAccountSettings,
      closeAccountSettings,
      importJobs,
      selectedImportId,
      selectImport,
      refreshImports,
      cancelImportJob,
      dismissImportJob,
    }),
    [accountSettingsNotice, accountSettingsOpen, adminOpen, bumpMemoRefresh, cancelImportJob, closeAccountSettings, closeAdmin, closePeek, closeShare, dismissImportJob, drawerOpen, focusMemoComposer, historyOpen, importJobs, memoFocusNonce, memoQuickFilter, memoRefreshNonce, memoTagFilter, memoTarget, openAccountSettings, openAdmin, openMemo, openPeek, peekPageId, quickFindOpen, refreshImports, requestShare, selectImport, selectedImportId, sharePageId, toast],
  );

  return (
    <UiContext.Provider value={value}>
      {children}
      <CornerStack activity={<><SyncIndicator /><SaveRecovery /></>}>
        <ToastStack toasts={toasts} onDismiss={dismiss} />
      </CornerStack>
    </UiContext.Provider>
  );
}

export function useUi(): UiContextValue {
  const context = useContext(UiContext);
  if (!context) throw new Error("useUi must be used inside UiProvider");
  return context;
}
