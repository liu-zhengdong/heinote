import { useEffect, useMemo, useRef, useState } from "react";
import { AppWindow, ChevronsDownUp, ChevronsUpDown, Database } from "lucide-react";
import type { NotePage } from "../../core/types";
import { appDocument } from "../../core/artifact";
import { AppBridge } from "./bridge";
import type { AppMsg } from "../../core/artifact";
import { usePages } from "../../app/workspace-store";
import { useWorkspaceOptional } from "../../app/workspace-context";
import "./artifact.css";

/** The host bar under a running app, and the row drawn when it is not.
 *  `embedded` is the expanded link inside a parent page; the app page itself
 *  renders the same surface standalone, with its source and binding
 *  controls beside it (AppPage). */

interface Props {
  page: NotePage;
  /** Embedded in a parent page (the expanded link): chrome is compact and
   *  unscripted HTML runs on sight. */
  embedded?: boolean;
  /** Called when the member asks to open the app's own page. */
  onOpen?: () => void;
  /** Draft source to run instead of the enabled one — the standalone
   *  page's preview, which is read-only. */
  previewSource?: string | null;
  /** Fill the stage instead of a fixed height — the standalone page. */
  grow?: boolean;
  /** A public-reader run: same sandbox, but no bridge — the app's
   *  `window.notes.databases` stays empty and its data calls fail with
   *  `not_ready`. The member paths keep the bridge. */
  anonymous?: boolean;
}

const DB_SCOPE_NOTE = "数据源与应用在同一权限范围内运行。";

/* The resolved theme: "system" follows the desk and re-resolves live, the
 *  same rule ui-context applies to the root attribute. The iframe document
 *  rebuilds on every change, so the app inside re-themes with the shell. */
function useResolvedTheme(): "light" | "dark" {
  const workspace = useWorkspaceOptional();
  const choice = workspace?.preferences.theme ?? "system";
  const pick = (): "light" | "dark" =>
    choice === "light" || choice === "dark"
      ? choice
      : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const [theme, setTheme] = useState<"light" | "dark">(pick);
  useEffect(() => {
    setTheme(pick());
    if (choice !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => setTheme(query.matches ? "dark" : "light");
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice]);
  return theme;
}

export function AppSurface({ page, embedded = false, onOpen, previewSource, grow = false, anonymous = false }: Props) {
  const pages = usePages();
  const enabled = page.app?.enabled ?? "";
  const source = previewSource ?? enabled;
  /* Running is the default for enabled source, scripted or not. */
  const bindings = useMemo(() => page.app?.databases ?? [], [page.app]);
  const boundTitles = useMemo(
    () => bindings.map((binding) => pages[binding.id]?.title || binding.id),
    [bindings, pages],
  );
  /* An enabled app runs on sight; "collapsed" is the member's pause. */
  const [running, setRunning] = useState(true);
  const [runKey, setRunKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const bridgeRef = useRef<AppBridge | null>(null);

  /* A preview (draft) never auto-runs — it is an edit scratch, not the
   *  enabled experience. */
  const preview = previewSource !== undefined && previewSource !== null;
  useEffect(() => {
    if (preview) setRunning(false);
  }, [preview]);

  const titleOf = (id: string) => pages[id]?.title || undefined;
  const start = () => { setError(null); setRunKey((key) => key + 1); setRunning(true); };
  const stop = () => {
    bridgeRef.current?.detach();
    bridgeRef.current = null;
    setRunning(false);
  };

  /* A public run still needs the shim's init so `notes.ready()` resolves —
   *  posted on the frame's load, when its window exists. */
  const onFrameLoad = (frame: HTMLIFrameElement) => {
    frame.contentWindow?.postMessage({ t: "init", instance: `public-${runKey}`, databases: [], public: true } satisfies AppMsg, "*");
  };

  const bindFrame = (frame: HTMLIFrameElement | null) => {
    if (!frame || anonymous) return;
    /* StrictMode mounts the frame twice: the old bridge must go before its
     *  late init can overwrite the shim's instance token. */
    if (bridgeRef.current) {
      bridgeRef.current.detach();
      bridgeRef.current = null;
    }
    const bridge = new AppBridge(page.id, titleOf, preview);
    bridge.attach(frame);
    bridgeRef.current = bridge;
    bridge.start().catch((reason: unknown) => {
      if (bridgeRef.current !== bridge) return;
      setError(reason instanceof Error ? reason.message : "启动失败。");
    });
  };

  const theme = useResolvedTheme();
  const doc = useMemo(() => (source ? appDocument(source, theme) : ""), [source, theme]);

  return (
    <div className={`app-surface${embedded ? " app-surface--embedded" : ""}${grow ? " app-surface--grow" : ""}`}>
      {running && source ? (
        <iframe
          key={runKey}
          ref={bindFrame}
          className="app-surface__frame"
          sandbox="allow-scripts"
          srcDoc={doc}
          title={page.title || "小应用"}
          {...(anonymous ? { onLoad: (event) => onFrameLoad(event.currentTarget) } : {})}
        />
      ) : (
        <div className="app-surface__empty">
          <AppWindow size={18} aria-hidden="true" />
          {source ? (preview ? "未启用 · 预览" : "已收起") : "未配置源码"}
        </div>
      )}
      <div className="app-surface__bar">
        {running && <span className="app-surface__dot" title="运行中" />}
        {/* On its own page the app is already the page; its name and the
         *  bound databases live in the strip below, so the bar only names
         *  itself when it is embedded inside another document. */}
        {embedded && (
          <>
            <AppWindow size={14} aria-hidden="true" />
            <button type="button" className="app-surface__name" onClick={onOpen} title={DB_SCOPE_NOTE}>
              {page.title || "未命名小应用"}
            </button>
            {bindings.length > 0 && (
              <span className="app-surface__dbs" title={`数据源：${boundTitles.join("、")}`}>
                <Database size={12} aria-hidden="true" />
                {boundTitles.join("、")}
              </span>
            )}
          </>
        )}
        {preview && <span className="app-surface__tag">预览</span>}
        {error && <span className="app-surface__error">{error}</span>}
        <span className="app-surface__spacer" />
        {running ? (
          <button type="button" className="app-surface__action" onClick={stop}><ChevronsDownUp size={12} aria-hidden="true" />折叠</button>
        ) : source ? (
          <button type="button" className="app-surface__action app-surface__action--run" onClick={start}><ChevronsUpDown size={12} aria-hidden="true" />展开</button>
        ) : null}
      </div>
    </div>
  );
}
