import { Check, ChevronDown, GitPullRequest, RefreshCw, X } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { diffChars } from "diff";
import { pageBasis } from "../../collaboration/client";
import { textPreviews, type Operation, type TextPreview } from "./proposal-preview";
import { useWorkspace } from "../../app/workspace-context";
import { usePage } from "../../app/workspace-store";
import { Modal } from "../../components/Modal";
import { personName, ProfileAvatar } from "../../components/ProfileAvatar";
import { Tooltip } from "../../components/Tooltip";
import { inlinePlainText } from "../../core/inline-content";
import type { NotePage, Person } from "../../core/types";
import { ApiError, request } from "../../platform/http";
import "./collaboration.css";

interface Proposal {
  id: string; pageId: string; baseRevision: string; generation: string;
  operations: Operation[]; status: "pending" | "applied" | "rejected"; author: Person; createdAt: string;
}
const markLabels: Record<string, string> = { bold: "加粗", italic: "斜体", underline: "下划线", strike: "删除线", code: "代码", link: "链接", color: "颜色" };
const operationLabels: Record<Operation["type"], string> = { insert_text: "插入文字", delete_text: "删除文字", format_text: "修改格式", insert_block: "新增段落", delete_block: "删除段落", move_block: "移动段落" };
const statusLabels = { pending: "待处理", applied: "已应用", rejected: "已拒绝" };
const readable = (text: string) => text.replaceAll("\u2063", "[提及]");
const TextDifference = memo(function TextDifference({ before, after }: TextPreview) {
  const [expanded, setExpanded] = useState(false);
  const changes = useMemo(() => diffChars(before, after, { timeout: 30 }) ?? [{ value: before, added: false, removed: true }, { value: after, added: true, removed: false }], [before, after]);
  const abbreviated = changes.some((part) => !part.added && !part.removed && Array.from(part.value).length > 96);
  return <div className="proposal-diff">
    <p className="proposal-diff__text">{changes.map((part, index) => {
      let value = part.value;
      if (!expanded && !part.added && !part.removed) {
        const characters = Array.from(value);
        if (characters.length > 96) value = index === 0 ? `…${characters.slice(-64).join("")}` : index === changes.length - 1 ? `${characters.slice(0, 64).join("")}…` : `${characters.slice(0, 40).join("")} … ${characters.slice(-40).join("")}`;
      }
      value = readable(value);
      return part.added ? <ins key={index}>{value}</ins> : part.removed ? <del key={index}>{value}</del> : <span key={index}>{value}</span>;
    })}</p>
    {abbreviated ? <button className="proposal-diff__expand" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起全文" : "展开完整段落"}<ChevronDown size={12} aria-hidden="true" /></button> : null}
  </div>;
});
function OperationPreview({ operation, page }: { operation: Operation; page: NotePage | null }) {
  const block = "blockId" in operation ? page?.block_tree.by_id[operation.blockId] : undefined;
  const current = block ? inlinePlainText(block.content) : null;
  const removed = operation.type === "delete_text" && current !== null ? current.slice(operation.index, operation.index + operation.length)
    : operation.type === "delete_block" ? current : null;
  return <li className="proposal-operation">
    <span className="proposal-operation__label">{operationLabels[operation.type]}</span>
    {"blockId" in operation && operation.type !== "delete_text" && operation.type !== "delete_block" ? <span className="proposal-operation__hint">{current === null ? "目标段落当前不可见" : `段落：${readable(current).replace(/\n/g, " ").slice(0, 60) || "空段落"}`}</span> : null}
    {operation.type === "insert_text" || operation.type === "insert_block" ? <pre className="proposal-operation__text proposal-operation__text--insert">{operation.text || "（空段落）"}</pre> : null}
    {operation.type === "delete_text" || operation.type === "delete_block" ? <>
      <span className="proposal-operation__hint">{removed === null ? "原提案操作" : "当前文字预览"}</span>
      <pre className="proposal-operation__text proposal-operation__text--delete">{removed === null ? operation.type === "delete_text" ? `删除范围 ${operation.index}–${operation.index + operation.length}` : "删除该段落及其子段落" : readable(removed) || "（空段落或非文字内容）"}</pre>
    </> : null}
    {operation.type === "format_text" ? <span className="proposal-operation__detail">{Object.entries(operation.marks).map(([key, value]) => `${value === null || value === false ? "移除" : "设置"}${markLabels[key] ?? key}`).join("、")}</span> : null}
    {operation.type === "move_block" ? <span className="proposal-operation__detail">{operation.parentId ? "移到目标段落内" : "移到页面顶层"}</span> : null}
  </li>;
}

export function AgentProposals({ pageId, compact = false }: { pageId: string; compact?: boolean }) {
  const { platform, spaceOf, canEdit } = useWorkspace();
  const page = usePage(pageId);
  const userId = platform?.bootstrap.user.id;
  const scope = spaceOf(pageId) ?? "personal";
  const source = JSON.stringify([userId, scope, pageId]);
  const [state, setState] = useState<{ source: string; items: Proposal[]; loaded: boolean; error: string }>({ source, items: [], loaded: false, error: "" });
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [pending, setPending] = useState<{ source: string; id: string; action: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, { message: string; stale: boolean }>>({});
  const [notice, setNotice] = useState("");
  const refresh = useRef<() => Promise<void>>(async () => {});
  const reviewing = useRef<string | null>(null);
  const reviewVersion = useRef(0);
  const button = useRef<HTMLButtonElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const currentSource = useRef(source); currentSource.current = source;
  const items = state.source === source ? state.items : [];
  const open = openFor === source;
  const editable = canEdit(pageId);
  const pendingCount = items.filter((item) => item.status === "pending").length;
  const shown = filter === "pending" ? items.filter((item) => item.status === "pending") : items;
  const working = pending?.source === source ? pending : null;
  const basis = open ? pageBasis(scope, pageId) : null;

  useEffect(() => {
    if (!userId || !pageId) return;
    let closed = false; let loading = false;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    setErrors({}); setNotice(""); setFilter("pending");
    const load = async () => {
      if (loading || closed) return;
      loading = true;
      const version = reviewVersion.current;
      try {
        const list = await request<Proposal[]>(`/api/proposals?${new URLSearchParams({ scope, pageId })}`, { signal: abort.signal });
        if (!closed && version === reviewVersion.current) setState({ source, items: list, loaded: true, error: "" });
      } catch (reason) {
        const denied = reason instanceof ApiError && [401, 403, 404].includes(reason.status);
        if (!closed && version === reviewVersion.current) setState((previous) => ({ source, items: !denied && previous.source === source ? previous.items : [], loaded: true, error: reason instanceof Error ? reason.message : "无法读取提案。" }));
      } finally { loading = false; }
    };
    refresh.current = load;
    const tick = async () => { await load(); if (!closed) timer = setTimeout(tick, 2000); };
    void tick();
    return () => { closed = true; abort.abort(); clearTimeout(timer); };
  }, [userId, pageId, scope, source]);

  useEffect(() => { if (open) closeButton.current?.focus(); }, [open]);
  const close = () => { setOpenFor(null); button.current?.focus(); };
  const review = async (item: Proposal, action: "apply" | "reject") => {
    if (working || reviewing.current === source || !editable) return;
    const originalSource = source;
    reviewing.current = source; reviewVersion.current += 1;
    setPending({ source, id: item.id, action }); setNotice("");
    setErrors((previous) => { const next = { ...previous }; delete next[item.id]; return next; });
    try {
      await request(`/api/proposals/${encodeURIComponent(item.id)}/${action}`, { method: "POST", body: "{}" });
      if (currentSource.current !== originalSource) return;
      reviewVersion.current += 1;
      setState((previous) => ({ ...previous, items: previous.items.map((proposal) => proposal.id === item.id ? { ...proposal, status: action === "apply" ? "applied" : "rejected" } : proposal) }));
      setNotice(action === "apply" ? "提案已应用。" : "提案已拒绝。");
      await refresh.current();
    } catch (reason) {
      if (currentSource.current !== originalSource) return;
      reviewVersion.current += 1;
      const message = reason instanceof ApiError && reason.status === 409
        ? `${reason.message} 请重新生成提案。原提案已保留。`
        : reason instanceof Error ? reason.message : "操作失败，提案仍保留。";
      setErrors((previous) => ({ ...previous, [item.id]: { message, stale: reason instanceof ApiError && reason.status === 409 } }));
      if (!(reason instanceof ApiError && reason.status === 409)) await refresh.current();
    } finally {
      if (reviewing.current === originalSource) reviewing.current = null;
      if (currentSource.current === originalSource) setPending(null);
    }
  };
  if (!userId) return null;

  return <>
    <Tooltip label="查看 Agent 提案">
      <button ref={button} type="button" className={`proposal-entry${compact ? " proposal-entry--compact" : ""}`} aria-label="Agent 提案" aria-description={`${pendingCount} 项待处理`} aria-haspopup="dialog" onClick={() => { setOpenFor(source); void refresh.current(); }}>
        <GitPullRequest size={16} aria-hidden="true" /><span className="proposal-entry__label">提案</span>
        {pendingCount ? <span className="proposal-entry__count" aria-hidden="true">{pendingCount > 99 ? "99+" : pendingCount}</span> : null}
      </button>
    </Tooltip>
    <Modal open={open} label="Agent 提案" className="agent-proposals" onClose={close}>
      <div className="agent-proposals__head"><div><h2>Agent 提案</h2><p>{page?.title || "当前页面"}</p></div><button ref={closeButton} autoFocus type="button" className="icon-btn" aria-label="关闭提案" onClick={close}><X size={18} /></button></div>
      <div className="agent-proposals__tools"><div className="proposal-tabs" data-filter={filter} role="tablist" aria-label="提案状态">
        <button type="button" role="tab" aria-selected={filter === "pending"} onClick={() => setFilter("pending")}>待处理 {pendingCount}</button>
        <button type="button" role="tab" aria-selected={filter === "all"} onClick={() => setFilter("all")}>全部</button>
      </div><button type="button" className="icon-btn" aria-label="刷新提案" onClick={() => void refresh.current()}><RefreshCw size={15} /></button></div>
      <div className="agent-proposals__body" aria-busy={Boolean(working)}>
        {state.source !== source || !state.loaded ? <p className="proposal-empty" role="status">正在读取提案…</p> : null}
        {state.source === source && state.error ? <p className="proposal-error" role="alert">{state.error} <button type="button" onClick={() => void refresh.current()}>重试</button></p> : null}
        {notice ? <p className="proposal-notice" role="status"><Check size={15} aria-hidden="true" />{notice}</p> : null}
        {!editable ? <p className="proposal-muted">你可以查看提案。应用或拒绝需要编辑权限。</p> : null}
        {state.source === source && state.loaded && !state.error && !shown.length ? <p className="proposal-empty">{filter === "pending" ? "没有待处理提案" : "暂无提案"}</p> : null}
        <div className="proposal-list">{shown.map((item) => {
          const matches = basis?.generation === item.generation && basis.revision === item.baseRevision;
          const stale = item.status === "pending" && Boolean(basis) && !matches;
          const previews = item.status === "pending" && matches ? textPreviews(page, item.operations) : null;
          return <article className={`proposal proposal--${item.status}`} key={item.id} aria-label={`提案，${personName(item.author)}`}>
            <header className="proposal__head"><ProfileAvatar name={personName(item.author)} src={item.author.avatarUrl} size={26} /><div className="proposal__author"><strong>{personName(item.author)}</strong><span className="proposal__scope">{previews ? `修改 ${previews.length} 段文字` : `${item.operations.length} 项操作`}</span></div><time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString("zh-CN")}>{new Date(item.createdAt).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>{item.status !== "pending" ? <span className={`proposal__status proposal__status--${item.status}`}>{statusLabels[item.status]}</span> : null}</header>
            {stale ? <p className="proposal-stale">正文已变化，请重新生成提案。</p> : null}
            {previews ? <div className="proposal__preview">{previews.map((preview) => <TextDifference key={preview.blockId} {...preview} />)}</div> : <details className="proposal__changes" open={item.status === "pending"}><summary>{item.status === "pending" ? "查看操作明细" : "查看原提案"}<ChevronDown size={13} aria-hidden="true" /></summary><ol>{item.operations.map((operation, index) => <OperationPreview operation={operation} page={null} key={index} />)}</ol></details>}
            {errors[item.id] ? <p className="proposal-error" role="alert">{errors[item.id].message}</p> : null}
            {item.status === "pending" ? <div className="proposal__actions"><button type="button" className="btn" aria-label="拒绝提案" disabled={!editable || Boolean(working)} onClick={() => void review(item, "reject")}>{working?.id === item.id && working.action === "reject" ? "拒绝中…" : "拒绝"}</button><button type="button" className="btn btn--primary" disabled={!editable || Boolean(working) || stale || !basis || Boolean(errors[item.id]?.stale)} onClick={() => void review(item, "apply")}>{working?.id === item.id && working.action === "apply" ? <><RefreshCw size={13} className="proposal-progress" aria-hidden="true" />应用中…</> : <><Check size={14} aria-hidden="true" />应用提案</>}</button></div> : null}
          </article>;
        })}</div>
      </div>
    </Modal>
  </>;
}
