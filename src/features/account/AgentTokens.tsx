import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Select } from "../../components/Select";
import type { AccountPanelProps, TokenSecret } from "./account-panel";
import { api, ApiError, errorMessage } from "./api";
import { ListStatus } from "./ListStatus";
import { formatDate, useAccountList } from "./useAccountList";

interface AgentToken {
  id: string;
  name: string;
  access: "read" | "write";
  createdAt: string;
  lastUsedAt: string | null;
}

export function AgentTokens({ onBusyChange, active, secret, onSecretChange: setSecret }: AccountPanelProps & {
  secret: TokenSecret | null;
  onSecretChange(secret: TokenSecret | null): void;
}) {
  const { items, setItems, loading, error, setError, retry } = useAccountList<AgentToken>("/api/tokens", active);
  const accessId = useId();
  const [name, setName] = useState("");
  const [access, setAccess] = useState<AgentToken["access"]>("read");
  const [pending, setPending] = useState("");
  const [confirming, setConfirming] = useState("");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || secret || !name.trim()) return;
    setPending("create");
    onBusyChange(true);
    setError("");
    setNotice("");
    try {
      const created = await api<AgentToken & { token: string }>("/api/tokens", {
        method: "POST", body: JSON.stringify({ name: name.trim(), access }),
      });
      setSecret({ value: created.token, name: created.name });
      const { token: _token, ...metadata } = created;
      setItems((current) => [metadata, ...current]);
      setName("");
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
    <p className="account-muted">令牌供 Agent 调用 API，权限受你的空间角色限制。</p>
    <ListStatus loading={loading} error={error} retry={retry} empty={false} emptyText="" />
    {items.length ? <ul className="account-token-list" aria-label="Agent 令牌" aria-busy={loading || Boolean(pending)}>
      {items.map((item) => <li className={`account-token${confirming === item.id ? " is-confirming" : ""}`} key={item.id}>
        <KeyRound size={15} className="account-token__icon" aria-hidden="true" />
        <span className="account-token__name">{item.name}</span>
        <span className="tag account-token__tag">{item.access === "write" ? "读写" : "只读"}</span>
        <span className="account-token__time">创建于 {formatDate(item.createdAt)} · {item.lastUsedAt ? `最近使用 ${formatDate(item.lastUsedAt)}` : "未使用"}</span>
        {confirming === item.id ? <div className="account-token__confirm">
          <span className="account-token__prompt">撤销？</span>
          <button type="button" className="btn" disabled={Boolean(pending)} onClick={() => setConfirming("")}>取消</button>
          <button type="button" className="btn btn--danger" aria-label={`确认撤销令牌「${item.name}」`} disabled={Boolean(pending)} onClick={() => void revoke(item)}>
            {pending === item.id ? "撤销中…" : "确认撤销"}
          </button>
        </div> : <button type="button" className="account-icon-btn account-token__revoke" aria-label={`撤销令牌「${item.name}」`} disabled={Boolean(pending)} onClick={() => setConfirming(item.id)}>
          <Trash2 size={14} aria-hidden="true" />
        </button>}
      </li>)}
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
    </section> : creating ? <form className="account-token-form" onSubmit={(event) => void create(event)}>
      <label className="account-field account-token-form__name">名称
        <input name="tokenName" placeholder="如：我的 Agent" value={name} onChange={(event) => setName(event.target.value)} required disabled={Boolean(pending) || loading} maxLength={100} autoFocus />
      </label>
      <div className="account-field">
        <label htmlFor={accessId}>权限</label>
        <Select id={accessId} className="account-select" aria-label="权限" size="field"
          value={access} disabled={Boolean(pending) || loading} onValueChange={setAccess}
          options={[{ value: "read", label: "只读" }, { value: "write", label: "读写" }]} />
      </div>
      <button type="button" className="btn" disabled={Boolean(pending)} onClick={() => setCreating(false)}>取消</button>
      <button type="submit" className="btn btn--primary" disabled={Boolean(pending) || loading || !name.trim()}>{pending === "create" ? "创建中…" : "创建"}</button>
    </form> : items.length ? <button type="button" className="account-token-new" disabled={Boolean(pending)} onClick={() => setCreating(true)}>
      <Plus size={15} aria-hidden="true" />新建令牌
    </button> : null}
    {notice ? <p className="account-muted" role="status">{notice}</p> : null}
  </>;
}
