import { Download, FilePlus2, RefreshCw } from "lucide-react";
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
  const identity = useRef(userId);
  identity.current = userId;

  useEffect(() => {
    const refresh = () => setState({ userId, entries: userId ? getRecovery(userId) : [] });
    setNotice(""); setPrivatePage(null); setDownloaded([]); setBusy(false); refresh();
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ userId?: string }>).detail?.userId === userId) refresh();
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
  if (!userId || !entries.length) return null;
  const preview = previewOf(entries);
  const volatile = entries.some((entry) => !entry.persisted);
  const backedUp = entries.every((entry) => downloaded.includes(entry.id));
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
    if (busy || !preview.length || volatile && !backedUp) return;
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
        setNotice("私人草稿已保存。请先下载新增的恢复草稿，再重新加载。");
      } else window.location.reload();
    } catch (reason) {
      if (identity.current === owner) setNotice(reason instanceof Error ? reason.message : "保存失败，恢复草稿仍保留。");
    } finally { if (identity.current === owner) setBusy(false); }
  };

  return <aside className="save-recovery save-recovery--drafts" role="alert" aria-label="未保存草稿">
    <div className="recovery-head"><strong>有 {entries.length} 份未保存草稿</strong><span>已保留</span></div>
    <p>{entries.at(-1)?.message}</p>
    {volatile ? <p className="recovery-warning">浏览器存储空间不足或不可用。草稿暂存在当前窗口，请立即下载。</p> : null}
    <details className="recovery-preview">
      <summary>查看草稿文字{preview.length ? `（${preview.length} 段）` : ""}</summary>
      <div className="recovery-preview__body">
        {preview.length ? preview.map((item, index) => <label className="recovery-preview__item" key={`${item.label}-${index}`}>
          <span>{item.label}</span><textarea readOnly value={item.text} aria-label={`草稿文字 ${index + 1}`} rows={3} />
        </label>) : <p>没有可显示的文字。下载文件可保留完整修改数据。</p>}
      </div>
    </details>
    {notice ? <p role="status">{notice}</p> : null}
    <div className="recovery-actions">
      <button type="button" className="btn btn--primary" onClick={download}><Download size={14} />下载草稿</button>
      <button type="button" className="btn btn--outline" disabled={busy || !preview.length || Boolean(privatePage) || volatile && !backedUp} title={volatile && !backedUp ? "请先下载完整草稿" : undefined} onClick={() => void savePrivate()}><FilePlus2 size={14} />{busy ? "保存中…" : privatePage ? "已保存私人草稿" : "保存为私人草稿"}</button>
      <button type="button" className="btn" disabled={busy || volatile && !backedUp} title={volatile && !backedUp ? "请先下载草稿" : undefined} onClick={() => window.location.reload()}><RefreshCw size={14} />重新加载</button>
      <button type="button" className="btn" disabled={busy} onClick={() => clearRecovery(userId)}>关闭已处理草稿</button>
    </div>
  </aside>;
}
