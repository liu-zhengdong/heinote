import { ChevronDown, Copy, ImagePlus, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { AVATAR_PRESETS, AgentMark, TokenAvatar } from "../../components/AgentMark";
import type { AccountPanelProps, TokenSecret } from "./account-panel";
import { api, ApiError, errorMessage } from "./api";
import { ListStatus } from "./ListStatus";
import { formatDate, useAccountList } from "./useAccountList";

interface AgentToken {
  id: string;
  name: string;
  displayName: string;
  avatar: string;
  access: "read" | "write";
  createdAt: string;
  lastUsedAt: string | null;
}

interface TokenEvent {
  id: string;
  action: string;
  pageId: string;
  pageTitle: string;
  versionId: string | null;
  createdAt: string;
}

const ACTIONS: Record<string, string> = {
  create: "创建",
  edit: "修改",
  propose: "提案",
  checkpoint: "检查点",
  restore: "恢复",
  database: "数据库",
  delete: "删除",
};

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
}

function activityLabel(item: TokenEvent): string {
  return ACTIONS[item.action] ?? item.action;
}

export function AgentTokens({ onBusyChange, active, secret, onSecretChange: setSecret, onOpenPage }: AccountPanelProps & {
  secret: TokenSecret | null;
  onSecretChange(secret: TokenSecret | null): void;
  onOpenPage?(pageId: string): void;
}) {
  const { items, setItems, loading, error, setError, retry } = useAccountList<AgentToken>("/api/tokens", active);
  const [open, setOpen] = useState("");
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [access, setAccess] = useState<AgentToken["access"]>("write");
  const [preset, setPreset] = useState("");
  const [customFile, setCustomFile] = useState<File | null>(null);
  const [pending, setPending] = useState("");
  const [confirming, setConfirming] = useState("");
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState("");
  const [avatarFor, setAvatarFor] = useState("");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");
  const [activities, setActivities] = useState<Record<string, TokenEvent[]>>({});
  const [activityLoading, setActivityLoading] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const avatarInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || activities[open]) return;
    const controller = new AbortController();
    setActivityLoading(open);
    void api<TokenEvent[]>(`/api/tokens/${encodeURIComponent(open)}/activity`, { signal: controller.signal })
      .then((list) => setActivities((current) => ({ ...current, [open]: list })))
      .catch(() => undefined)
      .finally(() => setActivityLoading((current) => current === open ? "" : current));
    return () => controller.abort();
  }, [open, activities]);

  const toggle = (item: AgentToken) => {
    setOpen((current) => current === item.id ? "" : item.id);
    setConfirming("");
    setEditing("");
    setDraft("");
  };

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || secret || !name.trim()) return;
    setPending("create");
    onBusyChange(true);
    setError("");
    setNotice("");
    try {
      const created = await api<AgentToken & { token: string }>("/api/tokens", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          displayName: displayName.trim() || undefined,
          access,
          ...(preset ? { avatar: `preset:${preset}` } : {}),
        }),
      });
      let final = created;
      if (customFile) {
        final = await api<AgentToken & { token: string }>(`/api/tokens/${encodeURIComponent(created.id)}/avatar`, {
          method: "PUT", headers: { "Content-Type": customFile.type }, body: customFile,
        });
      }
      setSecret({ value: created.token, name: created.name });
      const { token: _token, ...metadata } = final;
      setItems((current) => [metadata, ...current]);
      setName("");
      setDisplayName("");
      setPreset("");
      setCustomFile(null);
      setCreating(false);
    } catch (reason) {
      setError(errorMessage(reason));
      if (!(reason instanceof ApiError) || reason.status >= 500) {
        setError(`${errorMessage(reason)}。创建结果未确认，原文无法找回。`);
        setNotice("请核对令牌列表。撤销本次令牌后可重新创建。");
        try { setItems(await api<AgentToken[]>("/api/tokens")); }
        catch { retry(); }
      }
    }
    finally { setPending(""); onBusyChange(false); }
  };

  const saveIdentity = async (item: AgentToken, fields: { displayName?: string; avatar?: string }) => {
    if (pending) return;
    setPending(item.id);
    onBusyChange(true);
    setError("");
    try {
      const next = await api<AgentToken>(`/api/tokens/${encodeURIComponent(item.id)}`, {
        method: "PATCH", body: JSON.stringify(fields),
      });
      setItems((current) => current.map((token) => token.id === item.id ? next : token));
      setNotice(`已更新「${item.name}」的身份`);
    } catch (reason) {
      setError(errorMessage(reason));
    }
    finally { setPending(""); onBusyChange(false); }
  };

  const uploadAvatar = async (item: AgentToken, file: File) => {
    if (pending) return;
    setPending(item.id);
    onBusyChange(true);
    setError("");
    try {
      const next = await api<AgentToken>(`/api/tokens/${encodeURIComponent(item.id)}/avatar`, {
        method: "PUT", headers: { "Content-Type": file.type }, body: file,
      });
      setItems((current) => current.map((token) => token.id === item.id ? next : token));
      setNotice(`已更换「${item.name}」的头像`);
    } catch (reason) {
      setError(errorMessage(reason));
    }
    finally { setPending(""); onBusyChange(false); }
  };

  const revoke = async (item: AgentToken) => {
    if (pending) return;
    setPending(item.id);
    onBusyChange(true);
    setError("");
    setNotice("");
    try {
      await api(`/api/tokens/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      setItems((current) => current.filter((token) => token.id !== item.id));
      setConfirming("");
      setOpen("");
      setNotice(`已撤销「${item.name}」`);
    } catch (reason) {
      setError(errorMessage(reason));
      if (!(reason instanceof ApiError) || reason.status >= 500) retry();
    }
    finally { setPending(""); onBusyChange(false); }
  };

  const copy = async () => {
    if (!secret) return;
    try { await navigator.clipboard.writeText(secret.value); setNotice("已复制令牌"); }
    catch { setNotice("复制失败，请选中令牌复制"); }
  };

  return <>
    <p className="account-muted">令牌供 Agent 调用 API。每个令牌携带一个 Agent 身份，写操作以此身份署名。</p>
    <ListStatus loading={loading} error={error} retry={retry} empty={false} emptyText="" />
    {items.length ? <ul className="account-token-list" aria-label="Agent 令牌" aria-busy={loading || Boolean(pending)}>
      {items.map((item) => {
        const isOpen = open === item.id;
        return <li key={item.id}>
          <button type="button" className={`token-row${isOpen ? " is-open" : ""}`} aria-expanded={isOpen} aria-label={`令牌「${item.name}」`} onClick={() => toggle(item)}>
            <TokenAvatar tokenId={item.id} avatar={item.avatar} name={item.displayName || item.name} size={26} />
            <span className="token-row__main">
              <span className="token-row__name">{item.displayName || item.name}</span>
            </span>
            <span className="token-row__tail">
              <span className="tag">{item.access === "write" ? "读写" : "只读"}</span>
              <span className="account-token__time">{item.lastUsedAt ? `最近使用 ${formatTime(item.lastUsedAt)}` : `创建于 ${formatDate(item.createdAt)}`}</span>
              <ChevronDown size={14} className="token-row__chev" aria-hidden="true" />
            </span>
          </button>
          {isOpen ? <div className="token-detail">
            <div className="token-detail__feed">
              <div className="group-title">最近写操作 <span className="account-muted">创建于 {formatDate(item.createdAt)}</span></div>
              {activityLoading === item.id ? <p className="feed__empty">读取中…</p>
                : (activities[item.id]?.length ? <ul className="feed">
                  {activities[item.id].slice(0, 8).map((event) => <li className="feed__item" key={event.id}>
                    <span className={`feed__dot feed__dot--${event.action}`} aria-hidden="true" />
                    <span className="feed__act">{activityLabel(event)}</span>
                    {onOpenPage ? <button type="button" className="feed__page" onClick={() => onOpenPage(event.pageId)}>{event.pageTitle || "未命名"}</button>
                      : <span className="feed__page">{event.pageTitle || "未命名"}</span>}
                    <time className="feed__time" dateTime={event.createdAt}>{formatTime(event.createdAt)}</time>
                  </li>)}
                  {(activities[item.id].length > 8) ? <li className="feed__more">共 {activities[item.id].length} 条，显示最近 8 条</li> : null}
                </ul> : <p className="feed__empty">还没有写操作。Agent 使用令牌写入后，这里记录时间、动作与页面。</p>)}
            </div>
            {confirming === item.id ? <div className="confirm-strip">
              <span>撤销「{item.name}」？该令牌将立即失效，页面历史中的署名保留。</span>
              <button type="button" className="btn" disabled={Boolean(pending)} onClick={() => setConfirming("")}>取消</button>
              <button type="button" className="btn btn--danger" aria-label={`确认撤销令牌「${item.name}」`} disabled={Boolean(pending)} onClick={() => void revoke(item)}>
                {pending === item.id ? "撤销中…" : `确认撤销`}
              </button>
            </div> : null}
            {editing === item.id ? <div className="token-edit">
              <label className="account-field">显示名
                <input name="tokenDisplayName" value={draft} maxLength={100} disabled={Boolean(pending)}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter" && draft.trim()) void saveIdentity(item, { displayName: draft.trim() }); }}
                  onBlur={() => { if (draft.trim() && draft !== (item.displayName || item.name)) void saveIdentity(item, { displayName: draft.trim() }); }}
                />
              </label>
              <div className="account-field">
                <span className="account-field__label">头像</span>
                <div className="presets" role="radiogroup" aria-label="头像预设">
                  {AVATAR_PRESETS.map((item_) => <button type="button" key={item_.id}
                    className={`preset${item.avatar === `preset:${item_.id}` ? " is-on" : ""}`}
                    disabled={Boolean(pending)} title={item_.name}
                    onClick={() => void saveIdentity(item, { avatar: `preset:${item_.id}` })}>
                    <AgentMark id={item_.id} name={item_.name} size={34} />
                    <span>{item_.name}</span>
                  </button>)}
                  <button type="button" className="preset preset--custom" disabled={Boolean(pending)} title="上传图片"
                    onClick={() => { setAvatarFor(item.id); avatarInput.current?.click(); }}>
                    <span className="agent-mark agent-mark--upload"><ImagePlus size={16} aria-hidden="true" /></span>
                    <span>上传</span>
                  </button>
                </div>
              </div>
            </div> : null}
            <div className="token-detail__foot">
              <button type="button" className="account-icon-btn" title={editing === item.id ? `完成编辑「${item.name}」` : `编辑身份「${item.name}」`} aria-label={editing === item.id ? `完成编辑「${item.name}」` : `编辑身份「${item.name}」`} disabled={Boolean(pending)}
                onClick={() => { setEditing(editing === item.id ? "" : item.id); setDraft(item.displayName || item.name); }}>
                <Pencil size={14} aria-hidden="true" />
              </button>
              <button type="button" className="account-icon-btn" title={`撤销令牌「${item.name}」`} aria-label={`撤销令牌「${item.name}」`} disabled={Boolean(pending)} onClick={() => setConfirming(item.id)}>
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
          </div> : null}
        </li>;
      })}
    </ul> : null}
    {!loading && !error && !items.length && !secret && !creating ? <div className="account-token-empty">
      <p>还没有令牌</p>
      <button type="button" className="btn btn--primary" disabled={Boolean(pending)} onClick={() => setCreating(true)}>新建令牌</button>
    </div> : null}
    {secret ? <section className="account-secret" aria-label="新令牌">
      <div className="account-secret__head">
        <strong>{secret.name}</strong>
        <span className="account-muted">新令牌</span>
      </div>
      <div className="account-secret__line">
        <input className="account-secret__value" aria-label="令牌" value={secret.value} readOnly spellCheck={false} onFocus={(event) => event.target.select()} />
        <button type="button" className="account-icon-btn" aria-label="复制令牌" onClick={() => void copy()}><Copy size={14} aria-hidden="true" /></button>
      </div>
      <div className="account-secret__foot">
        <span className="account-muted">令牌只显示这一次，请妥善保存。</span>
        <button type="button" className="btn" onClick={() => { setSecret(null); setNotice(""); }}>已保存</button>
      </div>
    </section> : creating ? <form className="create-block" onSubmit={(event) => void create(event)}>
      <div className="account-field">
        <span className="account-field__label">Agent 头像</span>
        <div className="presets" role="radiogroup" aria-label="头像预设">
          {AVATAR_PRESETS.map((item) => <button type="button" key={item.id}
            className={`preset${preset === item.id && !customFile ? " is-on" : ""}`}
            disabled={Boolean(pending)} title={item.name}
            onClick={() => { setPreset(preset === item.id ? "" : item.id); setCustomFile(null); if (preset !== item.id) setDisplayName(item.name); }}>
            <AgentMark id={item.id} name={item.name} size={34} />
            <span>{item.name}</span>
          </button>)}
          <button type="button" className={`preset preset--custom${customFile ? " is-on" : ""}`} disabled={Boolean(pending)} title="上传图片"
            onClick={() => fileInput.current?.click()}>
            <span className="agent-mark agent-mark--upload"><ImagePlus size={16} aria-hidden="true" /></span>
            <span>{customFile ? customFile.name.slice(0, 12) : "上传"}</span>
          </button>
          <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" hidden
            onChange={(event) => { setCustomFile(event.target.files?.[0] ?? null); if (event.target.files?.[0]) setPreset(""); event.target.value = ""; }} />
        </div>
      </div>
      <div className="create-block__row">
        <label className="account-field create-block__name">名称
          <input name="tokenName" placeholder="如：我的 Agent" value={name} onChange={(event) => setName(event.target.value)} required disabled={Boolean(pending)} maxLength={100} autoFocus />
        </label>
        <label className="account-field create-block__name">显示名
          <input name="tokenDisplayName" placeholder="署名显示的名字" value={displayName} onChange={(event) => setDisplayName(event.target.value)} disabled={Boolean(pending)} maxLength={100} />
        </label>
      </div>
      <div className="create-block__row">
        <div className="account-field">
          <span className="account-field__label">权限</span>
          <div className="seg" role="radiogroup" aria-label="权限">
            <button type="button" role="radio" aria-checked={access === "read"} className={access === "read" ? "is-on" : ""} disabled={Boolean(pending)} onClick={() => setAccess("read")}>只读</button>
            <button type="button" role="radio" aria-checked={access === "write"} className={access === "write" ? "is-on" : ""} disabled={Boolean(pending)} onClick={() => setAccess("write")}>读写</button>
          </div>
        </div>
      </div>
      <div className="create-block__foot">
        <button type="button" className="btn" disabled={Boolean(pending)} onClick={() => setCreating(false)}>取消</button>
        <button type="submit" className="btn btn--primary" disabled={Boolean(pending) || !name.trim()}>{pending === "create" ? "创建中…" : "创建"}</button>
      </div>
    </form> : items.length ? <button type="button" className="account-token-new" disabled={Boolean(pending)} onClick={() => { setCreating(true); setOpen(""); }}>
      <Plus size={15} aria-hidden="true" />新建令牌
    </button> : null}
    <input ref={avatarInput} type="file" accept="image/jpeg,image/png,image/webp" hidden
      onChange={(event) => { const file = event.target.files?.[0]; const item = items.find((t) => t.id === avatarFor); if (file && item) void uploadAvatar(item, file); event.target.value = ""; }} />
    {notice ? <p className="account-muted" role="status">{notice}</p> : null}
  </>;
}
