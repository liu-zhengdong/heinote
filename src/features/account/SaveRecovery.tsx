import { Download, FilePlus2, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "../../app/workspace-context";
import { addRecovery, clearRecovery, getRecovery, type RecoveryDraft, type RecoveryEntry } from "../../collaboration/recovery";
import { request } from "../../platform/http";
import { useSession } from "./AuthGate";
import "../collaboration/collaboration.css";

type Preview = { label: string; text: string };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function runText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((run) => {
    if (!object(run)) return "";
    const mention = object(run.embed) && object(run.embed.mention) ? run.embed.mention : object(run.mention) ? run.mention : null;
    if (mention) return mention.kind === "date" ? String(mention.date ?? "[日期]") : mention.kind === "image" ? "[图片]" : `[页面：${String(mention.page_id ?? "提及")}]`;
    return typeof run.text === "string" ? run.text : "";
  }).join("");
}
function previewOf(entries: RecoveryEntry[]): Preview[] {
  const items: Preview[] = [];
  const add = (label: string, text: string) => { if (text) items.push({ label, text }); };
  const walk = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!object(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "content" || key === "title_content") add(key === "content" ? "正文" : "页名", runText(item));
      else if ((key === "title" || key === "text") && typeof item === "string") add(key === "title" ? "页名" : "文字", item);
      else if (item && typeof item === "object") walk(item);
    }
  };
  for (const entry of entries) {
    for (const document of entry.documents ?? []) {
      if (!object(document) || !object(document.fields)) continue;
      for (const [key, runs] of Object.entries(document.fields)) {
        add(key.endsWith("/title_content") ? "页名" : key.includes("/cells/") ? "表格单元格" : "正文", runText(runs));
      }
    }
    walk(entry.writes ?? []); walk(entry.batches ?? []);
  }
  return items;
}

