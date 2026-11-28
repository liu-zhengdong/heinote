import { AlertCircle, Bot, Check, CheckCircle2, FolderTree, Loader2, Upload, User, X } from "lucide-react";
import { useState } from "react";
import { useUi } from "../../app/ui-context";
import { useWorkspace } from "../../app/workspace-context";
import { useWorkspaceState } from "../../app/workspace-store";
import { pageName } from "../../core/block-tree";
import { isActiveImportStatus, type ImportJobDto } from "./useImports";
import "./ImportProgressView.css";

const STAGES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "uploading", label: "上传分片" },
  { key: "queued", label: "排队等待" },
  { key: "parsing", label: "解析与写附件" },
  { key: "committing", label: "原子落库" },
];

function stageIndex(status: ImportJobDto["status"]): number {
  switch (status) {
    case "uploading": return 0;
    case "queued": return 1;
    case "scanning":
    case "importing": return 2;
    case "committing": return 3;
    case "done": return 4;
    default: return -1;
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

export function ImportProgressView({ job }: { job: ImportJobDto }) {
  const { activeSpace, spaces, selectPage } = useWorkspace();
  const { selectImport, cancelImportJob, dismissImportJob, toast } = useUi();
  const parentPage = useWorkspaceState((state) => (job.parentId ? state.pages[job.parentId] : undefined));
  const [busy, setBusy] = useState(false);

  const active = isActiveImportStatus(job.status);
  const currentStage = stageIndex(job.status);

  const targetLabel = job.parentId
    ? (parentPage ? pageName(parentPage) : "指定父页面")
    : job.targetScope === "personal"
      ? "个人空间根目录"
      : (spaces[job.targetScope]?.name ?? activeSpace?.name ?? "团队空间");

  const progressPercent = (() => {
    if (job.status === "done") return 100;
    if (job.status === "committing") return 96;
    if (job.status === "uploading") {
      return job.totalBytes > 0 ? Math.min(99, Math.round((job.uploadedBytes / job.totalBytes) * 100)) : 0;
    }
    if (job.status === "queued") return 5;
    if (job.total > 0) return Math.max(8, Math.min(94, Math.round((job.done / job.total) * 90)));
    return 12;
  })();

  const statusText = (() => {
    if (job.status === "uploading") {
      const doneParts = job.receivedParts?.length ?? 0;
      return `已接收 ${doneParts} / ${job.partCount} 分片 · ${formatSize(job.uploadedBytes)} / ${formatSize(job.totalBytes)}`;
    }
    if (job.status === "queued") {
      return job.queuePosition ? `队列第 ${job.queuePosition} 位，等待上一个导入完成…` : "等待队列调度…";
    }
    if (job.status === "scanning") return job.phase || "正在扫描归档目录…";
    if (job.status === "importing") return `${job.phase || "正在解析笔记…"}（${job.done} / ${Math.max(job.done, job.total)}）`;
    if (job.status === "committing") return "正在执行单事务原子提交，马上完成…";
    if (job.status === "done") return "导入已完成";
    return job.error || "导入失败";
  })();

  const handleCancel = async () => {
    setBusy(true);
    try {
      await cancelImportJob(job.id);
      toast("已取消导入", "info");
    } catch (error) {
      toast(error instanceof Error ? error.message : "无法取消导入", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = async () => {
    setBusy(true);
    try {
      await dismissImportJob(job.id);
      selectImport(null);
    } catch (error) {
      toast(error instanceof Error ? error.message : "无法移除提示", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleOpenResult = () => {
    const targetId = job.result?.topLevelPageIds?.[0] ?? job.result?.parentPageId ?? job.result?.rootPageId;
    selectImport(null);
    if (targetId) selectPage(targetId);
  };

  return (
    <div className="import-view" data-import-view={job.id}>
      <header className="import-view__head">
        <div className={`import-view__badge import-view__badge--${job.status}`}>
          {active ? <Loader2 size={18} className="spin" aria-hidden="true" />
            : job.status === "done" ? <CheckCircle2 size={18} aria-hidden="true" />
              : <AlertCircle size={18} aria-hidden="true" />}
        </div>
        <div className="import-view__titles">
          <h1>{job.title || "导入笔记"}</h1>
          <div className="import-view__meta">
            <span><FolderTree size={13} aria-hidden="true" /> 导入至：{targetLabel}</span>
            <span><Upload size={13} aria-hidden="true" /> 来源：{job.source === "obsidian" ? "Obsidian" : "Notion"}</span>
            {job.initiator ? (
              <span>
                {job.initiator.tokenId ? <Bot size={13} aria-hidden="true" /> : <User size={13} aria-hidden="true" />}
                {job.initiator.tokenId ? `Agent「${job.initiator.displayName}」` : job.initiator.displayName}
              </span>
            ) : null}
          </div>
        </div>
      </header>

      <section className="import-view__card" aria-live="polite">
        <ol className="import-view__steps" aria-label="导入阶段">
          {STAGES.map((stage, index) => {
            const done = job.status === "done" || (currentStage > index && job.status !== "failed");
            const current = active && currentStage === index;
            return (
              <li
                key={stage.key}
                className={`import-view__step ${done ? "is-done" : ""} ${current ? "is-current" : ""}`}
              >
                <span className="import-view__step-dot">
                  {done ? <Check size={12} aria-hidden="true" /> : index + 1}
                </span>
                <span>{stage.label}</span>
              </li>
            );
          })}
        </ol>

        <div className="import-view__progress">
          <div className="import-view__bar" role="progressbar" aria-valuenow={progressPercent} aria-valuemin={0} aria-valuemax={100}>
            <span className={job.status === "failed" ? "is-failed" : job.status === "done" ? "is-done" : ""} style={{ width: `${job.status === "failed" ? 100 : progressPercent}%` }} />
          </div>
          <div className="import-view__status-row">
            <span className="import-view__status-text">{statusText}</span>
            {job.status !== "failed" ? <span className="import-view__pct">{progressPercent}%</span> : null}
          </div>
        </div>

        {job.status === "done" && job.result ? (
          <div className="import-view__summary">
            <p className="import-view__ok">
              <CheckCircle2 size={16} aria-hidden="true" />
              导入完成：共 {job.result.pages} 个页面
              {job.result.attachments ? `、${job.result.attachments} 个附件` : ""}
              {job.result.links ? `、${job.result.links} 条双链` : ""}。
            </p>
            {job.result.warnings.length ? (
              <ul className="import-view__warnings">
                {job.result.warnings.slice(0, 5).map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            ) : null}
            {job.result.unresolved.length ? (
              <p className="import-view__muted">
                {job.result.unresolved.length} 条链接未匹配，已保留原文：{job.result.unresolved.slice(0, 4).join("、")}
                {job.result.unresolved.length > 4 ? "…" : ""}
              </p>
            ) : null}
            <div className="import-view__actions">
              <button type="button" className="btn btn--primary" onClick={handleOpenResult}>打开导入内容</button>
              <button type="button" className="btn btn--outline" disabled={busy} onClick={() => void handleDismiss()}>关闭</button>
            </div>
          </div>
        ) : null}

        {job.status === "failed" ? (
          <div className="import-view__error" role="alert">
            <p>{job.error || "导入未能完成，已回滚全部修改。"}</p>
            <div className="import-view__actions">
              <button type="button" className="btn btn--outline" disabled={busy} onClick={() => void handleDismiss()}>
                <X size={14} aria-hidden="true" /> 关闭并移除提示
              </button>
            </div>
          </div>
        ) : null}

        {active ? (
          <div className="import-view__actions">
            <button
              type="button"
              className="btn btn--outline"
              disabled={busy || job.status === "committing"}
              onClick={() => void handleCancel()}
            >
              取消导入
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
