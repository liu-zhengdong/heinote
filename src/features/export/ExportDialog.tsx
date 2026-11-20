import { FileDown, FileText, FileCode, Table } from "lucide-react";
import { useState } from "react";
import { Modal } from "../../components/Modal";
import { pageName } from "../../core/block-tree";
import type { NotePage } from "../../core/types";
import { useWorkspace } from "../../app/workspace-context";
import { useUi } from "../../app/ui-context";
import { activeView } from "../database/database-model";
import { buildExport, exportPages, type ExportFormat } from "./export";
import { downloadBlob } from "./download";
import "./export.css";

/* The "Export…" dialog behind the page's ··· menu: pick a format (and a
   view for a database), confirm, and the file downloads. */

const FORMATS: { id: ExportFormat; label: string; hint: string; icon: typeof FileText }[] = [
  { id: "markdown", label: "Markdown", hint: "纯文本笔记，子页面与附件随 zip 打包", icon: FileText },
  { id: "html", label: "HTML", hint: "只读网页文件，可直接在浏览器打开", icon: FileCode },
];

const DATABASE_FORMATS: typeof FORMATS = [
  { id: "csv", label: "CSV", hint: "按当前视图导出行，Excel 直接打开", icon: Table },
  { id: "markdown", label: "Markdown", hint: "表格说明加行页面正文，打包 zip", icon: FileText },
  { id: "html", label: "HTML", hint: "只读表格与行页面，打包 zip", icon: FileCode },
];

export function ExportDialog({ page, onClose }: { page: NotePage; onClose(): void }) {
  const { document, platform, preferences } = useWorkspace();
  const { toast } = useUi();
  const isDatabase = page.kind === "database" && Boolean(page.database);
  const formats = isDatabase ? DATABASE_FORMATS : FORMATS;
  const [format, setFormat] = useState<ExportFormat>(formats[0].id);
  const views = isDatabase ? page.database!.views : [];
  const [viewId, setViewId] = useState<string>(() => isDatabase ? activeView(page.database!, preferences.database_views[page.id]).id : "");
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy || !platform) return;
    const pages = document?.state.pages;
    if (!pages) { toast("工作区还没准备好，稍后再试。", "error"); return; }
    setBusy(true);
    try {
      const source = { pages, files: platform.files, loadPages: (ids: readonly string[]) => document!.loadPages(ids) };
      const exportPage = await exportPages(source, page.id);
      const file = await buildExport(source, exportPage, format, { viewId });
      downloadBlob(file.body, file.name);
      toast(file.missing.length ? `已导出，${file.missing.length} 个附件缺失` : `已导出 ${file.name}`, file.missing.length ? "info" : "success");
      onClose();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "导出失败，请重试。", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open label={`导出「${pageName(page)}」`} className="export-dialog" onClose={onClose}>
      <h2 className="export-dialog__title">导出「{pageName(page)}」</h2>
      <div className="export-dialog__formats" role="radiogroup" aria-label="导出格式">
        {formats.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={format === item.id}
              className={`export-dialog__format${format === item.id ? " is-on" : ""}`}
              onClick={() => setFormat(item.id)}
            >
              <Icon size={19} aria-hidden="true" />
              <span className="export-dialog__format-text">
                <span className="export-dialog__format-label">{item.label}</span>
                <span className="export-dialog__format-hint">{item.hint}</span>
              </span>
              <span className="export-dialog__check" aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {views.length > 1 && format === "csv" ? (
        <label className="export-dialog__view">
          视图
          <select value={viewId} onChange={(event) => setViewId(event.target.value)}>
            {views.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
          </select>
        </label>
      ) : null}
      <div className="export-dialog__actions">
        <button type="button" className="btn btn--outline" onClick={onClose} disabled={busy}>取消</button>
        <button type="button" className="btn" onClick={() => void run()} disabled={busy}>
          <FileDown size={16} aria-hidden="true" /> {busy ? "导出中…" : "导出"}
        </button>
      </div>
    </Modal>
  );
}