export function SaveRecovery() {
  const workspace = useWorkspace();
  const { user } = useSession();
  const platformId = workspace.platform?.bootstrap.user.id;
  // AuthGate already verified the cookie while the workspace is initializing.
  const userId = user?.id && (!platformId || platformId === user.id) ? user.id : null;
  const [state, setState] = useState<{ userId: string | null; entries: RecoveryEntry[] }>({ userId: null, entries: [] });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [privatePage, setPrivatePage] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState<string[]>([]);
  const [deferred, setDeferred] = useState(false);
  const [discardArmed, setDiscardArmed] = useState(false);
  const identity = useRef(userId);
  identity.current = userId;

  useEffect(() => {
    const refresh = () => setState({ userId, entries: userId ? getRecovery(userId) : [] });
    setNotice(""); setPrivatePage(null); setDownloaded([]); setBusy(false);
    setDeferred(false); setDiscardArmed(false); refresh();
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ userId?: string }>).detail?.userId === userId) { refresh(); setDiscardArmed(false); }
    };
    const refused = (event: Event) => {
      if (!userId) return;
      const detail = (event as CustomEvent<RecoveryDraft & { userId?: string }>).detail;
      if (!detail || detail.userId && detail.userId !== userId) return;
      if (typeof detail.message !== "string") return;
      if (!detail.id || !getRecovery(userId).some((entry) => entry.id === detail.id)) addRecovery(userId, detail);
      refresh();
    };
    window.addEventListener("notes:recovery-changed", changed);
    window.addEventListener("notes:save-refused", refused);
    const stored = (event: StorageEvent) => { if (userId && event.key === `notes:recovery:${userId}`) refresh(); };
    window.addEventListener("storage", stored);
    return () => {
      window.removeEventListener("notes:recovery-changed", changed);
      window.removeEventListener("notes:save-refused", refused);
      window.removeEventListener("storage", stored);
    };
  }, [userId, platformId]);

  const entries = state.userId === userId ? state.entries : [];
  const hasEntries = Boolean(userId && entries.length);
  // Escape defers the dialog, same as「稍后处理」. Listeners stay light: only while open.
  useEffect(() => {
    if (!hasEntries || deferred) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setDeferred(true); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [hasEntries, deferred]);

  if (!hasEntries || !userId) return null;
  const preview = previewOf(entries);
  const volatile = entries.some((entry) => !entry.persisted);
  const backedUp = entries.every((entry) => downloaded.includes(entry.id));
  const canDownload = !busy;
  const canSave = !busy && preview.length > 0 && !privatePage && !(volatile && !backedUp);
  const download = () => {
    const payload = {
      version: 1, userId, createdAt: new Date().toISOString(),
      writes: entries.flatMap((entry) => entry.writes ?? []),
      documents: entries.flatMap((entry) => entry.documents ?? []),
      batches: entries.flatMap((entry) => entry.batches ?? []),
      failures: entries,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = "notes-unsaved-draft.json"; link.click();
    setDownloaded(entries.map((entry) => entry.id));
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const savePrivate = async () => {
    if (!canSave) return;
    const owner = userId;
    setBusy(true); setNotice("");
    try {
      const page = await request<{ id: string }>("/api/v1/pages", {
        method: "POST", body: JSON.stringify({ title: "恢复草稿", text: preview.map((item) => `${item.label}\n${item.text}`).join("\n\n") }),
      });
      if (identity.current !== owner) return;
      setPrivatePage(page.id);
      const pending = getRecovery(owner);
      if (pending.some((entry) => !entry.persisted && !downloaded.includes(entry.id))) {
        setNotice("已存为新页面。请先下载新增的恢复草稿，再刷新页面。");
      } else window.location.reload();
    } catch (reason) {
      if (identity.current === owner) setNotice(reason instanceof Error ? reason.message : "保存失败，草稿仍保留。");
    } finally { if (identity.current === owner) setBusy(false); }
  };
  const discard = () => { clearRecovery(userId); setDiscardArmed(false); };

  if (deferred) {
    return <button type="button" className={`save-recovery-pill${volatile ? " save-recovery-pill--urgent" : ""}`} onClick={() => { setDeferred(false); setDiscardArmed(false); }} aria-label="处理未保存草稿">
      <RefreshCw size={15} aria-hidden />
      {entries.length === 1 ? "1 件事待处理" : `${entries.length} 件事待处理`}
    </button>;
  }

  return <div className="save-recovery-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeferred(true); }}>
    <div className="save-recovery" role="alertdialog" aria-modal="true" aria-labelledby="save-recovery-title">
      <h2 id="save-recovery-title">你写的内容已经保留</h2>
      <p className="save-recovery__lead">
        最新输入没能存进页面，已为你完整保留。相关页面已暂停保存，处理完草稿、刷新后即可继续。
        {entries.at(-1)?.message ? <span className="save-recovery__reason">{entries.at(-1)?.message}</span> : null}
      </p>
      <div className="save-recovery__keep" aria-label="保留的内容">
        <div className="save-recovery__keep-label">{preview.length ? `保住了 ${preview.length} 段文字` : "保留了完整修改数据"}</div>
        <div className="save-recovery__keep-items">
          {preview.length ? preview.map((item, index) => <div className="save-recovery__keep-item" key={`${item.label}-${index}`}>
            <div className="save-recovery__keep-page">{item.label}</div>
            <div className="save-recovery__keep-text">{item.text}</div>
          </div>) : <p className="save-recovery__empty">没有可显示的文字。下载文件可保留完整修改数据。</p>}
        </div>
      </div>
      {volatile ? <p className="save-recovery__warning" role="alert">草稿只留在当前窗口（浏览器存储不可用）。请先下载文件。</p> : null}
      {notice ? <p className="save-recovery__notice" role="status">{notice}</p> : null}
      <div className="save-recovery__choices">
        {volatile && !backedUp ? <button type="button" className="save-recovery__choice is-primary" disabled={!canDownload} onClick={download}>
          <Download size={16} aria-hidden />
          <span className="save-recovery__choice-t"><strong>先下载文件</strong><span>草稿只存在当前窗口，下载后才能离开</span></span>
        </button> : <button type="button" className="save-recovery__choice is-primary" disabled={!canSave} title={volatile && !backedUp ? "请先下载文件" : undefined} onClick={() => void savePrivate()}>
          <FilePlus2 size={16} aria-hidden />
          <span className="save-recovery__choice-t"><strong>{busy ? "保存中…" : privatePage ? "已存为新页面" : "存为新页面「恢复草稿」"}</strong><span>推荐：文字直接回到笔记里</span></span>
        </button>}
        {volatile && !backedUp ? null : <button type="button" className="save-recovery__choice" disabled={!canDownload} onClick={download}>
          <Download size={16} aria-hidden />
          <span className="save-recovery__choice-t"><strong>下载为文件</strong><span>保留完整修改数据，含表格与结构</span></span>
        </button>}
        <button type="button" className={`save-recovery__choice${discardArmed ? " is-armed" : ""}`} disabled={busy} onClick={() => { if (discardArmed) discard(); else setDiscardArmed(true); }}>
          <Trash2 size={16} aria-hidden />
          <span className={`save-recovery__choice-t${discardArmed ? " is-danger" : ""}`}><strong>{discardArmed ? "确认丢弃" : "丢弃"}</strong><span>{discardArmed ? "这些草稿将永久删除" : "这些内容不再需要"}</span></span>
        </button>
      </div>
      <div className="save-recovery__foot">
        <p className="save-recovery__hint">现在不想处理？其他页面的编辑不受影响。</p>
        <button type="button" className="btn" onClick={() => setDeferred(true)}>稍后处理</button>
      </div>
    </div>
  </div>;
}
