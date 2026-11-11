import { Download, Upload } from "lucide-react";
import { useState } from "react";
import type { AccountPanelProps } from "./account-panel";

/* 数据：把账号的笔记打包成 zip 带走。下载交给浏览器，导出在服务端流式生成；
   按钮只在点击后短暂置忙，下载进度由浏览器接管。 */
export function DataExport({ onBusyChange }: AccountPanelProps) {
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

  return <section className="settings-group" aria-label="数据迁移">
    <h2>迁移</h2>
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
    <div className="settings-row">
      <span className="settings-row__icon" aria-hidden="true"><Upload size={15} /></span>
      <div className="settings-row__text">
        <label>从 Obsidian 导入</label>
        <p>选一个 Obsidian 库的 zip，双链与附件一并迁移。</p>
      </div>
      <span className="settings-row__hint">即将推出</span>
    </div>
    {started && !pending ? <p className="account-muted" role="status">下载已开始，请在浏览器下载列表查看。</p> : null}
    {started && pending ? <p className="account-muted" role="status">正在生成导出包…</p> : null}
  </section>;
}
