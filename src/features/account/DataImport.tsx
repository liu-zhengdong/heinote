import { Check, ChevronRight, FileText, Loader2, Upload, X } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { ZipStream, zipEntries } from "../../core/zip";
import { api } from "./api";

/* 导入向导：Obsidian 库文件夹（浏览器打包 zip）或现成 zip；Notion 收它自己的
   导出 zip。一次 POST 上传，轮询任务到完成。导入落在新的根页面下，不碰现有树。 */

type Source = "obsidian" | "notion";

const OBSIDIAN_PATH = "M19.355 18.538a68.967 68.959 0 0 0 1.858-2.954.81.81 0 0 0-.062-.9c-.516-.685-1.504-2.075-2.042-3.362-.553-1.321-.636-3.375-.64-4.377a1.707 1.707 0 0 0-.358-1.05l-3.198-4.064a3.744 3.744 0 0 1-.076.543c-.106.503-.307 1.004-.536 1.5-.134.29-.29.6-.446.914l-.31.626c-.516 1.068-.997 2.227-1.132 3.59-.124 1.26.046 2.73.815 4.481.128.011.257.025.386.044a6.363 6.363 0 0 1 3.326 1.505c.916.79 1.744 1.922 2.415 3.5zM8.199 22.569c.073.012.146.02.22.02.78.024 2.095.092 3.16.29.87.16 2.593.64 4.01 1.055 1.083.316 2.198-.548 2.355-1.664.114-.814.33-1.735.725-2.58l-.01.005c-.67-1.87-1.522-3.078-2.416-3.849a5.295 5.295 0 0 0-2.778-1.257c-1.54-.216-2.952.19-3.84.45.532 2.218.368 4.829-1.425 7.531zM5.533 9.938c-.023.1-.056.197-.098.29L2.82 16.059a1.602 1.602 0 0 0 .313 1.772l4.116 4.24c2.103-3.101 1.796-6.02.836-8.3-.728-1.73-1.832-3.081-2.55-3.831zM9.32 14.01c.615-.183 1.606-.465 2.745-.534-.683-1.725-.848-3.233-.716-4.577.154-1.552.7-2.847 1.235-3.95.113-.235.223-.454.328-.664.149-.297.288-.577.419-.86.217-.47.379-.885.46-1.27.08-.38.08-.72-.014-1.043-.095-.325-.297-.675-.68-1.06a1.6 1.6 0 0 0-1.475.36l-4.95 4.452a1.602 1.602 0 0 0-.513.952l-.427 2.83c.672.59 2.328 2.316 3.335 4.711.09.21.175.43.253.653z";
const NOTION_PATH = "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z";

const Brand = ({ source }: { source: Source }) => (
  <span className={`settings-row__icon ico-brand ico-brand--${source}`} aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="currentColor"><path d={source === "obsidian" ? OBSIDIAN_PATH : NOTION_PATH} /></svg>
  </span>
);

interface ImportReport {
  rootPageId: string;
  title: string;
  pages: number;
  attachments: number;
  links: number;
  unresolved: string[];
  warnings: string[];
}
interface Job {
  id: string;
  status: string;
  phase: string;
  done: number;
  total: number;
  result?: ImportReport;
  error?: string;
}

type Stage =
  | { kind: "pick" }
  | { kind: "scanning" }
  | { kind: "confirm"; label: string; detail: string; warn: string | null; zip: File | Blob }
  | { kind: "uploading"; detail: string }
  | { kind: "running"; job: Job }
  | { kind: "done"; report: ImportReport }
  | { kind: "failed"; message: string };

const SOURCE_LABEL: Record<Source, string> = { obsidian: "Obsidian", notion: "Notion" };

