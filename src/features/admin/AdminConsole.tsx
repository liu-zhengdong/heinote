import { AlertTriangle, ArrowLeft, BookMarked, HardDrive, Search, Settings2, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Select } from "../../components/Select";
import { ProfileAvatar, personName } from "../../components/ProfileAvatar";
import { useUi } from "../../app/ui-context";
import { useSession } from "../account/AuthGate";
import { api, ApiError, errorMessage } from "../account/api";
import { formatBytes, formatDate, parseBytesInput, type AdminTeam, type AdminUser, type Overview, type QuotaImpact, type QuotaSettings } from "./types";
import "./admin.css";

type Tab = "overview" | "users" | "teams" | "quotas";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "概览" },
  { id: "users", label: "用户" },
  { id: "teams", label: "团队知识库" },
  { id: "quotas", label: "限额设置" },
];

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
  const { busy } = useBusy();
  const root = useRef<HTMLDivElement>(null);

  const openObject = useCallback((kind: "user" | "kb", id: string) => {
    setDetail(true);
    if (kind === "user") { setTab("users"); setSelectedUser(id); }
    else { setTab("teams"); setSelectedTeam(id); }
  }, []);

  useEffect(() => {
    root.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (confirm) setConfirm(null);
      else if (detail) setDetail(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, detail, onClose]);

  const doConfirm = async () => {
    if (!confirm) return;
    setConfirming(true);
    try { await confirm.run(); setConfirm(null); }
    catch (reason) {
      toast(errorMessage(reason), "error");
      setConfirm(null);
    } finally { setConfirming(false); }
  };

  return <div className="admin" ref={root} tabIndex={-1} data-detail={detail ? "1" : undefined} aria-busy={busy || undefined}>
    <header className="admin__top">
      <button type="button" className="btn admin__back" onClick={onClose}><ArrowLeft size={16} />返回笔记</button>
      <strong className="admin__brand">Terminus 笔记</strong>
      <span className="admin__who">{user ? `管理员 · ${personName(user)}` : ""}</span>
    </header>
    <nav className="admin__tabs" role="tablist" aria-label="后台管理">
      {TABS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id}
        className={tab === item.id ? "admin__tab admin__tab--on" : "admin__tab"}
        onClick={() => { setTab(item.id); setDetail(false); }}>{item.label}</button>)}
    </nav>
    <main className="admin__main">
      {tab === "overview" ? <OverviewPanel onOpen={openObject} /> : null}
      {tab === "users" ? <UsersPanel selected={selectedUser} onSelect={(id) => { setSelectedUser(id); setDetail(true); }} onBack={() => setDetail(false)} /> : null}
      {tab === "teams" ? <TeamsPanel selected={selectedTeam} onSelect={(id) => { setSelectedTeam(id); setDetail(true); }} onBack={() => setDetail(false)} /> : null}
      {tab === "quotas" ? <QuotasPanel onConfirm={setConfirm} /> : null}
    </main>
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

