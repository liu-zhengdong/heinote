import { Archive, ChevronLeft, Inbox, KeyRound, LogOut, Search, Settings2, ShieldCheck, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Modal } from "../../components/Modal";
import { personName, ProfileAvatar } from "../../components/ProfileAvatar";
import { useWorkspace } from "../../app/workspace-context";
import { githubMessages, type GithubResult } from "../../core/github-auth";
import { useSession } from "./AuthGate";
import { useUi } from "../../app/ui-context";
import { errorMessage } from "./api";
import type { TokenSecret } from "./account-panel";
import { ProfileSettings } from "./ProfileSettings";
import { PreferenceSettings } from "./PreferenceSettings";
import { Invitations } from "./Invitations";
import { AgentTokens } from "./AgentTokens";
import { DataExport } from "./DataExport";
import { GithubLoginMethods } from "./GithubLoginMethods";
import "./settings.css";

type SectionId = "profile" | "preferences" | "invitations" | "tokens" | "data" | "users";
type Action = { type: "section"; id: SectionId; target?: string } | { type: "close" | "logout" | "back" } | { type: "external"; run(): void };
type Confirmation = { kind: "secret" | "draft"; action: Action };
const sections = [
  { id: "profile", label: "我的账号", title: "账号", group: "账号", description: "管理你的资料和登录方式。", icon: null,
    fields: [{ name: "显示名 名字 资料 用户名 profile", target: "displayName" }, { name: "头像 照片 上传 更换 移除 avatar photo", target: "avatar" }, { name: "登录方式 GitHub 绑定", target: "methods" }] },
  { id: "preferences", label: "偏好", title: "偏好", group: "账号", description: "调整 Notes 的显示方式。", icon: Settings2,
    fields: [{ name: "外观 主题 浅色 深色 跟随系统 theme", target: "theme" }] },
  { id: "invitations", label: "邀请", title: "邀请", group: "功能", description: "查看和处理空间邀请。", icon: Inbox,
    fields: [{ name: "邀请 空间 接受 拒绝", target: "invitations" }] },
  { id: "tokens", label: "Agent 令牌", title: "Agent 令牌", group: "功能", description: "管理 Agent 调用 Notes API 的访问凭据。", icon: KeyRound,
    fields: [{ name: "令牌 token API 权限 名称 接入", target: "tokens" }] },
  { id: "data", label: "数据", title: "数据", group: "功能", description: "把你的笔记打包带走。", icon: Archive,
    fields: [{ name: "导出 备份 zip Markdown 数据 下载 export backup 导入 Obsidian Notion 迁移 import", target: "export-download" }] },
  { id: "users", label: "后台管理", title: "后台管理", group: "站点管理", description: "管理站点用户、团队知识库与存储限额。", icon: ShieldCheck,
    fields: [{ name: "管理员 用户 角色 站点 限额 存储 后台 admin", target: "users" }] },
] satisfies { id: SectionId; label: string; title: string; group: string; description: string; icon: typeof Inbox | null; fields: { name: string; target: string }[] }[];
const exitsSettings = (action: Action) => action.type === "close" || action.type === "logout" || action.type === "external";

