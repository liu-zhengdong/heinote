import { Archive, ArrowRightLeft, RotateCcw, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useWorkspace } from "../../app/workspace-context";
import { Button } from "../../components/Button";
import { Modal } from "../../components/Modal";
import { personName } from "../../components/ProfileAvatar";
import type { SpaceSummary } from "../../core/types";
import { ApiError } from "../../platform/http";
import { useKnowledgeBaseModal } from "./KnowledgeBaseDialog";
import { formatBytes } from "../admin/types";
import "./knowledge-base.css";

type Change =
  | { kind: "save"; requestId: string; revision: number; name: string; description: string }
  | { kind: "archive"; requestId: string; revision: number; archived: boolean }
  | { kind: "transfer"; requestId: string; revision: number; userId: string };

export function KnowledgeBaseSettings({ space, onClose }: { space: SpaceSummary; onClose(): void }) {
  const { platform, spaces, rosters, knowledgeBases, refreshSpaces } = useWorkspace();
  const current = spaces[space.spaceId] ?? space;
  const metadata = current.knowledgeBase;
  const owner = current.role === "owner";
  const editable = Boolean(metadata && !metadata.archived && (owner || current.role === "admin"));
  const [name, setName] = useState(space.name);
  const [description, setDescription] = useState(space.knowledgeBase?.description ?? "");
  const [revision, setRevision] = useState(space.knowledgeBase?.revision ?? 0);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [unknown, setUnknown] = useState<Change | null>(null);
  const [conflict, setConflict] = useState(false);
  const [reloadRequested, setReloadRequested] = useState(false);
  const [confirmation, setConfirmation] = useState<"archive" | "transfer" | null>(null);
  const [recipientId, setRecipientId] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const busy = useRef(false);
  const scope = useRef<HTMLDivElement>(null);
  const id = useId();
  const trapFocus = useKnowledgeBaseModal(scope);
  const members = (rosters[space.spaceId]?.members ?? []).filter((member) => member.id !== platform?.bootstrap.user.id && member.role !== "owner");
  const recipient = members.find((member) => member.id === recipientId);
  const locked = pending || Boolean(unknown);
  const close = () => { if (!busy.current && !unknown) onClose(); };

  useEffect(() => {
    if (!reloadRequested) return;
    setName(current.name);
    setDescription(current.knowledgeBase?.description ?? "");
    setRevision(current.knowledgeBase?.revision ?? 0);
    setRequestId(crypto.randomUUID());
    setConflict(false);
    setError("");
    setStatus("已重新读取知识库设置。");
    setConfirmation(null);
    setReloadRequested(false);
  }, [current, reloadRequested]);

  const accept = (result: SpaceSummary, change: Change) => {
    setRevision(result.knowledgeBase?.revision ?? revision);
    setRequestId(crypto.randomUUID());
    setUnknown(null);
    setConflict(false);
    setConfirmation(null);
    if (change.kind === "save") {
      setName(result.name);
      setDescription(result.knowledgeBase?.description ?? "");
      setStatus("已保存知识库设置。");
    } else if (change.kind === "archive") {
      setStatus(change.archived ? "知识库已归档。" : "知识库已恢复。");
    } else {
      onClose();
    }
  };

  const perform = async (change: Change, queryOnly = false) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    setStatus("");
    try {
      let result: SpaceSummary | undefined;
      if (queryOnly) {
        result = await knowledgeBases.operation(change.requestId);
        if (!result) {
          setError("尚未查到结果。请稍后查询，或重试原操作。");
          return;
        }
        await refreshSpaces();
      } else if (change.kind === "save") {
        const { kind: _, ...input } = change;
        result = await knowledgeBases.update(space.spaceId, input);
      } else if (change.kind === "archive") {
        const { kind: _, ...input } = change;
        result = await knowledgeBases.archive(space.spaceId, input);
      } else {
        const { kind: _, ...input } = change;
        result = await knowledgeBases.transfer(space.spaceId, input);
      }
      accept(result, change);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "result_unknown") {
        setUnknown(change);
        setError("尚未确认操作结果。输入已保留，请查询结果或重试原操作。");
      } else if (reason instanceof ApiError && reason.status === 409) {
        setConflict(true);
        setUnknown(null);
        setError("知识库设置已更新。你的输入已保留。请重新读取最新设置后再修改。");
      } else {
        setError(reason instanceof Error ? reason.message : "操作失败，请重试。");
      }
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  const reload = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try { await refreshSpaces(); setReloadRequested(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法重新读取知识库设置。"); }
    finally { busy.current = false; setPending(false); }
  };

  return <Modal open label="知识库设置" className="knowledge-base-modal" onClose={close}>
    <div ref={scope} tabIndex={-1} onKeyDown={trapFocus} aria-busy={pending}>
      <header className="knowledge-base-modal__header">
        <h1>知识库设置</h1>
        <button type="button" className="icon-btn" aria-label="关闭知识库设置" disabled={locked} onClick={close}><X size={17} aria-hidden="true" /></button>
      </header>
      <div className="knowledge-base-modal__body scroller">
        {metadata?.archived ? <p className="knowledge-base-note">知识库已归档。成员仍可阅读，内容暂不可修改。</p> : null}
        <form className="knowledge-base-form" onSubmit={(event) => {
          event.preventDefault();
          if (editable && name.trim() && !locked && !conflict) void perform({ kind: "save", requestId, revision, name: name.trim(), description: description.trim() });
        }}>
          <label className="knowledge-base-field" htmlFor={`${id}-name`}>
            <span>知识库名称</span>
            <input id={`${id}-name`} value={name} required maxLength={200} readOnly={!editable || Boolean(unknown)} disabled={pending}
              aria-describedby={error ? `${id}-error` : undefined} onChange={(event) => { setName(event.target.value); setStatus(""); }} />
          </label>
          {editable && metadata?.storage ? <p className="knowledge-base-note">存储 {formatBytes(metadata.storage.used)} / {formatBytes(metadata.storage.limit)}{metadata.storage.over > 0 ? "（已超额，请联系站点管理员）" : ""}</p> : null}
          <label className="knowledge-base-field" htmlFor={`${id}-description`}>
            <span>简介</span>
            <textarea id={`${id}-description`} value={description} rows={3} maxLength={2000} readOnly={!editable || Boolean(unknown)} disabled={pending}
              onChange={(event) => { setDescription(event.target.value); setStatus(""); }} />
          </label>
          {editable ? <div className="knowledge-base-actions"><Button type="submit" className="knowledge-base-primary" disabled={locked || conflict || !name.trim()}>{pending ? "正在保存…" : "保存"}</Button></div> : null}
        </form>

        {owner ? <section className="knowledge-base-management" aria-label="归档管理">
          <h2>{metadata?.archived ? "恢复知识库" : "归档知识库"}</h2>
          <p>{metadata?.archived ? "恢复后，成员可按原权限继续编写内容。" : "归档后，成员仍可阅读。内容和新邀请将暂停。你可以恢复知识库。"}</p>
          {metadata?.archived ? <Button icon={RotateCcw} disabled={locked || conflict} onClick={() => void perform({ kind: "archive", requestId, revision, archived: false })}>恢复知识库</Button>
            : confirmation === "archive" ? <div className="knowledge-base-confirmation">
              <p>确认归档「{current.name}」？</p>
              <div className="knowledge-base-actions"><Button disabled={locked} onClick={() => setConfirmation(null)}>取消</Button><Button className="knowledge-base-danger" disabled={locked || conflict} onClick={() => void perform({ kind: "archive", requestId, revision, archived: true })}>确认归档</Button></div>
            </div> : <Button icon={Archive} disabled={locked || conflict} onClick={() => setConfirmation("archive")}>归档知识库</Button>}
        </section> : null}

        {owner && members.length > 0 ? <section className="knowledge-base-management" aria-label="移交所有权">
          <h2>移交所有权</h2>
          <p>选择现有成员接任所有者。移交后，你将成为管理员。</p>
          <label className="knowledge-base-field" htmlFor={`${id}-owner`}>
            <span>新所有者</span>
            <select id={`${id}-owner`} value={recipientId} disabled={locked} onChange={(event) => { setRecipientId(event.target.value); setConfirmation(null); }}>
              <option value="" disabled>选择成员</option>
              {members.map((member) => <option key={member.id} value={member.id}>{personName(member)} (@{member.handle})</option>)}
            </select>
          </label>
          {confirmation === "transfer" && recipient ? <div className="knowledge-base-confirmation">
            <p>确认将「{current.name}」移交给 {personName(recipient)}？你将成为管理员。</p>
            <div className="knowledge-base-actions"><Button disabled={locked} onClick={() => setConfirmation(null)}>取消</Button><Button disabled={locked || conflict} onClick={() => void perform({ kind: "transfer", requestId, revision, userId: recipient.id })}>确认移交</Button></div>
          </div> : <Button icon={ArrowRightLeft} disabled={locked || conflict || !recipient} onClick={() => setConfirmation("transfer")}>移交所有权</Button>}
        </section> : null}

        {error ? <p id={`${id}-error`} className="knowledge-base-error" role="alert">{error}</p> : null}
        {conflict ? <div className="knowledge-base-recovery"><p>重新读取会用最新设置替换当前输入。</p><Button disabled={pending} onClick={() => void reload()}>重新读取</Button></div> : null}
        {unknown ? <div className="knowledge-base-actions"><Button disabled={pending} onClick={() => void perform(unknown, true)}>查询结果</Button><Button disabled={pending} onClick={() => void perform(unknown)}>重试原操作</Button></div> : null}
        {status ? <p className="knowledge-base-note" role="status">{status}</p> : null}
      </div>
    </div>
  </Modal>;
}