function OverviewPanel({ onOpen }: { onOpen(kind: "user" | "kb", id: string): void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try { setData(await api<Overview>("/api/admin/overview")); }
    catch (reason) { setError(errorMessage(reason)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error) return <div className="ac-empty"><p>{error}</p><button type="button" className="btn" onClick={() => void load()}>重试</button></div>;
  if (!data) return <div className="ac-empty"><p>载入中…</p></div>;

  const tiles = [
    { icon: <Users size={16} />, label: "用户", value: String(data.users), hint: `今日新增 ${data.newToday} 位 · 时区 ${data.timezone}` },
    { icon: <BookMarked size={16} />, label: "团队知识库", value: String(data.teams.active), hint: `已归档 ${data.teams.archived} · 合计 ${data.teams.active + data.teams.archived}` },
    { icon: <HardDrive size={16} />, label: "配额占用", value: formatBytes(data.quotaBytes.total), hint: `个人 ${formatBytes(data.quotaBytes.personal)} · 团队 ${formatBytes(data.quotaBytes.teams)}` },
    { icon: <Settings2 size={16} />, label: "实际存储", value: formatBytes(data.disk.databaseBytes + data.disk.attachmentsBytes), hint: `数据库 ${formatBytes(data.disk.databaseBytes)} · 附件 ${formatBytes(data.disk.attachmentsBytes)}${data.disk.freeBytes != null ? ` · 卷可用 ${formatBytes(data.disk.freeBytes)}` : ""}` },
  ];
  return <div className="ac-overview">
    <div className="ac-tiles">
      {tiles.map((tile) => <div className="ac-tile" key={tile.label}>
        <span className="ac-tile__icon">{tile.icon}</span>
        <span className="ac-tile__label">{tile.label}</span>
        <strong className="ac-tile__value">{tile.value}</strong>
        <span className="ac-tile__hint">{tile.hint}</span>
      </div>)}
    </div>
    <section className="ac-queue">
      <h3>需要处理</h3>
      {data.over.length ? <ul className="ac-queue__list">
        {data.over.map((row) => <li key={`${row.kind}:${row.id}`}>
          <button type="button" className="ac-queue__row" onClick={() => onOpen(row.kind, row.id)}>
            <span className="ac-queue__name">{row.label}</span>
            <Meter used={row.used} limit={row.limit} />
            <OverBadge bytes={row.over} />
          </button>
        </li>)}
      </ul> : <p className="ac-muted">所有对象都在限额内。</p>}
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

function LimitEditor({ edit, setEdit, used, source, unit, onSave }: {
  edit: LimitEdit;
  setEdit(edit: LimitEdit): void;
  used: number;
  source: string;
  unit: "GB" | "个";
  onSave(value: number | null): void;
}) {
  if (!edit) return null;
  const value = edit.kind === "storage" ? parseBytesInput(edit.input) : (() => { const n = Number(edit.input.trim()); return Number.isInteger(n) && n >= 0 ? n : null; })();
  const valid = value !== null;
  const lowered = valid && value < used;
  const restored = source === "custom";
  return <div className="ac-edit">
    <label className="ac-edit__row">
      <input type="number" min={unit === "GB" ? "1" : "0"} step="1" value={edit.input} autoFocus
        onChange={(event) => setEdit({ ...edit, input: event.target.value })} />
      <span className="ac-muted">{unit === "GB" ? "GB" : "个"}</span>
    </label>
    {edit.input.trim() !== "" && !valid ? <p className="ac-error">{unit === "GB" ? "限额必须是正数。" : "上限必须是非负整数。"}</p> : null}
    {lowered ? <p className="ac-warn"><AlertTriangle size={13} /> 新{unit === "GB" ? "限额" : "上限"}低于当前用量 {unit === "GB" ? formatBytes(used) : `${used} 个`}。已有内容保留，对象进入超额状态。</p> : null}
    <div className="ac-edit__actions">
      {restored ? <button type="button" className="btn" onClick={() => onSave(null)}>恢复默认</button> : null}
      <button type="button" className="btn" onClick={() => setEdit(null)}>取消</button>
      <button type="button" className="btn btn--primary" disabled={!valid} onClick={() => onSave(value)}>保存</button>
    </div>
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
          <button type="button" className="btn" disabled={busy || Boolean(edit)} onClick={() => setEdit({ kind: "storage", input: String(Math.round(user.storageLimit / 1e8) / 10) })}>调整</button>
          {edit?.kind === "storage" ? <LimitEditor edit={edit} setEdit={setEdit} used={user.storageBytes} source={user.storageSource} unit="GB" onSave={(value) => onSave("storage", value)} /> : null}
        </dd>
      </div>
      <div className="ac-field">
        <dt>团队创建上限 <small className="ac-src">{user.teamLimitSource === "custom" ? "单独设置" : "默认"}</small></dt>
        <dd>
          <span className="ac-teams-line">已拥有 {user.teamCount} 个 · 上限 {user.teamLimit} 个{user.teamCount > user.teamLimit ? <span className="ac-over"><AlertTriangle size={12} /> 超额 {user.teamCount - user.teamLimit} 个</span> : null}</span>
          <button type="button" className="btn" disabled={busy || Boolean(edit)} onClick={() => setEdit({ kind: "teams", input: String(user.teamLimit) })}>调整</button>
          {edit?.kind === "teams" ? <LimitEditor edit={edit} setEdit={setEdit} used={user.teamCount} source={user.teamLimitSource} unit="个" onSave={(value) => onSave("teams", value)} /> : null}
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
              <button type="button" className="btn" disabled={busy || Boolean(edit)} onClick={() => setEdit({ kind: "storage", input: String(Math.round(current.storageLimit / 1e8) / 10) })}>调整</button>
              {edit?.kind === "storage" ? <LimitEditor edit={edit} setEdit={setEdit} used={current.storageBytes} source={current.storageSource} unit="GB" onSave={(value) => void saveLimit(current, value)} /> : null}
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
          <button type="button" className="btn" disabled={busy || Boolean(edit)} onClick={() => setEdit({ key: row.key, input: String(row.gb) })}>调整</button>
        </div>
      </li>)}
    </ul>
  </div>;
}