function Wizard({ source, onClose, onOpenPage, onBusyChange }: {
  source: Source;
  onClose(): void;
  onOpenPage?(pageId: string): void;
  onBusyChange(busy: boolean): void;
}) {
  const [stage, setStage] = useState<Stage>({ kind: "pick" });
  const [drag, setDrag] = useState(false);
  const folderRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const poll = useRef<number>(0);

  const busy = stage.kind === "uploading" || stage.kind === "running" || stage.kind === "scanning";

  const watch = useCallback((id: string) => {
    window.clearInterval(poll.current);
    poll.current = window.setInterval(async () => {
      try {
        const job = await api<Job>(`/api/account/import/${id}`);
        if (job.status === "done") {
          window.clearInterval(poll.current);
          setStage({ kind: "done", report: job.result! });
          onBusyChange(false);
        } else if (job.status === "failed") {
          window.clearInterval(poll.current);
          setStage({ kind: "failed", message: job.error ?? "导入失败。" });
          onBusyChange(false);
        } else {
          setStage({ kind: "running", job });
        }
      } catch { /* poll again */ }
    }, 700);
  }, [onBusyChange]);

  /** Folder picked → bundle it as a STORE zip in memory, then confirm. */
  const bundleFolder = useCallback(async (files: FileList) => {
    setStage({ kind: "scanning" });
    const list = [...files].filter((file) => !file.name.startsWith(".") || (file.webkitRelativePath || file.name).includes("/.obsidian/"));
    const notes = list.filter((file) => file.name.toLowerCase().endsWith(".md"));
    if (!notes.length) {
      setStage({ kind: "failed", message: "这个文件夹里没有 Markdown 笔记。" });
      return;
    }
    const vault = list.some((file) => (file.webkitRelativePath || file.name).includes("/.obsidian/"));
    const root = list[0]?.webkitRelativePath.split("/")[0] || "库";
    const chunks: Uint8Array[] = [];
    const zip = new ZipStream({ write: (chunk) => chunks.push(chunk) });
    for (const file of list) await zip.add(file.webkitRelativePath || file.name, new Uint8Array(await file.arrayBuffer()));
    zip.finish();
    const blob = new Blob(chunks.map((chunk) => chunk.buffer as ArrayBuffer), { type: "application/zip" });
    setStage({
      kind: "confirm",
      label: `${root}/`,
      detail: `${notes.length} 篇笔记 · ${list.length} 个文件 · ${(blob.size / 1048576).toFixed(1)} MB`,
      warn: vault ? null : "没找到 .obsidian 目录：将按普通 Markdown 文件夹导入，库名取文件夹名。",
      zip: blob,
    });
  }, []);

  /** Zip picked → list its entries for the confirm card. */
  const inspectZip = useCallback(async (file: File) => {
    setStage({ kind: "scanning" });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const entries = zipEntries(bytes);
      const notes = entries.filter((entry) => entry.name.toLowerCase().endsWith(".md")).length;
      if (!notes) throw new Error("zip 里没有 Markdown 笔记。");
      setStage({
        kind: "confirm",
        label: file.name,
        detail: `${notes} 篇笔记 · ${entries.length} 个文件 · ${(file.size / 1048576).toFixed(1)} MB`,
        warn: source === "obsidian" && !entries.some((entry) => entry.name.includes("/.obsidian/") || entry.name.startsWith(".obsidian/"))
          ? "没找到 .obsidian 目录：将按普通 Markdown 文件夹导入。" : null,
        zip: file,
      });
    } catch (error) {
      setStage({ kind: "failed", message: error instanceof Error ? error.message : "无法读取这个 zip。" });
    }
  }, [source]);

  const pickZip = useCallback((files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (file.name.toLowerCase().endsWith(".zip")) void inspectZip(file);
    else setStage({ kind: "failed", message: "请选择 .zip 文件。" });
  }, [inspectZip]);

  const upload = useCallback(async (zip: File | Blob) => {
    setStage({ kind: "uploading", detail: "上传中…" });
    onBusyChange(true);
    try {
      const started = await api<{ id: string }>(`/api/account/import/${source}`, {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: zip,
      });
      setStage({ kind: "running", job: { id: started.id, status: "queued", phase: "排队中…", done: 0, total: 1 } });
      watch(started.id);
    } catch (error) {
      setStage({ kind: "failed", message: error instanceof Error ? error.message : "上传失败。" });
      onBusyChange(false);
    }
  }, [source, watch, onBusyChange]);

  const close = () => {
    window.clearInterval(poll.current);
    onBusyChange(false);
    onClose();
  };

  const label = SOURCE_LABEL[source];
  return <div className="import-wizard" role="group" aria-label={`从 ${label} 导入`}>
    <div className="import-wizard__head">
      <Brand source={source} />
      <div>
        <b>从 {label} 导入</b>
        <p>{source === "obsidian" ? "选库文件夹 → 确认 → 上传转换" : "选导出 zip → 确认 → 上传转换"}</p>
      </div>
      <button type="button" className="icon-btn import-wizard__close" aria-label="关闭导入" disabled={busy} onClick={close}><X size={16} /></button>
    </div>

    {stage.kind === "pick" && <>
      <div
        className={`import-drop${drag ? " import-drop--over" : ""}`}
        role="button" tabIndex={0}
        onDragOver={(event) => { event.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(event) => { event.preventDefault(); setDrag(false); pickZip(event.dataTransfer.files); }}
        onClick={() => (source === "obsidian" ? folderRef : fileRef).current?.click()}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") (source === "obsidian" ? folderRef : fileRef).current?.click(); }}
      >
        <Upload size={20} aria-hidden="true" />
        {source === "obsidian"
          ? <><b>选择 Obsidian 库文件夹</b><p>或把库 zip 拖到此处；也可以 <button type="button" className="btn link" onClick={(e) => { e.stopPropagation(); fileRef.current?.click(); }}>选一个 zip 文件</button></p></>
          : <><b>选择 Notion 导出 zip</b><p>Notion：设置 → 导出所有内容 → Markdown & CSV</p></>}
      </div>
      <input ref={folderRef} type="file" hidden multiple
        {...({ webkitdirectory: "", directory: "" } as object)}
        onChange={(event) => { if (event.target.files?.length) void bundleFolder(event.target.files); event.target.value = ""; }} />
      <input ref={fileRef} type="file" hidden accept=".zip,application/zip"
        onChange={(event) => { pickZip(event.target.files); event.target.value = ""; }} />
    </>}

    {stage.kind === "scanning" && <p className="import-status"><Loader2 size={16} className="spin" aria-hidden="true" /> 正在扫描文件…</p>}

    {stage.kind === "confirm" && <div className="import-confirm">
      <div className="import-confirm__card">
        <FileText size={18} aria-hidden="true" />
        <div>
          <b>{stage.label}</b>
          <p>{stage.detail}</p>
          {stage.warn ? <p className="import-warn">{stage.warn}</p> : null}
        </div>
      </div>
      <div className="import-actions">
        <button type="button" className="btn btn-secondary" onClick={() => setStage({ kind: "pick" })}>重选</button>
        <button type="button" className="btn btn-primary" onClick={() => void upload(stage.zip)}>开始导入</button>
      </div>
      <p className="account-muted">导入会新建「{label} 导入」页面树，不改动现有笔记。</p>
    </div>}

    {(stage.kind === "uploading" || stage.kind === "running") && <div className="import-progress">
      <div className="import-progress__bar"><span style={{ width: stage.kind === "uploading" ? "8%" : `${Math.max(10, Math.round((stage.job.done / Math.max(1, stage.job.total)) * 90))}%` }} /></div>
      <p className="import-status"><Loader2 size={16} className="spin" aria-hidden="true" /> {stage.kind === "uploading" ? stage.detail : `${stage.job.phase}（${stage.job.done}/${stage.job.total}）`}</p>
    </div>}

    {stage.kind === "done" && <div className="import-done">
      <p className="import-status import-status--ok"><Check size={16} aria-hidden="true" /> 导入完成：{stage.report.pages} 个页面{stage.report.attachments ? `、${stage.report.attachments} 个附件` : ""}{stage.report.links ? `、${stage.report.links} 条链接` : ""}。</p>
      {stage.report.warnings.map((w) => <p key={w} className="import-warn">{w}</p>)}
      {stage.report.unresolved.length ? <p className="account-muted">{stage.report.unresolved.length} 条链接未解析（保留原样）：{stage.report.unresolved.slice(0, 3).join("、")}{stage.report.unresolved.length > 3 ? "…" : ""}</p> : null}
      <div className="import-actions">
        {onOpenPage ? <button type="button" className="btn btn-primary" onClick={() => { const id = stage.report.rootPageId; close(); onOpenPage(id); }}>打开「{stage.report.title}」</button> : null}
        <button type="button" className="btn btn-secondary" onClick={close}>关闭</button>
      </div>
    </div>}

    {stage.kind === "failed" && <div className="import-done">
      <p className="account-error" role="alert">{stage.message}</p>
      <div className="import-actions">
        <button type="button" className="btn btn-secondary" onClick={() => setStage({ kind: "pick" })}>重试</button>
        <button type="button" className="btn btn-secondary" onClick={close}>关闭</button>
      </div>
    </div>}
  </div>;
}

