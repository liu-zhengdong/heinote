import { useEffect, useMemo, useRef, useState } from "react";
import { AppWindow, Database, Play, Square } from "lucide-react";
import type { NotePage } from "../../core/types";
import { appDocument, hasScript } from "../../core/artifact";
import { AppBridge } from "./bridge";
import { usePages } from "../../app/workspace-store";
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
}

const DB_SCOPE_NOTE = "数据源与应用在同一权限范围内运行。";

export function AppSurface({ page, embedded = false, onOpen, previewSource }: Props) {
  const pages = usePages();
  const enabled = page.app?.enabled ?? "";
  const source = previewSource ?? enabled;
  const scripted = useMemo(() => hasScript(source), [source]);
  const bindings = useMemo(() => page.app?.databases ?? [], [page.app]);
  const boundTitles = useMemo(
    () => bindings.map((binding) => pages[binding.id]?.title || binding.id),
    [bindings, pages],
  );
  const [running, setRunning] = useState(false);
  const [runKey, setRunKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const preview = previewSource !== undefined && previewSource !== null;

  /* Embedded, unscripted HTML renders on sight: it is the note's own
   *  markup, like a card. Anything scripted waits for the member. */
  useEffect(() => {
    if (embedded && source && !scripted && !preview) setRunning(true);
  }, [embedded, source, scripted, preview]);

  const titleOf = (id: string) => pages[id]?.title || undefined;
  const start = () => { setError(null); setRunKey((key) => key + 1); setRunning(true); };
  const stop = () => {
    bridgeRef.current?.detach();
    bridgeRef.current = null;
    setRunning(false);
  };

  const onLoad = (frame: HTMLIFrameElement | null) => {
    if (!frame) return;
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

  const doc = useMemo(() => (source ? appDocument(source) : ""), [source]);

  return (
    <div className={`app-surface${embedded ? " app-surface--embedded" : ""}`}>
      {running && source ? (
        <iframe
          key={runKey}
          ref={onLoad}
          className="app-surface__frame"
          sandbox="allow-scripts"
          srcDoc={doc}
          title={page.title || "小应用"}
        />
      ) : (
        <div className="app-surface__empty">
          <AppWindow size={18} aria-hidden="true" />
          {enabled || previewSource ? "未运行" : "未配置源码"}
        </div>
      )}
      <div className="app-surface__bar">
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
        {preview && <span className="app-surface__tag">预览</span>}
        {error && <span className="app-surface__error">{error}</span>}
        <span className="app-surface__spacer" />
        {running ? (
          <button type="button" className="app-surface__action" onClick={stop}><Square size={12} aria-hidden="true" />停止</button>
        ) : source ? (
          <button type="button" className="app-surface__action app-surface__action--run" onClick={start}><Play size={12} aria-hidden="true" />运行</button>
        ) : null}
      </div>
    </div>
  );
}
