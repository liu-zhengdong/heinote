import { AlertTriangle, ArrowLeft, ArrowUpCircle, BookMarked, CheckCircle2, CloudUpload, Code2, DatabaseBackup, ExternalLink, HardDrive, Info, LayoutGrid, RefreshCw, Search, Settings2, SlidersHorizontal, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLayer } from "../../components/layer-stack";
import { Select } from "../../components/Select";
import { ProfileAvatar, personName } from "../../components/ProfileAvatar";
import { useUi } from "../../app/ui-context";
import { useSession } from "../account/AuthGate";
import { api, ApiError, errorMessage } from "../account/api";
import { formatBytes, formatDate, formatDateTime, parseBytesInput, type About, type AdminTeam, type AdminUser, type BackupStatus, type BackupTestResult, type Overview, type QuotaImpact, type QuotaSettings, type UpdateCheck, type UpdateStatus, type UpdateStep } from "./types";
import "./admin.css";

type Tab = "overview" | "users" | "teams" | "quotas" | "backups" | "about";
const TABS: { id: Tab; label: string; group: "运营" | "系统"; desc: string; icon: typeof LayoutGrid }[] = [
  { id: "overview", label: "概览", group: "运营", desc: "站点容量、用户规模与待处理状态总览。", icon: LayoutGrid },
  { id: "users", label: "用户", group: "运营", desc: "管理站点成员角色、个人存储限额与团队创建上限。", icon: Users },
  { id: "teams", label: "团队知识库", group: "运营", desc: "查看所有团队知识库的成员规模、归档状态与存储配额。", icon: BookMarked },
  { id: "quotas", label: "限额设置", group: "系统", desc: "统一调整新旧继承对象的默认存储与建库上限。", icon: SlidersHorizontal },
  { id: "backups", label: "备份", group: "系统", desc: "配置 WebDAV 异地分片备份、计划时刻与手动触发。", icon: DatabaseBackup },
  { id: "about", label: "关于", group: "系统", desc: "当前运行环境、代码仓库与在线版本更新。", icon: Info },
];
const TAB_GROUPS: readonly ("运营" | "系统")[] = ["运营", "系统"];

function useBusy() {
  const [busy, setBusy] = useState(0);
  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    setBusy((n) => n + 1);
    try { return await work(); }
    finally { setBusy((n) => Math.max(0, n - 1)); }
  }, []);
  return { busy: busy > 0, run };
}

function Meter({ used, limit }: { used: number; limit: number }) {
  const ratio = Math.min(1, limit > 0 ? used / limit : 0);
  const over = used > limit;
  return <span className="ac-meter" title={`${formatBytes(used)} / ${formatBytes(limit)}`}>
    <span className="ac-meter__track"><span className={over ? "ac-meter__fill ac-meter__fill--over" : "ac-meter__fill"} style={{ width: `${Math.max(1.5, ratio * 100)}%` }} /></span>
    <span className="ac-meter__text">{formatBytes(used)} / {formatBytes(limit)}</span>
  </span>;
}

function OverBadge({ bytes }: { bytes: number }) {
  if (bytes <= 0) return null;
  return <span className="ac-over"><AlertTriangle size={12} /> 超额 {formatBytes(bytes)}</span>;
}

interface ConfirmState {
  title: string;
  body: string;
  confirmLabel: string;
  run: () => Promise<void>;
}