export function DataImport({ onBusyChange, onOpenPage }: {
  onBusyChange(busy: boolean): void;
  onOpenPage?(pageId: string): void;
}) {
  const [open, setOpen] = useState<Source | null>(null);
  const sources = useMemo(() => ([
    { id: "obsidian" as Source, label: "从 Obsidian 导入", desc: "选一个库文件夹或它的 zip：双链、附件、frontmatter 一并迁移。" },
    { id: "notion" as Source, label: "从 Notion 导入", desc: "上传 Notion 的「Markdown & CSV」导出 zip：页面树、表格、块样式一并迁移。" },
  ]), []);
  return <section className="settings-group" aria-label="导入笔记">
    <h2>导入</h2>
    {open
      ? <Wizard source={open} onClose={() => setOpen(null)} onOpenPage={onOpenPage} onBusyChange={onBusyChange} />
      : <>
        {sources.map((source) => (
          <button key={source.id} type="button" className="settings-row settings-row--nav" onClick={() => setOpen(source.id)} data-setting={`import-${source.id}`}>
            <Brand source={source.id} />
            <div className="settings-row__text">
              <label>{source.label}</label>
              <p>{source.desc}</p>
            </div>
            <ChevronRight size={16} className="settings-row__chev" aria-hidden="true" />
          </button>
        ))}
        <p className="settings-group__note">选一个来源开始导入向导。</p>
      </>}
  </section>;
}
