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
import { ToastStack, type ToastMessage, type ToastTone } from "../components/Toast";
import { useWorkspace } from "./workspace-context";

interface UiContextValue {
  toast(message: string, tone?: ToastTone): void;
  quickFindOpen: boolean;
  setQuickFindOpen(open: boolean): void;
  drawerOpen: boolean;
  setDrawerOpen(open: boolean): void;
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
}

const UiContext = createContext<UiContextValue | null>(null);

/** Applies the member's theme choice to the document element, always as a
 *  concrete value: "system" is resolved here against the media query and
 *  re-resolved when the desk changes underneath it.
 *
 *  Resolving in JavaScript rather than leaving the attribute off is what lets
 *  the stylesheet hold exactly ONE dark block. With the attribute absent, dark
 *  has to be written twice — once behind `prefers-color-scheme` for "system"
 *  and once behind `[data-theme="dark"]` for the explicit choice — and two
 *  copies of eighty values is two copies to keep in step. */
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
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [quickFindOpen, setQuickFindOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sharePageId, setSharePageId] = useState<string | null>(null);
  const [peekPageId, setPeekPageId] = useState<string | null>(null);

  useThemeAttribute(preferences.theme);

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

  const value = useMemo<UiContextValue>(
    () => ({
      toast,
      quickFindOpen,
      setQuickFindOpen,
      drawerOpen,
      setDrawerOpen,
      sharePageId,
      requestShare,
      closeShare,
      peekPageId,
      openPeek,
      closePeek,
    }),
    [closePeek, closeShare, drawerOpen, openPeek, peekPageId, quickFindOpen, requestShare, sharePageId, toast],
  );

  return (
    <UiContext.Provider value={value}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </UiContext.Provider>
  );
}

export function useUi(): UiContextValue {
  const context = useContext(UiContext);
  if (!context) throw new Error("useUi must be used inside UiProvider");
  return context;
}
