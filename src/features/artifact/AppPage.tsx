import { useMemo, useState } from "react";
import { ChevronUp, Code2, Database, Eye, Plus, Settings2 } from "lucide-react";
import type { NotePage } from "../../core/types";
import { APP_SOURCE_BUDGET_BYTES } from "../../core/artifact";
import { AppSurface } from "./AppSurface";
import { usePages } from "../../app/workspace-store";
import { useWorkspace } from "../../app/workspace-context";
import { spaceOfPage } from "../../core/page-tree";
import "./artifact.css";

/** The app page itself: the running app is the page's body. Source,
 *  bindings and settings live in the manage sheet at the bottom — the
 *  strip beside it keeps their state visible without a mode switch.
 *  Everything here is a page-record patch — saved through `updatePage`,
 *  so it rides the same collaboration and history as the page's name. */

interface Props {
  page: NotePage;
}

type SheetTab = "data" | "code" | "general";

const KB = 1024;
const sizeLabel = (bytes: number) => `${Math.round(bytes / KB)} KB`;

/** One bound database as the sheet's inspector shows it: the properties
 *  the app may call, the three rows touched last, and the direction it
 *  holds in `app.databases`. */
function BindingDetail({
  db,
  write,
  rows,
  editable,
  onDirection,
  onUnbind,
  onOpen,
}: {
  db: NotePage | undefined;
  write: boolean;
  rows: NotePage[];
  editable: boolean;
  onDirection: (write: boolean) => void;
  onUnbind: () => void;
  onOpen: () => void;
}) {
  const props = db?.database?.properties ?? [];
  const missing = !db;
  return (
    <div className="app-inspect">
      <header className="app-inspect__head">
        <span className="app-inspect__icon"><Database size={16} aria-hidden="true" /></span>
        <div className="app-inspect__id">
          <h3>{db?.title || "未命名数据库"}</h3>
          <p className="app-inspect__sub">
            数据库 · {write ? "读写" : "只读"} · {rows.length ? `${rows.length}+ 条` : "暂无条目"}
          </p>
        </div>
        {editable && !missing && (
          <div className="app-seg" role="group" aria-label="读写方向">
            <button type="button" className={!write ? "is-on" : ""} onClick={() => onDirection(false)}>只读</button>
            <button type="button" className={write ? "is-on" : ""} onClick={() => onDirection(true)}>读写</button>
          </div>
        )}
      </header>
      {missing && <p className="app-inspect__hint">数据源已删除或不可见；应用调用它会失败，可解除绑定。</p>}
      {props.length > 0 && (
        <section className="app-inspect__sec">
          <p className="app-inspect__lbl">字段</p>
          {props.map((prop) => (
            <div key={prop.id} className="app-inspect__row">
              <span className="app-inspect__name">{prop.name}</span>
              <span className="app-inspect__type">{prop.type}</span>
            </div>
          ))}
        </section>
      )}
      {rows.length > 0 && (
        <section className="app-inspect__sec">
          <p className="app-inspect__lbl">最近更新</p>
          {rows.map((row) => (
            <div key={row.id} className="app-inspect__row">
              <span className="app-inspect__name">{row.title || "未命名"}</span>
              <span className="app-inspect__type">{row.updated_at?.slice(0, 10)}</span>
            </div>
          ))}
        </section>
      )}
      <footer className="app-inspect__foot">
        {!missing && <button type="button" className="app-editor__btn" onClick={onOpen}>打开数据源</button>}
        {editable && (
          <button type="button" className="app-editor__btn app-editor__btn--danger" onClick={onUnbind}>解除绑定</button>
        )}
      </footer>
    </div>
  );
}

