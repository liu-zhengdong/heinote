import { Download } from "lucide-react";
import { useState } from "react";
import type { AccountPanelProps } from "./account-panel";
import { DataImport } from "./DataImport";

/* 数据：把账号的笔记打包成 zip 带走，或从 Obsidian / Notion 导入。
   导出与导入各自一块；下载交给浏览器，导入走向导。 */
export function DataExport({ onBusyChange, onOpenPage }: AccountPanelProps & { onOpenPage?(pageId: string): void }) {
  const [pending, setPending] = useState(false);
  const [started, setStarted] = useState(false);

  const start = () => {
    if (pending) return;
    setPending(true);
    onBusyChange(true);
    setStarted(true);
    // The download itself is the browser's; give the request a beat to begin
    // so a second click cannot fire two exports at once.
    window.setTimeout(() => { setPending(false); onBusyChange(false); }, 3000);
    const link = document.createElement("a");
    link.href = "/api/account/export";
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  };

  return <>
    <section className="settings-group" aria-label="导出笔记">
      <h2>导出</h2>
      <div className="settings-row">
        <span className="settings-row__icon" aria-hidden="true"><Download size={15} /></span>
        <div className="settings-row__text">
          <label>导出笔记数据</label>
          <p>全部笔记打包成 zip：每页一个 Markdown、图片与文件附件、无损原始记录（含历史版本）。回收站一并导出。</p>
        </div>
        <button type="button" className="btn settings-row__action" disabled={pending} onClick={start} data-setting="export-download">
          {pending ? "导出中…" : "导出"}
        </button>
      </div>
      {started && !pending ? <p className="account-muted" role="status">下载已开始，请在浏览器下载列表查看。</p> : null}
      {started && pending ? <p className="account-muted" role="status">正在生成导出包…</p> : null}
    </section>
    <DataImport onBusyChange={onBusyChange} onOpenPage={onOpenPage} />
  </>;
}
