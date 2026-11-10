import { Copy, KeyRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { AccountPanelProps } from "./AccountMenu";
import { api, errorMessage } from "./api";
import { ListStatus } from "./ListStatus";
import { formatDate, useAccountList } from "./useAccountList";

interface AgentToken {
  id: string;
  name: string;
  access: "read" | "write";
  createdAt: string;
  lastUsedAt: string | null;
}

export function AgentTokens({ onBusyChange }: AccountPanelProps) {
  const { items, setItems, loading, error, setError, retry } = useAccountList<AgentToken>("/api/tokens");
  const [name, setName] = useState("");
  const [access, setAccess] = useState<AgentToken["access"]>("read");
  const [secret, setSecret] = useState<{ value: string; name: string } | null>(null);
  const [pending, setPending] = useState("");
  const [confirming, setConfirming] = useState("");
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
    } catch (reason) { setError(errorMessage(reason)); }
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
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setPending(""); onBusyChange(false); }
  };

  const copy = async () => {
    if (!secret) return;
    try { await navigator.clipboard.writeText(secret.value); setNotice("已复制令牌"); }
    catch { setNotice("复制失败，请选中令牌复制"); }
  };

  return <>
    <p className="account-muted">令牌供 Agent 调用 API，权限受你的空间角色限制。</p>
    {secret ? <section className="account-secret" aria-label="新令牌">
      <strong>{secret.name}</strong>
      <p className="account-muted">令牌只显示这一次，请妥善保存。</p>
      <label className="account-field">令牌
        <input className="account-secret__value" value={secret.value} readOnly spellCheck={false} onFocus={(event) => event.target.select()} />
      </label>
      <div className="account-row__actions">
        <button type="button" className="btn btn--outline" onClick={() => void copy()}><Copy size={14} />复制</button>
        <button type="button" className="btn" onClick={() => { setSecret(null); setNotice(""); }}>已保存</button>
      </div>
    </section> : <form className="account-token-form" onSubmit={(event) => void create(event)}>
      <label className="account-field account-token-form__name">名称
        <input name="tokenName" placeholder="如：我的 Agent" value={name} onChange={(event) => setName(event.target.value)} required disabled={Boolean(pending) || loading} maxLength={100} />
      </label>
      <label className="account-field">权限
        <select className="account-select" value={access} disabled={Boolean(pending) || loading} onChange={(event) => setAccess(event.target.value as AgentToken["access"])}>
          <option value="read">只读</option><option value="write">读写</option>
        </select>
      </label>
      <button type="submit" className="btn btn--primary" disabled={Boolean(pending) || loading || !name.trim()}>{pending === "create" ? "创建中…" : "创建"}</button>
    </form>}
    <ListStatus loading={loading} error={error} retry={retry} empty={!items.length} emptyText="暂无令牌" />
    {notice ? <p className="account-muted" role="status">{notice}</p> : null}
    <ul className="account-list" aria-label="Agent 令牌" aria-busy={loading || Boolean(pending)}>
      {items.map((item) => <li className="account-row account-row--wrap" key={item.id}>
        <KeyRound size={17} className="account-row__icon" aria-hidden="true" />
        <span className="account-row__text"><strong>{item.name}</strong>
          <small>{item.access === "write" ? "读写" : "只读"} · 创建于 {formatDate(item.createdAt)}</small>
          <small>最近使用：{formatDate(item.lastUsedAt)}</small>
        </span>
        {confirming === item.id ? <div className="account-row__actions">
          <button type="button" className="btn" disabled={Boolean(pending)} onClick={() => setConfirming("")}>取消</button>
          <button type="button" className="btn btn--danger" aria-label={`确认撤销令牌「${item.name}」`} disabled={Boolean(pending)} onClick={() => void revoke(item)}>
            {pending === item.id ? "撤销中…" : "确认撤销"}
          </button>
        </div> : <button type="button" className="btn btn--danger" aria-label={`撤销令牌「${item.name}」`} disabled={Boolean(pending)} onClick={() => setConfirming(item.id)}>撤销</button>}
      </li>)}
    </ul>
  </>;
}