export function AppPage({ page }: Props) {
  const pages = usePages();
  const { canEdit, updatePage, selectPage } = useWorkspace();
  const editable = canEdit(page.id);
  const app = page.app ?? {};
  const [draft, setDraft] = useState(app.draft ?? "");
  const [dirty, setDirty] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [sheet, setSheet] = useState<SheetTab | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pickId, setPickId] = useState("");
  const [pickWrite, setPickWrite] = useState(false);
  const [adding, setAdding] = useState(false);

  const shown = dirty ? draft : (app.draft ?? app.enabled ?? "");
  const bindings = app.databases ?? [];
  const appScope = spaceOfPage(pages, page.id);
  const databases = useMemo(
    () => Object.values(pages).filter((entry) => entry.kind === "database" && !entry.archived && spaceOfPage(pages, entry.id) === appScope),
    [pages, appScope],
  );
  const boundIds = useMemo(() => new Set(bindings.map((binding) => binding.id)), [bindings]);
  const sourceBytes = useMemo(() => new TextEncoder().encode(shown).length, [shown]);
  const overBudget = sourceBytes > APP_SOURCE_BUDGET_BYTES;
  const hasDraft = Boolean(app.draft?.trim());

  const rowsOf = useMemo(() => {
    const map = new Map<string, NotePage[]>();
    for (const binding of bindings) {
      const rows = Object.values(pages)
        .filter((entry) => entry.parent_id === binding.id && !entry.archived)
        .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
      map.set(binding.id, rows);
    }
    return map;
  }, [bindings, pages]);

  const patchApp = (next: Partial<NonNullable<NotePage["app"]>>) =>
    updatePage(page.id, { app: { ...(page.app ?? {}), ...next } });
  const saveDraft = () => { patchApp({ draft: shown }); setDirty(false); };
  const enable = () => {
    if (!shown.trim()) return;
    patchApp({ enabled: shown });
    setDraft("");
    setDirty(false);
    setPreviewing(false);
  };
  const bind = (id: string, write: boolean) => {
    patchApp({ databases: [...bindings.filter((b) => b.id !== id), { id, read: true, write }] });
    setSelected(id);
  };
  const unbind = (id: string) => {
    patchApp({ databases: bindings.filter((b) => b.id !== id) });
    if (selected === id) setSelected(null);
  };
  const direction = (id: string, write: boolean) => {
    patchApp({ databases: bindings.map((b) => (b.id === id ? { ...b, write } : b)) });
  };

  const openSheet = (tab: SheetTab) => {
    setSheet((current) => (current === tab ? null : tab));
    if (tab === "data" && !selected && bindings.length > 0) setSelected(bindings[0].id);
  };
  const status = page.app?.enabled ? (hasDraft ? "有草稿" : "已启用") : "未启用";

  return (
    <div className={`app-page${sheet ? " app-page--sheet" : ""}`}>
      <div className="app-stage">
        <AppSurface page={page} previewSource={previewing ? shown : null} grow />
      </div>

      {sheet && (
        <div className="app-sheet" role="dialog" aria-label="应用管理">
          <header className="app-sheet__head">
            <div className="app-seg" role="tablist">
              <button type="button" role="tab" aria-selected={sheet === "data"} className={sheet === "data" ? "is-on" : ""} onClick={() => openSheet("data")}>数据源</button>
              <button type="button" role="tab" aria-selected={sheet === "code"} className={sheet === "code" ? "is-on" : ""} onClick={() => openSheet("code")}>源码</button>
              <button type="button" role="tab" aria-selected={sheet === "general"} className={sheet === "general" ? "is-on" : ""} onClick={() => openSheet("general")}>通用</button>
            </div>
            <span className="app-sheet__spacer" />
            <button type="button" className="app-editor__btn" onClick={() => setSheet(null)} aria-label="收起管理面板">
              <ChevronUp size={13} aria-hidden="true" />
            </button>
          </header>

          {sheet === "data" && (
            <div className="app-sheet__data">
              <aside className="app-ds-list" aria-label="数据源列表">
                {bindings.map((binding) => {
                  const db = pages[binding.id];
                  return (
                    <button
                      key={binding.id}
                      type="button"
                      className={`app-ds-list__item${selected === binding.id ? " is-on" : ""}`}
                      onClick={() => setSelected(binding.id)}
                    >
                      <Database size={14} aria-hidden="true" />
                      <span className="app-ds-list__text">
                        <span className="app-ds-list__name">{db?.title || "未命名数据库"}</span>
                        <span className="app-ds-list__sub">{binding.write ? "读写" : "只读"} · {(rowsOf.get(binding.id) ?? []).length} 条</span>
                      </span>
                    </button>
                  );
                })}
                {bindings.length === 0 && <p className="app-inspect__hint">未绑定数据源。应用仍可运行，但不能读写小黑笔记数据。</p>}
                {editable && (
                  <button type="button" className="app-ds-list__add" onClick={() => setAdding((open) => !open)}>
                    <Plus size={14} aria-hidden="true" />添加数据源
                  </button>
                )}
              </aside>
              <div className="app-sheet__detail">
                {adding && (
                  <div className="app-editor__picker">
                    <select value={pickId} onChange={(event) => setPickId(event.target.value)}>
                      <option value="">选择数据库…</option>
                      {databases.filter((db) => !boundIds.has(db.id)).map((db) => (
                        <option key={db.id} value={db.id}>{db.title || "未命名数据库"}</option>
                      ))}
                    </select>
                    <label className="app-editor__check">
                      <input type="checkbox" checked={pickWrite} onChange={(event) => setPickWrite(event.target.checked)} />
                      允许写入
                    </label>
                    <button
                      type="button"
                      className="app-editor__btn app-editor__btn--primary"
                      disabled={!pickId}
                      onClick={() => { bind(pickId, pickWrite); setPickId(""); setPickWrite(false); setAdding(false); }}
                    >
                      添加
                    </button>
                  </div>
                )}
                {selected && bindings.some((b) => b.id === selected) ? (
                  <BindingDetail
                    db={pages[selected]}
                    write={bindings.find((b) => b.id === selected)?.write ?? false}
                    rows={rowsOf.get(selected) ?? []}
                    editable={editable}
                    onDirection={(write) => direction(selected, write)}
                    onUnbind={() => unbind(selected)}
                    onOpen={() => selectPage(selected)}
                  />
                ) : !adding ? (
                  <p className="app-inspect__hint">在左侧选择一个数据源查看绑定详情。</p>
                ) : null}
              </div>
            </div>
          )}

          {sheet === "code" && (
            <div className="app-sheet__code">
              <header className="app-editor__head">
                <Code2 size={14} aria-hidden="true" />
                <span className="app-editor__title">index.html</span>
                <span className="app-inspect__sub">{sizeLabel(sourceBytes)} / 2048 KB{hasDraft ? " · 草稿" : ""}{app.enabled ? " · 已启用" : ""}</span>
                <span className="app-editor__spacer" />
                <button type="button" className="app-editor__btn" onClick={() => setPreviewing((open) => !open)} disabled={!shown}>
                  <Eye size={13} aria-hidden="true" />{previewing ? "关闭预览" : "预览"}
                </button>
                <button type="button" className="app-editor__btn" onClick={saveDraft} disabled={!dirty || overBudget}>保存草稿</button>
                <button type="button" className="app-editor__btn app-editor__btn--primary" onClick={enable} disabled={!shown.trim() || overBudget}>
                  {app.enabled ? "更新启用版" : "启用"}
                </button>
              </header>
              <textarea
                className="app-editor__source"
                value={shown}
                spellCheck={false}
                placeholder="粘贴或编写 HTML 小应用的源码。启用后打开即运行。"
                onChange={(event) => { setDraft(event.target.value); setDirty(true); }}
              />
              <p className="app-editor__hint">
                {overBudget ? "超过 2MB 上限。" : ""}预览只读，不会写入数据源；启用后成员看到的是启用版。
              </p>
            </div>
          )}

          {sheet === "general" && (
            <div className="app-sheet__general">
              <section className="app-inspect__sec">
                <p className="app-inspect__lbl">运行</p>
                <div className="app-inspect__row"><span className="app-inspect__name">状态</span><span className="app-inspect__type">{status}</span></div>
                <div className="app-inspect__row"><span className="app-inspect__name">创建</span><span className="app-inspect__type">{page.created_at?.slice(0, 10)}</span></div>
                <div className="app-inspect__row"><span className="app-inspect__name">更新</span><span className="app-inspect__type">{page.updated_at?.slice(0, 10)}</span></div>
                <div className="app-inspect__row"><span className="app-inspect__name">数据源</span><span className="app-inspect__type">{bindings.length} 个 · 与应用同一权限范围</span></div>
              </section>
              <p className="app-editor__hint">名称在页头修改；收藏、分享与回收站沿用页面入口。</p>
            </div>
          )}
        </div>
      )}

      <div className="app-strip" aria-label="应用状态摘要">
        <button type="button" className="app-strip__item" onClick={() => openSheet("data")}>
          <Database size={13} aria-hidden="true" />数据源 {bindings.length}
        </button>
        <span className="app-strip__sep" />
        <button type="button" className="app-strip__item" onClick={() => openSheet("code")}>
          <Code2 size={13} aria-hidden="true" />index.html · {sizeLabel(sourceBytes)}
        </button>
        <span className="app-strip__sep" />
        <span className="app-strip__item app-strip__item--static">
          <span className={`app-strip__dot${page.app?.enabled ? " is-on" : ""}`} />{status}
        </span>
        <span className="app-strip__spacer" />
        <button type="button" className="app-editor__btn" onClick={() => openSheet(sheet ?? "data")}>
          <Settings2 size={13} aria-hidden="true" />{sheet ? "收起" : "管理"}
        </button>
      </div>
    </div>
  );
}