export function AccountSettings({ onClose, notice }: { onClose(): void; notice: GithubResult | null }) {
  const { user, logout, refresh } = useSession();
  const { setAdminOpen } = useUi();
  const { document: workspaceDocument, selectPage } = useWorkspace();
  const [section, setSection] = useState<SectionId>("profile");
  const [visited, setVisited] = useState<SectionId[]>(["profile"]);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [secret, setSecret] = useState<TokenSecret | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 719px)").matches);
  const [mobileDetail, setMobileDetail] = useState(Boolean(notice));
  const scope = useRef<HTMLDivElement>(null);
  const prompt = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const id = useId();
  const current = section === "users" && user?.siteRole !== "admin" ? "profile" : section;
  const available = sections.filter((item) => item.id !== "users" || user?.siteRole === "admin");
  const search = query.trim().toLocaleLowerCase();
  const matches = available.filter((item) => `${item.label} ${item.title} ${item.fields.map((field) => field.name).join(" ")}`.toLocaleLowerCase().includes(search));
  const selected = sections.find((item) => item.id === current)!;

  useEffect(() => {
    const media = window.matchMedia("(max-width: 719px)");
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const previous = document.activeElement;
    const frame = requestAnimationFrame(() => {
      const initial = scope.current?.querySelector<HTMLElement>('[aria-selected="true"]')
        ?? scope.current?.querySelector<HTMLElement>('input[type="search"]');
      initial?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (section === "users" && user?.siteRole !== "admin") setSection("profile");
  }, [section, user?.siteRole]);

  useEffect(() => {
    if (!confirmation) return;
    const previous = document.activeElement;
    prompt.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [confirmation]);

  useEffect(() => {
    const checkSession = () => { void refresh().catch(() => undefined); };
    window.addEventListener("focus", checkSession);
    return () => window.removeEventListener("focus", checkSession);
  }, [refresh]);

  const navigate = (next: SectionId, target?: string) => {
    setSection(next);
    setVisited((old) => old.includes(next) ? old : [...old, next]);
    setMobileDetail(true);
    content.current?.scrollTo({ top: 0 });
    requestAnimationFrame(() => {
      if (!scope.current) return;
      const destination = target ? scope.current.querySelector<HTMLElement>(`[data-setting="${target}"]`) : null;
      if (destination) { destination.scrollIntoView({ block: "nearest" }); destination.focus(); }
      else if (narrow) content.current?.querySelector<HTMLElement>("h1")?.focus();
    });
  };

  const perform = (action: Action) => {
    if (action.type === "section") navigate(action.id, action.target);
    else if (action.type === "back") {
      setMobileDetail(false);
      requestAnimationFrame(() => scope.current?.querySelector<HTMLElement>(`#${CSS.escape(`${id}-nav-${current}`)}`)?.focus());
    } else if (action.type === "close") onClose();
    else if (action.type === "external") action.run();
    else {
      setBusy(true);
      setError("");
      void (async () => { await workspaceDocument?.flush(); await logout(); })()
        .catch((reason) => { setError(errorMessage(reason)); setBusy(false); });
    }
  };

  const request = (action: Action) => {
    if (busy) return;
    if (secret && (action.type !== "section" || action.id !== "tokens")) setConfirmation({ kind: "secret", action });
    else if (dirty && exitsSettings(action)) setConfirmation({ kind: "draft", action });
    else perform(action);
  };
  const confirmLeave = () => {
    if (!confirmation) return;
    if (confirmation.kind === "secret") {
      setSecret(null);
      if (dirty && exitsSettings(confirmation.action)) {
        setConfirmation({ kind: "draft", action: confirmation.action });
        return;
      }
    }
    const action = confirmation.action;
    setConfirmation(null);
    perform(action);
  };
  const cancelLeave = () => {
    const wasDraft = confirmation?.kind === "draft";
    setConfirmation(null);
    if (wasDraft) navigate("profile", "displayName");
  };
  const close = () => { if (confirmation) cancelLeave(); else request({ type: "close" }); };

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const root = prompt.current ?? scope.current;
    const controls = Array.from(root?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]') ?? [])
      .filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0 && !element.closest("[inert]"));
    const first = controls[0]; const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };

  const navigateKey = (event: KeyboardEvent, index: number) => {
    if (narrow || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? matches.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
    request({ type: "section", id: matches[next].id });
    scope.current?.querySelector<HTMLElement>(`#${CSS.escape(`${id}-nav-${matches[next].id}`)}`)?.focus();
  };

  if (!user) return null;
  return <Modal open label="账号设置" className="account-settings" onClose={close}>
    <div className="settings-scope" ref={scope} onKeyDown={trapFocus}>
      <div className="settings-layout" data-detail={mobileDetail} inert={confirmation ? true : undefined}>
        <aside className="settings-nav">
          <h1 className="settings-nav__title">设置</h1>
          <div className="settings-search">
            <Search size={15} aria-hidden="true" />
            <input type="search" placeholder="搜索设置" aria-label="搜索设置" value={query} disabled={busy}
              onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
                if (event.key === "Enter" && matches[0]) request({ type: "section", id: matches[0].id, target: matches[0].fields.find((field) => field.name.toLocaleLowerCase().includes(search))?.target });
              }} />
            {query ? <button type="button" aria-label="清空搜索" onClick={() => setQuery("")}><X size={13} /></button> : null}
          </div>
          <div className="settings-nav__items" role={narrow ? "navigation" : "tablist"} aria-label="账号设置分类" aria-orientation={narrow ? undefined : "vertical"}>
            {matches.map((item, index) => {
              const Icon = item.icon;
              const groupStart = index === 0 || matches[index - 1].group !== item.group;
              const target = search ? item.fields.find((field) => field.name.toLocaleLowerCase().includes(search))?.target : undefined;
              return <div key={item.id}>
                {groupStart ? <div className="settings-nav__group">{item.group}</div> : null}
                <button type="button" id={`${id}-nav-${item.id}`} role={narrow ? undefined : "tab"} aria-label={item.label}
                  aria-selected={narrow ? undefined : current === item.id} aria-current={narrow && current === item.id ? "page" : undefined}
                  aria-controls={`${id}-panel-${item.id}`} disabled={busy}
                  tabIndex={narrow || current === item.id || (!matches.some((entry) => entry.id === current) && index === 0) ? 0 : -1}
                  className={`settings-nav__item${current === item.id ? " is-selected" : ""}`}
                  onClick={() => request({ type: "section", id: item.id, target })} onKeyDown={(event) => navigateKey(event, index)}>
                  {Icon ? <Icon size={17} aria-hidden="true" /> : <ProfileAvatar src={user.avatarUrl} name={personName(user)} size={21} />}
                  <span>{item.id === "profile" ? personName(user) : item.label}</span>
                </button>
              </div>;
            })}
            {!matches.length ? <div className="settings-search__empty"><p>未找到设置</p><button type="button" className="btn" onClick={() => setQuery("")}>清空搜索</button></div> : null}
          </div>
          <button type="button" className="settings-nav__logout" disabled={busy} onClick={() => request({ type: "logout" })}><LogOut size={16} />退出登录</button>
        </aside>
        <div className="settings-main" ref={content}>
          <div className="settings-main__content">
            {narrow ? <button type="button" className="settings-back" disabled={busy} onClick={() => request({ type: "back" })}><ChevronLeft size={17} />返回设置</button> : null}
            <header className="settings-heading"><h1 tabIndex={-1}>{selected.title}</h1><p>{selected.description}</p></header>
            {available.map(({ id: key, title }) => {
              const active = key === current && (!narrow || mobileDetail);
              return <section key={key} id={`${id}-panel-${key}`} role={narrow ? "region" : "tabpanel"}
                aria-label={title} hidden={key !== current} className="settings-panel">
                {!visited.includes(key) ? null : key === "profile" ? <>
                  <ProfileSettings onBusyChange={setBusy} onDirtyChange={setDirty} />
                  <section className="settings-group" aria-label="登录方式" tabIndex={-1} data-setting="methods">
                    <h2>登录方式</h2>
                    <GithubLoginMethods active={active} onBusyChange={setBusy} requestExternal={(run) => request({ type: "external", run })}
                      notice={notice ? githubMessages[notice] : undefined} noticeError={notice !== "linked"} />
                  </section>
                </> : key === "preferences" ? <PreferenceSettings onBusyChange={setBusy} />
                  : key === "invitations" ? <div data-setting="invitations" tabIndex={-1}><Invitations active={active} onBusyChange={setBusy} /></div>
                  : key === "tokens" ? <div data-setting="tokens" tabIndex={-1}><AgentTokens active={active} onBusyChange={setBusy} secret={secret} onSecretChange={setSecret} onOpenPage={(id) => { selectPage(id); perform({ type: "close" }); }} /></div>
                  : key === "data" ? <div data-setting="data" tabIndex={-1}><DataExport onBusyChange={setBusy} onOpenPage={(id) => { selectPage(id); perform({ type: "close" }); }} /></div>
                  : <div data-setting="users" tabIndex={-1} className="account-admin-link">
                    <p className="account-muted">在独立页面中查看站点概览、管理用户与团队知识库、调整存储限额。</p>
                    <button type="button" className="btn btn--primary" onClick={() => { onClose(); window.history.pushState(null, "", "/admin"); setAdminOpen(true); }}>打开后台管理</button>
                  </div>}
              </section>;
            })}
            {error ? <p className="account-error" role="alert">{error}</p> : null}
          </div>
        </div>
        <button type="button" className="icon-btn settings-close" aria-label="关闭设置" disabled={busy} onClick={close}><X size={18} /></button>
      </div>
      {confirmation ? <div className="settings-confirm-scrim"><div ref={prompt} className="settings-confirm" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-confirm-title`} aria-describedby={`${id}-confirm-description`}>
        <h2 id={`${id}-confirm-title`}>{confirmation.kind === "secret" ? "隐藏新令牌？" : "放弃未保存的修改？"}</h2>
        <p id={`${id}-confirm-description`}>{confirmation.kind === "secret" ? "离开后无法再次查看令牌；令牌仍有效。" : "显示名尚未保存。放弃后不会修改账号资料。"}</p>
        <div className="settings-confirm__actions">
          <button type="button" className="btn" onClick={cancelLeave}>{confirmation.kind === "secret" ? "继续保存" : "继续编辑"}</button>
          <button type="button" className="btn btn--danger" onClick={confirmLeave}>{confirmation.kind === "secret" ? "离开并隐藏" : "放弃修改"}</button>
        </div>
      </div></div> : null}
    </div>
  </Modal>;
}
