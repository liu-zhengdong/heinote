import { useState } from "react";
import { Select } from "../../components/Select";
import { personName, ProfileAvatar } from "../../components/ProfileAvatar";
import { useSession, type SessionUser } from "./AuthGate";
import type { AccountPanelProps } from "./account-panel";
import { api, ApiError, errorMessage } from "./api";
import { useAccountList } from "./useAccountList";
import { ListStatus } from "./ListStatus";

export function AdminUsers({ onBusyChange, active }: AccountPanelProps) {
  const { user, refresh } = useSession();
  const { items, setItems, loading, error, setError, retry } = useAccountList<SessionUser>("/api/admin/users", active);
  const [pending, setPending] = useState("");
  const changeRole = async (target: SessionUser, siteRole: SessionUser["siteRole"]) => {
    if (pending || target.siteRole === siteRole) return;
    setPending(target.id);
    onBusyChange(true);
    setError("");
    try {
      await api(`/api/admin/users/${encodeURIComponent(target.id)}`, { method: "PATCH", body: JSON.stringify({ siteRole }) });
      setItems((current) => current.map((item) => item.id === target.id ? { ...item, siteRole } : item));
      if (target.id === user?.id) await refresh();
    } catch (reason) {
      setError(errorMessage(reason));
      if (reason instanceof ApiError && reason.status === 403) await refresh().catch(() => undefined);
      else if (!(reason instanceof ApiError) || reason.status >= 500) retry();
    } finally { setPending(""); onBusyChange(false); }
  };
  return <>
    <p className="account-muted">站点管理员管理账号，不自动获得笔记权限。</p>
    <ListStatus loading={loading} error={error} retry={retry} empty={!items.length} emptyText="暂无账号" />
    <ul className="account-list" aria-label="站点账号" aria-busy={loading || Boolean(pending)}>
      {items.map((item) => <li className="account-row" key={item.id}>
        <ProfileAvatar src={item.avatarUrl} name={personName(item)} size={28} />
        <span className="account-row__text"><strong>{personName(item)}{item.id === user?.id ? "（我）" : ""}</strong><small>@{item.handle}</small></span>
        <Select className="account-select" aria-label={`${personName(item)}的站点角色`} value={item.siteRole} disabled={Boolean(pending)}
          onValueChange={(siteRole) => void changeRole(item, siteRole)}
          options={[{ value: "user", label: "用户" }, { value: "admin", label: "管理员" }]} />
      </li>)}
    </ul>
  </>;
}
