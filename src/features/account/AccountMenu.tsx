import { LogOut, UserRound, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Modal } from "../../components/Modal";
import { Select } from "../../components/Select";
import { useWorkspace } from "../../app/workspace-context";
import { personName, ProfileAvatar } from "../../components/ProfileAvatar";
import { useSession } from "./AuthGate";
import { api, errorMessage } from "./api";
import { Invitations } from "./Invitations";
import { AgentTokens } from "./AgentTokens";
import { useAccountList } from "./useAccountList";
import { ListStatus } from "./ListStatus";
import type { SessionUser } from "./AuthGate";

export interface AccountPanelProps { onBusyChange(busy: boolean): void }
type Tab = "invitations" | "tokens" | "users";

export function AccountMenu({ compact = false }: { compact?: boolean }) {
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  if (!user) return null;
  return (
    <div className={`account-entry${compact ? " account-entry--compact" : ""}`}>
      <button type="button" className="account-entry__button" aria-label={`账号：${personName(user)}`} title={`账号：${personName(user)}`}
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <UserRound size={18} aria-hidden="true" />
        <span className="account-entry__name">{personName(user)}</span>
      </button>
      {open ? <AccountDialog onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

function AccountDialog({ onClose }: { onClose(): void }) {
  const { user, logout } = useSession();
  const { document: workspaceDocument } = useWorkspace();
  const [tab, setTab] = useState<Tab>("invitations");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scopeRef = useRef<HTMLDivElement>(null);
  const tabId = useId();
  const effectiveTab = tab === "users" && user?.siteRole !== "admin" ? "invitations" : tab;
  const tabs: { id: Tab; label: string }[] = [
    { id: "invitations", label: "邀请" }, { id: "tokens", label: "Agent 令牌" },
    ...(user?.siteRole === "admin" ? [{ id: "users" as const, label: "账号管理" }] : []),
  ];

  useEffect(() => {
    const previous = document.activeElement;
    scopeRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const controls = Array.from(scopeRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
    ) ?? []).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };

  const signOut = async () => {
    setBusy(true);
    setError("");
    try { await workspaceDocument?.flush(); await logout(); }
    catch (reason) { setError(errorMessage(reason)); setBusy(false); }
  };

  return (
    <Modal open label="账号" className="account-dialog" onClose={() => { if (!busy) onClose(); }}>
      <div ref={scopeRef} className="account-dialog__scope" onKeyDown={trapFocus}>
        <header className="account-dialog__head">
          <div className="account-identity">
            {user ? <ProfileAvatar src={user.avatarUrl} name={personName(user)} size={32} /> : null}
            <span className="account-row__text"><strong>{user ? personName(user) : "账号"}</strong><small>@{user?.handle}</small></span>
          </div>
          <button type="button" className="icon-btn" aria-label="关闭账号" disabled={busy} onClick={onClose}><X size={18} /></button>
        </header>
        <div className="account-tabs" role="tablist" aria-label="账号设置">
          {tabs.map((item, index) => <button type="button" key={item.id} role="tab" id={`${tabId}-${item.id}`}
            aria-selected={effectiveTab === item.id} aria-controls={`${tabId}-panel`} tabIndex={effectiveTab === item.id ? 0 : -1}
            className="account-tabs__tab" disabled={busy} onClick={() => setTab(item.id)}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
                : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
              setTab(tabs[next].id);
              document.getElementById(`${tabId}-${tabs[next].id}`)?.focus();
            }}>{item.label}</button>)}
        </div>
        <section className="account-dialog__body" role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${effectiveTab}`} tabIndex={0}>
          {effectiveTab === "invitations" ? <Invitations onBusyChange={setBusy} />
            : effectiveTab === "tokens" ? <AgentTokens onBusyChange={setBusy} />
            : <AdminUsers onBusyChange={setBusy} />}
        </section>
        <footer className="account-dialog__foot">
          {error ? <p className="account-error" role="alert">{error}</p> : null}
          <button type="button" className="btn" disabled={busy} onClick={() => void signOut()}><LogOut size={15} />退出登录</button>
        </footer>
      </div>
    </Modal>
  );
}

function AdminUsers({ onBusyChange }: AccountPanelProps) {
  const { user, refresh } = useSession();
  const { items, setItems, loading, error, setError, retry } = useAccountList<SessionUser>("/api/admin/users");
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
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setPending(""); onBusyChange(false); }
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
