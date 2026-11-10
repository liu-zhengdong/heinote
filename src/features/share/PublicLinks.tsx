import { Copy, ExternalLink, Link } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "../account/api";
import { ListStatus } from "../account/ListStatus";
import { formatDate, useAccountList } from "../account/useAccountList";

interface PublicLink { id: string; url: string; createdAt: string }

export function PublicLinks({ pageId }: { pageId: string }) {
  const { items, setItems, loading, error, setError, retry } = useAccountList<PublicLink>(`/api/shares?pageId=${encodeURIComponent(pageId)}`);
  const [pending, setPending] = useState("");
  const [confirming, setConfirming] = useState("");
  const [notice, setNotice] = useState("");
  const [copyFallback, setCopyFallback] = useState("");
  const create = async () => {
    if (pending) return;
    setPending("create");
    setError("");
    setNotice("");
    try {
      const link = await api<PublicLink>("/api/shares", { method: "POST", body: JSON.stringify({ pageId }) });
      setItems((current) => [...current, link]);
      setNotice("公开链接已创建");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setPending(""); }
  };
  const revoke = async (link: PublicLink) => {
    if (pending) return;
    setPending(link.id);
    setError("");
    setNotice("");
    try {
      await api(`/api/shares/${encodeURIComponent(link.id)}`, { method: "DELETE" });
      setItems((current) => current.filter((item) => item.id !== link.id));
      setConfirming("");
      setCopyFallback("");
      setNotice("公开链接已撤销");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setPending(""); }
  };
  const copy = async (url: string) => {
    const absolute = new URL(url, window.location.origin).href;
    try { await navigator.clipboard.writeText(absolute); setCopyFallback(""); setNotice("链接已复制"); }
    catch { setCopyFallback(absolute); setNotice("复制失败，请选中链接复制"); }
  };
  return <section className="public-links" aria-label="公开链接" aria-busy={loading || Boolean(pending)}>
    <div className="public-links__head">
      <h2><Link size={15} aria-hidden="true" />公开链接</h2>
      <button type="button" className="btn btn--outline" disabled={loading || Boolean(pending)} onClick={() => void create()}>
        {pending === "create" ? "创建中…" : "创建链接"}
      </button>
    </div>
    <p className="account-muted">获得链接的人可以阅读此页及其子页。</p>
    <ListStatus loading={loading} error={error} retry={retry} empty={!items.length} emptyText="暂无公开链接" />
    <ul className="account-list" aria-label="此页的公开链接">
      {items.map((item) => <li className="account-row account-row--wrap" key={item.id}>
        <span className="account-row__text">
          <a className="public-links__url" href={item.url} target="_blank" rel="noopener noreferrer">{item.url}<ExternalLink size={12} aria-hidden="true" /></a>
          <small>创建于 {formatDate(item.createdAt)}</small>
        </span>
        <div className="account-row__actions">
          {confirming === item.id ? <>
            <button type="button" className="btn" disabled={Boolean(pending)} onClick={() => setConfirming("")}>取消</button>
            <button type="button" className="btn btn--danger" aria-label={`确认撤销公开链接 ${item.url}`} disabled={Boolean(pending)} onClick={() => void revoke(item)}>{pending === item.id ? "撤销中…" : "确认撤销"}</button>
          </> : <>
            <button type="button" className="btn" disabled={Boolean(pending)} aria-label={`复制公开链接 ${item.url}`} onClick={() => void copy(item.url)}><Copy size={14} />复制</button>
            <button type="button" className="btn btn--danger" disabled={Boolean(pending)} aria-label={`撤销公开链接 ${item.url}`} onClick={() => setConfirming(item.id)}>撤销</button>
          </>}
        </div>
      </li>)}
    </ul>
    {copyFallback ? <label className="account-field">链接<input value={copyFallback} readOnly autoFocus onFocus={(event) => event.target.select()} /></label> : null}
    {notice ? <p className="account-muted" role="status">{notice}</p> : null}
  </section>;
}