export function AdminConsole({ onClose }: { onClose(): void }) {
  const { user } = useSession();
  const { toast } = useUi();
  const [tab, setTab] = useState<Tab>("overview");
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [detail, setDetail] = useState(false); // narrow layout: inspector visible
  const [summary, setSummary] = useState<Overview | null>(null);
  const { busy } = useBusy();
  const root = useRef<HTMLDivElement>(null);

  const openObject = useCallback((kind: "user" | "kb", id: string) => {
    setDetail(true);
    if (kind === "user") { setTab("users"); setSelectedUser(id); }
    else { setTab("teams"); setSelectedTeam(id); }
  }, []);

  useEffect(() => {
    root.current?.focus();
  }, []);

  useLayer(true, () => {
    if (confirm) setConfirm(null);
    else if (detail) setDetail(false);
    else onClose();
  }, { phase: "capture" });

  const doConfirm = async () => {
    if (!confirm) return;
    setConfirming(true);
    try { await confirm.run(); setConfirm(null); }
    catch (reason) {
      toast(errorMessage(reason), "error");
      setConfirm(null);
    } finally { setConfirming(false); }
  };

  const activeMeta = TABS.find((item) => item.id === tab) ?? TABS[0];
  const isSplit = tab === "users" || tab === "teams";

  const tabBadge = (id: Tab) => {
    if (!summary) return null;
    if (id === "overview" && summary.over.length > 0) {
      return <span className="admin__badge admin__badge--danger" aria-hidden="true">{summary.over.length}</span>;
    }
    if (id === "users") return <span className="admin__badge" aria-hidden="true">{summary.users}</span>;
    if (id === "teams") return <span className="admin__badge" aria-hidden="true">{summary.teams.active}</span>;
    return null;
  };

  return <div className="admin" ref={root} tabIndex={-1} data-detail={detail ? "1" : undefined} aria-busy={busy || undefined}>
    <aside className="admin__nav">
      <header className="admin__top">
        <button type="button" className="btn admin__back" onClick={onClose}><ArrowLeft size={15} />返回笔记</button>
        <span className="admin__who admin__who--mobile">{user ? `管理员 · ${personName(user)}` : ""}</span>
      </header>
      <div className="admin__brand-block">
        <strong className="admin__brand">小黑笔记</strong>
        <span className="admin__subtitle">站点后台管理</span>
      </div>
      <nav className="admin__tabs" role="tablist" aria-label="后台管理">
        {TAB_GROUPS.map((group) => (
          <div className="admin__tab-group" key={group}>
            <div className="admin__group-label" aria-hidden="true">{group}</div>
            {TABS.filter((item) => item.group === group).map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-label={item.label}
                  aria-selected={tab === item.id}
                  className={tab === item.id ? "admin__tab admin__tab--on" : "admin__tab"}
                  onClick={() => { setTab(item.id); setDetail(false); }}
                >
                  <span className="admin__tab-icon" aria-hidden="true"><Icon size={15} /></span>
                  <span className="admin__tab-label">{item.label}</span>
                  {tabBadge(item.id)}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      {user ? (
        <div className="admin__foot">
          <ProfileAvatar src={user.avatarUrl} name={personName(user)} size={24} />
          <div className="admin__foot-copy">
            <span className="admin__who">{personName(user)}</span>
            <span className="admin__role">站点管理员</span>
          </div>
        </div>
      ) : null}
    </aside>

    <div className="admin__island">
      <header className="admin__header">
        <div>
          <h1>{activeMeta.label}</h1>
          <p>{activeMeta.desc}</p>
        </div>
        {tab === "overview" && summary ? (
          summary.over.length > 0
            ? <span className="ac-pill ac-pill--danger"><AlertTriangle size={12} /> {summary.over.length} 项超额</span>
            : <span className="ac-pill ac-pill--ok"><CheckCircle2 size={12} /> 状态健康</span>
        ) : null}
      </header>
      <main className={`admin__main ${isSplit ? "admin__main--split" : ""}`}>
        {tab === "overview" ? <OverviewPanel onOpen={openObject} onNavigate={setTab} onLoaded={setSummary} /> : null}
        {tab === "users" ? <UsersPanel selected={selectedUser} onSelect={(id) => { setSelectedUser(id); setDetail(true); }} onBack={() => setDetail(false)} /> : null}
        {tab === "teams" ? <TeamsPanel selected={selectedTeam} onSelect={(id) => { setSelectedTeam(id); setDetail(true); }} onBack={() => setDetail(false)} /> : null}
        {tab === "quotas" ? <QuotasPanel onConfirm={setConfirm} /> : null}
        {tab === "backups" ? <BackupsPanel /> : null}
        {tab === "about" ? <AboutPanel /> : null}
      </main>
    </div>

    {confirm ? <div className="ac-confirm-scrim" role="presentation" onClick={() => !confirming && setConfirm(null)}>
      <div className="ac-confirm" role="alertdialog" aria-modal="true" aria-label={confirm.title} onClick={(event) => event.stopPropagation()}>
        <h2>{confirm.title}</h2>
        <p>{confirm.body}</p>
        <div className="ac-confirm__actions">
          <button type="button" className="btn" disabled={confirming} onClick={() => setConfirm(null)}>取消</button>
          <button type="button" className="btn btn--primary" disabled={confirming} onClick={() => void doConfirm()}>{confirming ? "保存中…" : confirm.confirmLabel}</button>
        </div>
      </div>
    </div> : null}
  </div>;
}

/* ————————————————— 概览 ————————————————— */

function OverviewPanel({ onOpen, onNavigate, onLoaded }: {
  onOpen(kind: "user" | "kb", id: string): void;
  onNavigate(tab: Tab): void;
  onLoaded(overview: Overview): void;
}) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      const next = await api<Overview>("/api/admin/overview");
      setData(next);
      onLoaded(next);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }, [onLoaded]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <div className="ac-empty"><p>{error}</p><button type="button" className="btn" onClick={() => void load()}>重试</button></div>;
  if (!data) return <div className="ac-empty"><p>载入中…</p></div>;

  const usedDisk = data.disk.databaseBytes + data.disk.attachmentsBytes;
  const totalDisk = data.disk.freeBytes != null ? usedDisk + data.disk.freeBytes : usedDisk;
  const dbPct = totalDisk > 0 ? Math.max(data.disk.databaseBytes > 0 ? 1.5 : 0, (data.disk.databaseBytes / totalDisk) * 100) : 0;
  const attPct = totalDisk > 0 ? Math.max(data.disk.attachmentsBytes > 0 ? 1.5 : 0, (data.disk.attachmentsBytes / totalDisk) * 100) : 0;

  const tiles: { icon: ReactNode; label: string; value: string; hint: string; target?: Tab }[] = [
    { icon: <Users size={15} />, label: "用户", value: String(data.users), hint: `今日新增 ${data.newToday} 位 · 时区 ${data.timezone}`, target: "users" },
    { icon: <BookMarked size={15} />, label: "团队知识库", value: String(data.teams.active), hint: `已归档 ${data.teams.archived} · 合计 ${data.teams.active + data.teams.archived}`, target: "teams" },
    { icon: <HardDrive size={15} />, label: "配额占用", value: formatBytes(data.quotaBytes.total), hint: `个人 ${formatBytes(data.quotaBytes.personal)} · 团队 ${formatBytes(data.quotaBytes.teams)}`, target: "quotas" },
    { icon: <Settings2 size={15} />, label: "实际存储", value: formatBytes(usedDisk), hint: data.disk.freeBytes != null ? `卷可用 ${formatBytes(data.disk.freeBytes)}` : `数据库 ${formatBytes(data.disk.databaseBytes)} · 附件 ${formatBytes(data.disk.attachmentsBytes)}` },
  ];
  return <div className="ac-overview">
    <div className="ac-tiles">
      {tiles.map((tile) => tile.target ? (
        <button type="button" className="ac-tile ac-tile--click" key={tile.label} onClick={() => onNavigate(tile.target!)}>
          <span className="ac-tile__top">
            <span className="ac-tile__label">{tile.label}</span>
            <span className="ac-tile__icon">{tile.icon}</span>
          </span>
          <strong className="ac-tile__value">{tile.value}</strong>
          <span className="ac-tile__hint">{tile.hint}</span>
        </button>
      ) : (
        <div className="ac-tile" key={tile.label}>
          <span className="ac-tile__top">
            <span className="ac-tile__label">{tile.label}</span>
            <span className="ac-tile__icon">{tile.icon}</span>
          </span>
          <strong className="ac-tile__value">{tile.value}</strong>
          <span className="ac-tile__hint">{tile.hint}</span>
        </div>
      ))}
    </div>

    <section className="ac-panel">
      <div className="ac-panel__hd">
        <h3>存储占用分布</h3>
        <span className="ac-muted ac-num">
          已用 {formatBytes(usedDisk)}{data.disk.freeBytes != null ? ` · 卷剩余可用 ${formatBytes(data.disk.freeBytes)}` : ""}
        </span>
      </div>
      <div className="ac-disk-bar" aria-hidden="true">
        <span className="ac-disk-bar__seg ac-disk-bar__db" style={{ width: `${Math.min(100, dbPct)}%` }} />
        <span className="ac-disk-bar__seg ac-disk-bar__att" style={{ width: `${Math.min(100 - dbPct, attPct)}%` }} />
      </div>
      <div className="ac-disk-legend">
        <span><i className="ac-legend-dot ac-legend-dot--db" />数据库 <strong className="ac-num">{formatBytes(data.disk.databaseBytes)}</strong></span>
        <span><i className="ac-legend-dot ac-legend-dot--att" />附件目录 <strong className="ac-num">{formatBytes(data.disk.attachmentsBytes)}</strong></span>
        {data.disk.freeBytes != null ? <span><i className="ac-legend-dot ac-legend-dot--free" />剩余可用 <strong className="ac-num">{formatBytes(data.disk.freeBytes)}</strong></span> : null}
      </div>
    </section>

    <section className="ac-panel ac-queue">
      <div className="ac-panel__hd">
        <h3>需要处理</h3>
        {data.over.length ? <span className="ac-pill ac-pill--danger">{data.over.length} 项待处理</span> : null}
      </div>
      {data.over.length ? <ul className="ac-queue__list">
        {data.over.map((row) => <li key={`${row.kind}:${row.id}`}>
          <button type="button" className="ac-queue__row" onClick={() => onOpen(row.kind, row.id)}>
            <span className="ac-queue__name">{row.label}</span>
            <Meter used={row.used} limit={row.limit} />
            <OverBadge bytes={row.over} />
          </button>
        </li>)}
      </ul> : <div className="ac-health">
        <div className="ac-health__left">
          <span className="ac-health__icon" aria-hidden="true"><CheckCircle2 size={17} /></span>
          <div>
            <p className="ac-health__title">所有对象都在限额内。</p>
            <p className="ac-muted">暂无超额告警；可在「限额设置」调整全局默认上限。</p>
          </div>
        </div>
        <button type="button" className="btn btn--outline" onClick={() => onNavigate("quotas")}>查看默认限额</button>
      </div>}
    </section>
  </div>;
}

/* ————————————————— 用户 ————————————————— */

type LimitEdit = { kind: "storage" | "teams"; input: string } | null;

function UsersPanel({ selected, onSelect, onBack }: {
  selected: string | null;
  onSelect(id: string): void;
  onBack(): void;
}) {
  const { user: me, refresh } = useSession();
  const { toast } = useUi();
  const [items, setItems] = useState<AdminUser[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [edit, setEdit] = useState<LimitEdit>(null);
  const { busy, run } = useBusy();

  const load = useCallback(async () => {
    setError("");
    try { setItems(await api<AdminUser[]>("/api/admin/users")); setLoaded(true); }
    catch (reason) { setError(errorMessage(reason)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => personName(item).toLowerCase().includes(q) || item.handle.includes(q));
  }, [items, query]);
  const current = items.find((item) => item.id === selected) ?? null;

  const changeRole = (target: AdminUser, siteRole: "admin" | "user") => run(async () => {
    await api(`/api/admin/users/${encodeURIComponent(target.id)}`, { method: "PATCH", body: JSON.stringify({ siteRole }) });
    setItems((list) => list.map((item) => item.id === target.id ? { ...item, siteRole } : item));
    if (target.id === me?.id) await refresh();
  }).catch((reason) => toast(errorMessage(reason), "error"));

  const saveLimit = (target: AdminUser, kind: "storage" | "teams", value: number | null) => run(async () => {
    const body = kind === "storage" ? { storageLimit: value } : { teamCreationLimit: value };
    const updated = await api<AdminUser>(`/api/admin/users/${encodeURIComponent(target.id)}/limits`, {
      method: "PATCH",
      body: JSON.stringify({ ...body, base: { storageLimit: target.storageSource === "custom" ? target.storageLimit : null, teamCreationLimit: target.teamLimitSource === "custom" ? target.teamLimit : null } }),
    });
    setItems((list) => list.map((item) => item.id === target.id ? updated : item));
    setEdit(null);
    toast("限额已保存。");
  }).catch((reason) => {
    if (reason instanceof ApiError && reason.status === 409) { toast("限额已被其他管理员修改，已刷新。", "error"); void load(); setEdit(null); }
    else toast(errorMessage(reason), "error");
  });

  return <div className="ac-split">
    <div className="ac-list" role="list" aria-label="站点用户">
      <div className="ac-list__tools">
        <label className="ac-search"><Search size={14} /><input value={query} placeholder="搜索用户" onChange={(event) => setQuery(event.target.value)} /></label>
        <span className="ac-muted">{visible.length} 项</span>
      </div>
      {error ? <div className="ac-empty"><p>{error}</p><button type="button" className="btn" onClick={() => void load()}>重试</button></div> : null}
      {!loaded && !error ? <div className="ac-empty"><p>载入中…</p></div> : null}
      {loaded && !visible.length ? <div className="ac-empty"><p>{query ? "没有匹配的用户。" : "暂无账号。"}</p></div> : null}
      <ul>
        {visible.map((item) => <li key={item.id}>
          <button type="button" className={item.id === selected ? "ac-item ac-item--on" : "ac-item"} aria-current={item.id === selected || undefined} onClick={() => { onSelect(item.id); setEdit(null); }}>
            <ProfileAvatar src={item.avatarUrl} name={personName(item)} size={24} />
            <span className="ac-item__main">
              <span className="ac-item__name">{personName(item)}{item.id === me?.id ? "（我）" : ""}{item.storageOver > 0 ? <i className="ac-dot" aria-label="超额" /> : null}</span>
              <Meter used={item.storageBytes} limit={item.storageLimit} />
            </span>
            <span className="ac-item__side">
              <small>{item.siteRole === "admin" ? "管理员" : "用户"}</small>
              <small>{item.teamCount}/{item.teamLimit} 库</small>
            </span>
          </button>
        </li>)}
      </ul>
    </div>
    <div className="ac-ins">
      {current ? <UserInspector user={current} me={me?.id === current.id} busy={busy}
        edit={edit} setEdit={setEdit}
        onBack={onBack}
        onRole={(role) => void changeRole(current, role)}
        onSave={(kind, value) => void saveLimit(current, kind, value)} />
        : <div className="ac-empty"><p>从左侧选择一个用户。</p></div>}
    </div>
  </div>;
}

function LimitEditor({ edit, setEdit, used, source, unit, busy, onSave }: {
  edit: LimitEdit;
  setEdit(edit: LimitEdit): void;
  used: number;
  source: string;
  unit: "GB" | "个";
  busy: boolean;
  onSave(value: number | null): void;
}) {
  if (!edit) return null;
  const value = edit.kind === "storage" ? parseBytesInput(edit.input) : (() => { const n = Number(edit.input.trim()); return Number.isInteger(n) && n >= 0 ? n : null; })();
  const valid = value !== null;
  const lowered = valid && value < used;
  const restored = source === "custom";
  return <div className="ac-edit">
    <div className="ac-edit__row">
      <input type="number" min={unit === "GB" ? "1" : "0"} step="1" value={edit.input} autoFocus
        aria-label={unit === "GB" ? "存储限额 GB" : "团队创建上限"}
        onChange={(event) => setEdit({ ...edit, input: event.target.value })} />
      <span className="ac-muted">{unit === "GB" ? "GB" : "个"}</span>
      <span className="ac-edit__gap" />
      {restored ? <button type="button" className="btn" disabled={busy} onClick={() => onSave(null)}>恢复默认</button> : null}
      <button type="button" className="btn" disabled={busy} onClick={() => setEdit(null)}>取消</button>
      <button type="button" className="btn btn--primary" disabled={busy || !valid} onClick={() => onSave(value)}>保存</button>
    </div>
    {edit.input.trim() !== "" && !valid ? <p className="ac-error">{unit === "GB" ? "限额必须是正数。" : "上限必须是非负整数。"}</p> : null}
    {lowered ? <p className="ac-warn"><AlertTriangle size={13} /> 新{unit === "GB" ? "限额" : "上限"}低于当前用量 {unit === "GB" ? formatBytes(used) : `${used} 个`}。已有内容保留，对象进入超额状态。</p> : null}
    {valid ? <p className="ac-edit__note">当前已用 {unit === "GB" ? formatBytes(used) : `${used} 个`}。</p> : null}
  </div>;
}

function UserInspector({ user, me, busy, edit, setEdit, onBack, onRole, onSave }: {
  user: AdminUser;
  me: boolean;
  busy: boolean;
  edit: LimitEdit;
  setEdit(edit: LimitEdit): void;
  onBack(): void;
  onRole(role: "admin" | "user"): void;
  onSave(kind: "storage" | "teams", value: number | null): void;
}) {
  return <div className="ac-ins__inner">
    <button type="button" className="btn ac-ins__back" onClick={onBack}><ArrowLeft size={15} />用户列表</button>
    <header className="ac-head">
      <ProfileAvatar src={user.avatarUrl} name={personName(user)} size={44} />
      <div>
        <h2>{personName(user)}{me ? "（我）" : ""}</h2>
        <p className="ac-muted">@{user.handle} · 注册于 {formatDate(user.createdAt)}</p>
      </div>
    </header>
    <dl className="ac-fields">
      <div className="ac-field">
        <dt>站点角色</dt>
        <dd>
          <Select value={user.siteRole} disabled={busy} aria-label="站点角色"
            onValueChange={(role) => onRole(role as "admin" | "user")}
            options={[{ value: "user", label: "用户" }, { value: "admin", label: "管理员" }]} />
          <span className="ac-muted">至少保留一名管理员。</span>
        </dd>
      </div>
      <div className="ac-field">
        <dt>存储限额 <small className="ac-src">{user.storageSource === "custom" ? "单独设置" : "默认"}</small></dt>
        <dd>
          <Meter used={user.storageBytes} limit={user.storageLimit} />
          <OverBadge bytes={user.storageOver} />
          <button type="button" className="btn btn--outline" disabled={busy || Boolean(edit)} onClick={() => setEdit({ kind: "storage", input: String(Math.round(user.storageLimit / 1e8) / 10) })}>调整</button>
          {edit?.kind === "storage" ? <LimitEditor edit={edit} setEdit={setEdit} used={user.storageBytes} source={user.storageSource} unit="GB" busy={busy} onSave={(value) => onSave("storage", value)} /> : null}
        </dd>
      </div>
      <div className="ac-field">
        <dt>团队创建上限 <small className="ac-src">{user.teamLimitSource === "custom" ? "单独设置" : "默认"}</small></dt>
        <dd>
          <span className="ac-teams-line">已拥有 {user.teamCount} 个 · 上限 {user.teamLimit} 个{user.teamCount > user.teamLimit ? <span className="ac-over"><AlertTriangle size={12} /> 超额 {user.teamCount - user.teamLimit} 个</span> : null}</span>
          <button type="button" className="btn btn--outline" disabled={busy || Boolean(edit)} onClick={() => setEdit({ kind: "teams", input: String(user.teamLimit) })}>调整</button>
          {edit?.kind === "teams" ? <LimitEditor edit={edit} setEdit={setEdit} used={user.teamCount} source={user.teamLimitSource} unit="个" busy={busy} onSave={(value) => onSave("teams", value)} /> : null}
        </dd>
      </div>
    </dl>
  </div>;
}

/* ————————————————— 团队知识库 ————————————————— */

function TeamsPanel({ selected, onSelect, onBack }: {
  selected: string | null;
  onSelect(id: string): void;
  onBack(): void;
}) {
  const { toast } = useUi();
  const [items, setItems] = useState<AdminTeam[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [edit, setEdit] = useState<LimitEdit>(null);
  const { busy, run } = useBusy();

  const load = useCallback(async () => {
    setError("");
    try { setItems(await api<AdminTeam[]>("/api/admin/teams")); setLoaded(true); }
    catch (reason) { setError(errorMessage(reason)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.name.toLowerCase().includes(q) || item.ownerName.toLowerCase().includes(q));
  }, [items, query]);
  const current = items.find((item) => item.spaceId === selected) ?? null;

  const saveLimit = (target: AdminTeam, value: number | null) => run(async () => {
    const updated = await api<AdminTeam>(`/api/admin/teams/${encodeURIComponent(target.spaceId)}/limits`, {
      method: "PATCH",
      body: JSON.stringify({ storageLimit: value, base: { storageLimit: target.storageSource === "custom" ? target.storageLimit : null } }),
    });
    setItems((list) => list.map((item) => item.spaceId === target.spaceId ? updated : item));
    setEdit(null);
    toast("限额已保存。");
  }).catch((reason) => {
    if (reason instanceof ApiError && reason.status === 409) { toast("限额已被其他管理员修改，已刷新。", "error"); void load(); setEdit(null); }
    else toast(errorMessage(reason), "error");
  });

  return <div className="ac-split">
    <div className="ac-list" role="list" aria-label="团队知识库">
      <div className="ac-list__tools">
        <label className="ac-search"><Search size={14} /><input value={query} placeholder="搜索知识库" onChange={(event) => setQuery(event.target.value)} /></label>
        <span className="ac-muted">{visible.length} 项</span>
      </div>
      {error ? <div className="ac-empty"><p>{error}</p><button type="button" className="btn" onClick={() => void load()}>重试</button></div> : null}
      {!loaded && !error ? <div className="ac-empty"><p>载入中…</p></div> : null}
      {loaded && !visible.length ? <div className="ac-empty"><p>{query ? "没有匹配的知识库。" : "暂无团队知识库。"}</p></div> : null}
      <ul>
        {visible.map((item) => <li key={item.spaceId}>
          <button type="button" className={item.spaceId === selected ? "ac-item ac-item--on" : "ac-item"} aria-current={item.spaceId === selected || undefined} onClick={() => { onSelect(item.spaceId); setEdit(null); }}>
            <span className="ac-item__icon"><BookMarked size={18} /></span>
            <span className="ac-item__main">
              <span className="ac-item__name">{item.name}{item.storageOver > 0 ? <i className="ac-dot" aria-label="超额" /> : null}</span>
              <Meter used={item.storageBytes} limit={item.storageLimit} />
            </span>
            <span className="ac-item__side">
              <small>{item.archived ? "已归档" : "使用中"}</small>
              <small>{item.memberCount} 名成员</small>
            </span>
          </button>
        </li>)}
      </ul>
    </div>
    <div className="ac-ins">
      {current ? <div className="ac-ins__inner">
        <button type="button" className="btn ac-ins__back" onClick={onBack}><ArrowLeft size={15} />知识库列表</button>
        <header className="ac-head">
          <span className="ac-item__icon ac-item__icon--lg"><BookMarked size={22} /></span>
          <div>
            <h2>{current.name}</h2>
            <p className="ac-muted">{current.archived ? "已归档" : "使用中"} · 所有者 {current.ownerName} · {current.memberCount} 名成员 · 创建于 {formatDate(current.createdAt)}</p>
          </div>
        </header>
        <dl className="ac-fields">
          <div className="ac-field">
            <dt>存储限额 <small className="ac-src">{current.storageSource === "custom" ? "单独设置" : "默认"}</small></dt>
            <dd>
              <Meter used={current.storageBytes} limit={current.storageLimit} />
              <OverBadge bytes={current.storageOver} />
              <button type="button" className="btn btn--outline" disabled={busy || Boolean(edit)} onClick={() => setEdit({ kind: "storage", input: String(Math.round(current.storageLimit / 1e8) / 10) })}>调整</button>
              {edit?.kind === "storage" ? <LimitEditor edit={edit} setEdit={setEdit} used={current.storageBytes} source={current.storageSource} unit="GB" busy={busy} onSave={(value) => void saveLimit(current, value)} /> : null}
            </dd>
          </div>
        </dl>
      </div> : <div className="ac-empty"><p>从左侧选择一个知识库。</p></div>}
    </div>
  </div>;
}

/* ————————————————— 限额设置 ————————————————— */

function QuotasPanel({ onConfirm }: { onConfirm(state: ConfirmState | null): void }) {
  const { toast } = useUi();
  const [settings, setSettings] = useState<QuotaSettings | null>(null);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState<{ key: "personal" | "team" | "creation"; input: string } | null>(null);
  const { busy, run } = useBusy();

  const load = useCallback(async () => {
    setError("");
    try { setSettings(await api<QuotaSettings>("/api/admin/quota-settings")); }
    catch (reason) { setError(errorMessage(reason)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const rows = settings ? [
    { key: "personal" as const, label: "个人存储默认值", desc: "每位用户个人内容与名下分享空间的存储上限。", value: formatBytes(settings.personalStorageBytes), gb: settings.personalStorageBytes / 1e9, unit: "GB" },
    { key: "team" as const, label: "团队存储默认值", desc: "每个团队知识库的存储上限。", value: formatBytes(settings.teamStorageBytes), gb: settings.teamStorageBytes / 1e9, unit: "GB" },
    { key: "creation" as const, label: "每人团队创建上限", desc: "每位用户可拥有的团队知识库数量。归档库仍占名额。", value: `${settings.teamCreation} 个`, gb: settings.teamCreation, unit: "个" },
  ] : [];

  const save = (key: "personal" | "team" | "creation", value: number) => run(async () => {
    const base = settings!;
    const next = await api<QuotaSettings>("/api/admin/quota-settings", { method: "PUT", body: JSON.stringify({ key, value, base }) });
    setSettings(next);
    setEdit(null);
    toast("默认限额已保存。");
  }).catch((reason) => {
    if (reason instanceof ApiError && reason.status === 409) { toast("默认限额已被其他管理员修改，已刷新。", "error"); void load(); setEdit(null); }
    else toast(errorMessage(reason), "error");
  });

  const preview = (key: "personal" | "team" | "creation", value: number) => run(async () => {
    const impact = await api<QuotaImpact>("/api/admin/quota-settings/preview", { method: "POST", body: JSON.stringify({ key, value }) });
    const label = key === "personal" ? "个人存储默认值" : key === "team" ? "团队存储默认值" : "每人团队创建上限";
    const shown = key === "creation" ? `${value} 个` : formatBytes(value);
    onConfirm({
      title: `将${label}调整为 ${shown}？`,
      body: impact.newlyOver > 0
        ? `${impact.affected} 个继承对象将使用新默认值，其中 ${impact.newlyOver} 个保存后超额。已有内容与团队保留，进入超额状态。`
        : `${impact.affected} 个继承对象将使用新默认值，没有对象因此超额。`,
      confirmLabel: "确认保存",
      run: () => save(key, value) as Promise<void>,
    });
  }).catch((reason) => toast(errorMessage(reason), "error"));

  if (error) return <div className="ac-empty"><p>{error}</p><button type="button" className="btn" onClick={() => void load()}>重试</button></div>;
  if (!settings) return <div className="ac-empty"><p>载入中…</p></div>;

  return <div className="ac-quotas">
    <h3>默认限额</h3>
    <p className="ac-muted">单独设置的限额不受默认值影响。降低默认值可能使继承对象超额。</p>
    <ul className="ac-qlist">
      {rows.map((row) => <li className="ac-qrow" key={row.key}>
        <div className="ac-qrow__text">
          <strong>{row.label}</strong>
          <p className="ac-muted">{row.desc}</p>
          {edit?.key === row.key ? <div className="ac-edit">
            <label className="ac-edit__row">
              <input type="number" min={row.unit === "GB" ? "1" : "0"} step="1" autoFocus value={edit.input}
                onChange={(event) => setEdit({ key: row.key, input: event.target.value })} />
              <span className="ac-muted">{row.unit}</span>
            </label>
            {(() => {
              const value = row.unit === "GB" ? parseBytesInput(edit.input) : (() => { const n = Number(edit.input.trim()); return Number.isInteger(n) && n >= 0 ? n : null; })();
              return edit.input.trim() !== "" && value === null ? <p className="ac-error">{row.unit === "GB" ? "限额必须是正数。" : "上限必须是非负整数。"}</p> : null;
            })()}
            <div className="ac-edit__actions">
              <button type="button" className="btn" disabled={busy} onClick={() => setEdit(null)}>取消</button>
              <button type="button" className="btn btn--primary" disabled={busy || (() => {
                const value = row.unit === "GB" ? parseBytesInput(edit.input) : (() => { const n = Number(edit.input.trim()); return Number.isInteger(n) && n >= 0 ? n : null; })();
                return value === null;
              })()} onClick={() => {
                const value = row.unit === "GB" ? parseBytesInput(edit.input)! : Number(edit.input.trim());
                void preview(row.key, value);
              }}>预览并保存</button>
            </div>
          </div> : null}
        </div>
        <div className="ac-qrow__side">
          <strong className="ac-qrow__value">{row.value}</strong>
          <button type="button" className="btn btn--outline" disabled={busy || Boolean(edit)} onClick={() => setEdit({ key: row.key, input: String(row.gb) })}>调整</button>
        </div>
      </li>)}
    </ul>
  </div>;
}

/* ————————————————— 备份（UC-31，方向 A） ————————————————— */

const BACKUP_KIND_LABEL: Record<string, string> = {
  ok: "备份成功",
  auth: "凭据失效",
  network: "网络不可达",
  other: "备份失败",
  interrupted: "上次运行被中断",
};

type BackupForm = { url: string; user: string; password: string };
type PlanEdit = { hour: string; minute: string; retention: string; chunk: string } | null;

function BackupsPanel() {
  const { toast } = useUi();
  const [data, setData] = useState<BackupStatus | null>(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState<BackupForm>({ url: "", user: "", password: "" });
  const formInitRef = useRef(false);
  const [planEdit, setPlanEdit] = useState<PlanEdit>(null);
  const [testing, setTesting] = useState<BackupTestResult | null>(null);
  const { busy, run } = useBusy();

  const load = useCallback(async () => {
    setError("");
    try {
      const next = await api<BackupStatus>("/api/admin/backups");
      setData(next);
      if (!formInitRef.current) {
        formInitRef.current = true;
        setForm({ url: next.config.webdav.url, user: next.config.webdav.user, password: "" });
      }
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // Poll while a run is in flight so the tiles/track reflect progress.
  useEffect(() => {
    if (!data?.state.running) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [data?.state.running, load]);

  if (error) return <div className="ac-empty"><p>{error}</p><button type="button" className="btn btn--outline" onClick={() => void load()}>重试</button></div>;
  if (!data) return <div className="ac-empty"><p>载入中…</p></div>;

  const { config, state } = data;
  const saveSettings = (body: object, okMsg?: string) => run(async () => {
    await api("/api/admin/backups/settings", { method: "PUT", body: JSON.stringify(body) });
    await load();
    if (okMsg) toast(okMsg);
  }).catch((reason) => toast(errorMessage(reason), "error"));

  const test = () => run(async () => {
    const result = await api<BackupTestResult>("/api/admin/backups/test", {
      method: "POST",
      body: JSON.stringify({ webdav: { url: form.url.trim(), user: form.user.trim(), password: form.password } }),
    });
    setTesting(result);
  }).catch((reason) => toast(errorMessage(reason), "error"));

  const runNow = () => run(async () => {
    try {
      await api("/api/admin/backups/run", { method: "POST", body: "{}" });
      toast("备份已触发。");
    } finally { await load(); }
  }).catch((reason) => { toast(errorMessage(reason), "error"); void load(); });

  const saveWebdav = () => void saveSettings({
    webdav: {
      url: form.url.trim(),
      user: form.user.trim(),
      password: form.password,
    },
    enabled: config.enabled,
  }, "WebDAV 配置已保存。");

  const savePlan = () => {
    if (!planEdit) return;
    const hour = Number(planEdit.hour);
    const minute = Number(planEdit.minute);
    const retention = Number(planEdit.retention);
    const chunk = Number(planEdit.chunk);
    const valid = Number.isInteger(hour) && hour >= 0 && hour <= 23
      && Number.isInteger(minute) && minute >= 0 && minute <= 59
      && Number.isInteger(retention) && retention >= 1 && retention <= 100
      && Number.isInteger(chunk) && chunk >= 4 && chunk <= 512;
    if (!valid) { toast("请检查时间、保留份数（1–100）与分片大小（4–512 MiB）。", "error"); return; }
    setPlanEdit(null);
    void saveSettings({ schedule: { hour, minute }, retention, chunkBytes: chunk * 1024 * 1024 }, "备份计划已保存。");
  };

  const scheduleText = `${String(config.schedule.hour).padStart(2, "0")}:${String(config.schedule.minute).padStart(2, "0")}`;
  const chunkMiB = Math.round(config.chunkBytes / 1024 / 1024);
  const webdavSet = Boolean(config.webdav.url && config.webdav.user);
  const failed = !state.running && state.lastResult && state.lastResult !== "ok" && state.lastResult !== "interrupted";
  const needsAttention = !webdavSet || failed || Boolean(state.pending) || state.lastResult === "interrupted";

  const tiles = [
    {
      icon: <DatabaseBackup size={15} />, label: "上次备份",
      value: state.running ? "进行中…" : state.lastResult ? BACKUP_KIND_LABEL[state.lastResult] ?? state.lastResult : "从未备份",
      hint: state.running
        ? `开始于 ${formatDateTime(state.runningSince ?? "")}`
        : state.lastFinishedAt ? formatDateTime(state.lastFinishedAt) : "配置后按计划自动执行",
      danger: Boolean(failed) || state.lastResult === "interrupted",
    },
    {
      icon: <CloudUpload size={15} />, label: "云端归档",
      value: webdavSet ? `${state.remoteCount ?? "—"} / ${config.retention}` : "未配置",
      hint: state.pending ? `一份归档待续传：${state.pending.archiveId}` : webdavSet ? `最近 ${config.retention} 份保留于云端` : "填写 WebDAV 目标后可用",
    },
    {
      icon: <Settings2 size={15} />, label: "自动备份",
      value: config.enabled ? `每天 ${scheduleText}` : "已关闭",
      hint: config.enabled ? "到达时刻自动执行；失败当日不重试" : "仍可手动「立即备份」",
    },
  ];

  return <div className="ac-overview">
    <div className="ac-tiles ac-tiles--3">
      {tiles.map((tile) => <div className={tile.danger ? "ac-tile ac-tile--danger" : "ac-tile"} key={tile.label}>
        <span className="ac-tile__top">
          <span className="ac-tile__label">{tile.label}</span>
          <span className="ac-tile__icon">{tile.icon}</span>
        </span>
        <strong className="ac-tile__value">{tile.value}</strong>
        <span className="ac-tile__hint">{tile.hint}</span>
      </div>)}
    </div>

    {needsAttention ? (
      <section className={`ac-banner ${failed || state.lastResult === "interrupted" ? "ac-banner--danger" : "ac-banner--info"}`}>
        <div className="ac-banner__items">
          {!webdavSet ? (
            <div className="ac-banner__row">
              <span className="ac-banner__icon" aria-hidden="true"><Info size={16} /></span>
              <div className="ac-banner__copy">
                <strong>尚未配置 WebDAV 存储目标</strong>
                <p className="ac-muted">填写下方远端地址与凭据并保存，即可启用每日定时备份与手动备份。</p>
              </div>
            </div>
          ) : null}
          {failed ? (
            <div className="ac-banner__row">
              <span className="ac-banner__icon ac-banner__icon--danger" aria-hidden="true"><AlertTriangle size={16} /></span>
              <div className="ac-banner__copy">
                <strong>{BACKUP_KIND_LABEL[state.lastResult ?? "other"] ?? "备份失败"}</strong>
                <p className="ac-muted">{state.lastError ?? "请检查 WebDAV 地址、网络与凭据。"}</p>
              </div>
              <button type="button" className="btn btn--outline" disabled={busy || state.running} onClick={runNow}>{state.pending ? "立即续传" : "重试备份"}</button>
            </div>
          ) : null}
          {!failed && (state.pending || state.lastResult === "interrupted") ? (
            <div className="ac-banner__row">
              <span className="ac-banner__icon ac-banner__icon--danger" aria-hidden="true"><AlertTriangle size={16} /></span>
              <div className="ac-banner__copy">
                <strong>{state.pending ? "有一份归档未完成上传" : "上次运行被中断"}</strong>
                <p className="ac-muted">{state.pending ? "已上传的分片将自动跳过，仅补传缺失部分。" : "下次计划执行时会自动继续，也可现在手动续传。"}</p>
              </div>
              <button type="button" className="btn btn--outline" disabled={busy || state.running} onClick={runNow}>立即续传</button>
            </div>
          ) : null}
        </div>
      </section>
    ) : null}

    <section className="ac-panel">
      <div className="ac-panel__hd">
        <h3>WebDAV 存储目标</h3>
        <span className={`ac-pill ${webdavSet ? "ac-pill--ok" : "ac-pill--neutral"}`}>
          {webdavSet ? <><CheckCircle2 size={12} /> 已配置</> : "未配置"}
        </span>
      </div>
      <dl className="ac-fields ac-fields--compact">
        <div className="ac-field">
          <dt>WebDAV 地址</dt>
          <dd>
            <input className="ac-input" type="url" placeholder="https://dav.example.com/dav/目录" aria-label="WebDAV 地址"
              value={form.url} disabled={busy}
              onChange={(event) => { setForm({ ...form, url: event.target.value }); setTesting(null); }} />
          </dd>
        </div>
        <div className="ac-field">
          <dt>账号</dt>
          <dd>
            <input className="ac-input" type="text" placeholder="云盘账号或邮箱" aria-label="WebDAV 账号" autoComplete="off"
              value={form.user} disabled={busy}
              onChange={(event) => { setForm({ ...form, user: event.target.value }); setTesting(null); }} />
          </dd>
        </div>
        <div className="ac-field">
          <dt>密码</dt>
          <dd>
            <input className="ac-input" type="password" placeholder={config.webdav.passwordSet ? "已设置（留空保持不变）" : "应用专用密码"} aria-label="WebDAV 密码"
              value={form.password} disabled={busy}
              onChange={(event) => { setForm({ ...form, password: event.target.value }); setTesting(null); }} />
          </dd>
        </div>
      </dl>
      <div className="ac-panel__foot">
        <div className="ac-panel__status">
          {testing ? (
            testing.ok ? (
              <span className="ac-status-ok"><CheckCircle2 size={14} /> 连接成功。{testing.warning ? <span className="ac-warn-inline">（{testing.warning}）</span> : null}</span>
            ) : (
              <span className="ac-error"><AlertTriangle size={14} /> 测试失败：{testing.error}</span>
            )
          ) : (
            <span className="ac-muted">推荐使用云盘的应用专用密码，凭据仅保存在本地服务配置中。</span>
          )}
        </div>
        <div className="ac-panel__actions">
          <button type="button" className="btn btn--outline" disabled={busy} onClick={test}>测试连接</button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={saveWebdav}>保存</button>
        </div>
      </div>
    </section>

    <section className="ac-panel">
      <div className="ac-panel__hd">
        <h3>备份计划与执行</h3>
        <button type="button" className="btn btn--outline" disabled={busy || state.running || !webdavSet} onClick={runNow}>
          <CloudUpload size={14} />
          {state.running ? "进行中…" : state.pending ? "立即备份（续传）" : "立即备份"}
        </button>
      </div>
      <dl className="ac-fields ac-fields--compact">
        <div className="ac-field">
          <dt>自动备份</dt>
          <dd>
            <button
              type="button"
              role="switch"
              aria-checked={config.enabled}
              aria-label="自动备份"
              className={`ac-switch ${config.enabled ? "is-on" : ""}`}
              disabled={busy || !webdavSet}
              onClick={() => void saveSettings({ enabled: !config.enabled })}
            >
              <span className="ac-switch__thumb" />
            </button>
            <span className="ac-switch__label">{config.enabled ? "已开启" : "已关闭"}</span>
            <span className="ac-muted">{!webdavSet ? "先配置 WebDAV 目标后可开启" : "到达计划时刻自动执行；失败当日不重试"}</span>
          </dd>
        </div>
        <div className="ac-field">
          <dt>备份计划</dt>
          <dd>
            <span className="ac-plan-chips">
              <span className="ac-pill ac-pill--neutral ac-num">每天 {scheduleText}</span>
              <span className="ac-pill ac-pill--neutral ac-num">保留 {config.retention} 份</span>
              <span className="ac-pill ac-pill--neutral ac-num">分片 {chunkMiB} MiB</span>
            </span>
            <button type="button" className="btn btn--outline" disabled={busy || Boolean(planEdit)}
              onClick={() => setPlanEdit({ hour: String(config.schedule.hour), minute: String(config.schedule.minute), retention: String(config.retention), chunk: String(chunkMiB) })}>调整</button>
            {planEdit ? (
              <div className="ac-plan-edit">
                <div className="ac-plan-edit__grid">
                  <label className="ac-plan-field">
                    <span>执行时刻（服务时区）</span>
                    <span className="ac-plan-time">
                      <input className="ac-input ac-input--s" type="number" min={0} max={23} value={planEdit.hour} aria-label="执行小时" onChange={(e) => setPlanEdit({ ...planEdit, hour: e.target.value })} />
                      <span>:</span>
                      <input className="ac-input ac-input--s" type="number" min={0} max={59} value={planEdit.minute} aria-label="执行分钟" onChange={(e) => setPlanEdit({ ...planEdit, minute: e.target.value })} />
                    </span>
                  </label>
                  <label className="ac-plan-field">
                    <span>保留份数（1–100）</span>
                    <input className="ac-input ac-input--s" type="number" min={1} max={100} value={planEdit.retention} aria-label="保留份数" onChange={(e) => setPlanEdit({ ...planEdit, retention: e.target.value })} />
                  </label>
                  <label className="ac-plan-field">
                    <span>分片大小（MiB）</span>
                    <input className="ac-input ac-input--s" type="number" min={4} max={512} value={planEdit.chunk} aria-label="分片 MiB" onChange={(e) => setPlanEdit({ ...planEdit, chunk: e.target.value })} />
                  </label>
                </div>
                <div className="ac-edit__actions">
                  <button type="button" className="btn" disabled={busy} onClick={() => setPlanEdit(null)}>取消</button>
                  <button type="button" className="btn btn--primary" disabled={busy} onClick={savePlan}>保存计划</button>
                </div>
              </div>
            ) : null}
          </dd>
        </div>
      </dl>
      <p className="ac-panel__note">归档含数据库与全部附件，以分片与清单上传到远端目录；已传分片在续传时会自动跳过。恢复方式：下载同组全部分片拼接解压并替换数据目录。</p>
    </section>
  </div>;
}

/* ————————————————— 关于 ————————————————— */

function AboutPanel() {
  const [data, setData] = useState<About | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try { setData(await api<About>("/api/admin/about")); }
    catch (reason) { setError(errorMessage(reason)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error) return <div className="ac-empty"><p>{error}</p><button type="button" className="btn" onClick={() => void load()}>重试</button></div>;
  if (!data) return <div className="ac-empty"><p>载入中…</p></div>;

  return <div className="ac-quotas ac-about">
    <div className="ac-about__head">
      <span className="ac-about__logo"><Info size={22} /></span>
      <div>
        <h3>小黑笔记</h3>
        <p className="ac-muted">自托管的团队笔记与知识库。</p>
      </div>
    </div>
    <dl className="ac-fields">
      <div className="ac-field">
        <dt>版本</dt>
        <dd><strong className="ac-about__value">{data.version ? `v${data.version}` : "未知"}</strong></dd>
      </div>
      <div className="ac-field">
        <dt>代码仓库</dt>
        <dd>
          {data.repository ? <a className="ac-about__link" href={data.repository} target="_blank" rel="noreferrer"><Code2 size={15} /> {data.repository.replace(/^https?:\/\//, "")} <ExternalLink size={13} /></a> : <span className="ac-muted">未在 package.json 中声明。</span>}
        </dd>
      </div>
      <div className="ac-field">
        <dt>运行环境</dt>
        <dd><span className="ac-muted">Node.js {data.node} · 站点时区 {data.timezone}</span></dd>
      </div>
      <div className="ac-field">
        <dt>服务启动于</dt>
        <dd><span className="ac-muted">{formatDateTime(data.startedAt)}</span></dd>
      </div>
      <UpdateCard data={data} />
    </dl>
    <p className="ac-muted ac-about__foot">包标识 {data.name} · 反馈问题请前往仓库提交 Issue。</p>
  </div>;
}

const STEP_LABEL: Record<UpdateStep, string> = {
  download: "下载产物", verify: "校验完整性", unpack: "解包", install: "安装依赖",
  switch: "切换版本", restart: "重启服务", check: "健康检查",
};
const STEP_ORDER = Object.keys(STEP_LABEL) as UpdateStep[];

function UpdateCard({ data }: { data: About }) {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const { toast } = useUi();

  // Poll the durable state file: the runner owns it, so progress survives
  // the service restarting mid-update.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const poll = async () => {
      try {
        const next = await api<UpdateStatus>("/api/admin/update-status");
        if (!stopped) setStatus(next);
        if (next.status === "running" && !stopped) timer = setTimeout(poll, 2000);
      } catch {
        // The service is down mid-restart; keep polling until it returns.
        if (!stopped) timer = setTimeout(poll, 2500);
      }
    };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, []);

  const doCheck = useCallback(async () => {
    setChecking(true); setError("");
    try { setCheck(await api<UpdateCheck>("/api/admin/update-check")); }
    catch (reason) { setCheck(null); setError(errorMessage(reason)); }
    finally { setChecking(false); }
  }, []);

  const apply = useCallback(async () => {
    try {
      const state = await api<UpdateStatus>("/api/admin/update-apply", { method: "POST" });
      setStatus(state);
      toast(`正在更新到 ${state.version}，服务会短暂重启…`);
    } catch (reason) { setError(errorMessage(reason)); }
  }, [toast]);

  const running = status?.status === "running";
  const stepIndex = status?.step ? STEP_ORDER.indexOf(status.step) : -1;
  const progress = running ? Math.round(((stepIndex >= 0 ? stepIndex + 1 : 1) / STEP_ORDER.length) * 100) : 0;
  const releaseUrl = check?.tag ? `${data.repository}/releases/tag/${check.tag}` : null;

  return <div className="ac-field ac-update">
    <dt>版本更新</dt>
    <dd className="ac-update__body">
      {running ? <>
        <p className="ac-update__line"><span className="spinner" aria-hidden="true" />正在更新到 {status?.version} · {status?.step ? STEP_LABEL[status.step] : "准备中"}，服务会短暂不可用。</p>
        <div className="ac-update__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${Math.max(8, progress)}%` }} /></div>
      </> : null}
      {!running && status?.status === "failed" ? <p className="ac-update__line ac-update__line--error"><AlertTriangle size={15} aria-hidden="true" />上次更新在「{status?.step ? STEP_LABEL[status.step] : "未知阶段"}」阶段失败：{status?.error || "原因未知"}</p> : null}
      {!running && status?.status === "applied" ? <p className="ac-update__line ac-update__line--ok"><CheckCircle2 size={15} aria-hidden="true" />已更新到 {status?.version}。</p> : null}
      {!running && check ? (
        check.newer ? (
          <p className="ac-update__line ac-update__line--release">
            <ArrowUpCircle size={15} aria-hidden="true" />
            <span className="ac-update__text">发现新版本 <strong className="ac-about__value">{check.tag}</strong>{check.notes ? ` · ${check.notes.split("\n")[0].slice(0, 120)}` : ""}</span>
          </p>
        ) : <p className="ac-update__line ac-update__line--ok"><CheckCircle2 size={15} aria-hidden="true" />已是最新版本（{check.tag}）</p>
      ) : null}
      {!running && error ? <p className="ac-update__line ac-update__line--error"><AlertTriangle size={15} aria-hidden="true" />{error}</p> : null}
      {!running ? <div className="ac-update__actions">
        {check?.newer ? (
          check.asset
            ? <button type="button" className="btn btn--primary" onClick={() => void apply()}>更新到 {check.tag}</button>
            : <a className="ac-about__link ac-update__manual" href={releaseUrl ?? data.repository} target="_blank" rel="noreferrer">手动升级 <ExternalLink size={13} /></a>
        ) : null}
        <button type="button" className="btn btn--outline" disabled={checking} onClick={() => void doCheck()}>
          <RefreshCw size={14} aria-hidden="true" className={checking ? "spin" : undefined} />{checking ? "检查中…" : check || error ? "重新检查" : "检查更新"}
        </button>
      </div> : null}
    </dd>
  </div>;
}
