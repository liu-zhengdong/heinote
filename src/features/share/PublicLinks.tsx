import { Copy, ExternalLink, Link, Plus } from "lucide-react";
import { useState } from "react";
import { useUi } from "../../app/ui-context";
import { api, errorMessage } from "../account/api";
import { ListStatus } from "../account/ListStatus";
import { formatDate, useAccountList } from "../account/useAccountList";

interface PublicLink { id: string; url: string; createdAt: string }

export function PublicLinks({ pageId }: { pageId: string }) {
  const { items, setItems, loading, error, setError, retry } = useAccountList<PublicLink>(`/api/shares?pageId=${encodeURIComponent(pageId)}`);
  const { toast } = useUi();
  const [pending, setPending] = useState("");
  const [confirming, setConfirming] = useState("");
  const create = async () => {
    if (pending) return;
    setPending("create");
    setError("");
    try {
      const link = await api<PublicLink>("/api/shares", { method: "POST", body: JSON.stringify({ pageId }) });
      setItems((current) => [...current, link]);
      toast("公开链接已创建", "success");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setPending(""); }
  };
  const revoke = async (link: PublicLink) => {
    if (pending) return;
    setPending(link.id);
    setError("");
    try {
      await api(`/api/shares/${encodeURIComponent(link.id)}`, { method: "DELETE" });
      setItems((current) => current.filter((item) => item.id !== link.id));
      setConfirming("");
      toast("公开链接已撤销", "success");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setPending(""); }
  };
  const copy = async (url: string) => {
    const absolute = new URL(url, window.location.origin).href;
    try { await navigator.clipboard.writeText(absolute); toast("链接已复制", "success"); }
    catch { toast("复制失败，请选中地址手动复制", "error"); }
  };
  return <section className="public-links" aria-label="公开链接" aria-busy={loading || Boolean(pending)}>
    <div className="public-links__head">
      <div>
        <h2><Link size={15} aria-hidden="true" />公开链接</h2>
        <p className="public-links__description">获得链接的人可以阅读此页及其子页。</p>
      </div>
      <button type="button" className="btn public-links__create" disabled={loading || Boolean(pending)} onClick={() => void create()}>
        <Plus size={14} aria-hidden="true" />{pending === "create" ? "创建中…" : "创建链接"}
      </button>
    </div>
    <ListStatus loading={loading} error={error} retry={retry} empty={!items.length} emptyText="暂无公开链接" />
    <ul className="public-links__list" aria-label="此页的公开链接">
      {items.map((item) => {
        const absolute = new URL(item.url, window.location.origin).href;
        return <li className="public-links__item" key={item.id}>
          <div className="public-links__address">
            <input className="public-links__input" aria-label="公开链接地址" title={absolute} value={absolute} readOnly onFocus={(event) => event.target.select()} />
            <a className="icon-btn public-links__url" href={absolute} target="_blank" rel="noopener noreferrer" aria-label={`打开公开链接 ${absolute}`} title="在新标签页打开"><ExternalLink size={14} aria-hidden="true" /></a>
            <button type="button" className="btn public-links__copy" disabled={Boolean(pending)} aria-label={`复制公开链接 ${item.url}`} onClick={() => void copy(absolute)}><Copy size={14} aria-hidden="true" />复制</button>
          </div>
          <div className="public-links__meta">
            <small>创建于 {formatDate(item.createdAt)}</small>
            {confirming !== item.id ? <button type="button" className="btn public-links__revoke" disabled={Boolean(pending)} aria-label={`撤销公开链接 ${item.url}`} onClick={() => setConfirming(item.id)}>撤销</button> : null}
          </div>
          {confirming === item.id ? <div className="public-links__confirm">
            <p>撤销后，原链接将无法访问。</p>
            <button type="button" className="btn" disabled={Boolean(pending)} onClick={() => setConfirming("")}>取消</button>
            <button type="button" className="btn btn--danger" aria-label={`确认撤销公开链接 ${item.url}`} disabled={Boolean(pending)} onClick={() => void revoke(item)}>{pending === item.id ? "撤销中…" : "确认撤销"}</button>
          </div> : null}
        </li>;
      })}
    </ul>
  </section>;
}
