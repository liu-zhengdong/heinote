import { useState } from "react";
import type { SpaceRole } from "../../core/types";
import type { AccountPanelProps } from "./AccountMenu";
import { api, errorMessage } from "./api";
import { ListStatus } from "./ListStatus";
import { formatDate, useAccountList } from "./useAccountList";

interface Invitation {
  id: string;
  spaceId: string;
  spaceName: string;
  role: Exclude<SpaceRole, "owner">;
  inviter: string;
  expiresAt: string;
}
const roles = { admin: "管理", editor: "编辑", viewer: "只读" };

export function Invitations({ onBusyChange }: AccountPanelProps) {
  const { items, setItems, loading, error, setError, retry } = useAccountList<Invitation>("/api/invitations");
  const [pending, setPending] = useState("");
  const [notice, setNotice] = useState("");
  const answer = async (invitation: Invitation, accept: boolean) => {
    if (pending) return;
    setPending(invitation.id);
    onBusyChange(true);
    setError("");
    setNotice("");
    try {
      await api(`/api/invitations/${encodeURIComponent(invitation.id)}`, { method: "POST", body: JSON.stringify({ accept }) });
      setItems((current) => current.filter((item) => item.id !== invitation.id));
      setNotice(accept ? `已加入「${invitation.spaceName}」` : "已拒绝邀请");
      if (accept) window.dispatchEvent(new Event("notes:spaces-changed"));
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setPending(""); onBusyChange(false); }
  };
  return <>
    <ListStatus loading={loading} error={error} retry={retry} empty={!items.length} emptyText="暂无邀请" />
    {notice ? <p className="account-muted" role="status">{notice}</p> : null}
    <ul className="account-list" aria-label="空间邀请" aria-busy={loading || Boolean(pending)}>
      {items.map((item) => {
        const expired = Date.parse(item.expiresAt) <= Date.now();
        return <li className="account-row account-row--wrap" key={item.id}>
          <span className="account-row__text"><strong>{item.spaceName}</strong>
            <small>{item.inviter} · {roles[item.role] ?? item.role}</small>
            <small>{expired ? "已过期" : `有效至 ${formatDate(item.expiresAt)}`}</small>
          </span>
          <div className="account-row__actions">
            <button type="button" className="btn" aria-label={`拒绝「${item.spaceName}」的邀请`} disabled={Boolean(pending)} onClick={() => void answer(item, false)}>拒绝</button>
            <button type="button" className="btn btn--primary" aria-label={`接受「${item.spaceName}」的邀请`} disabled={expired || Boolean(pending)} onClick={() => void answer(item, true)}>
              {pending === item.id ? "处理中…" : "接受"}
            </button>
          </div>
        </li>;
      })}
    </ul>
  </>;
}
