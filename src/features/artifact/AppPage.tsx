import { useMemo, useState } from "react";
import { Code2, Database, Eye, Trash2 } from "lucide-react";
import type { NotePage } from "../../core/types";
import { APP_SOURCE_BUDGET_BYTES } from "../../core/artifact";
import { AppSurface } from "./AppSurface";
import { usePages } from "../../app/workspace-store";
import { useWorkspace } from "../../app/workspace-context";
import { spaceOfPage } from "../../core/page-tree";
import "./artifact.css";

/** The app page itself: the same run surface members see embedded, plus
 *  the source draft and the bound databases beside it. Everything here is
 *  a page-record patch — saved through `updatePage`, so it rides the same
 *  collaboration and history as the page's name. */

interface Props {
  page: NotePage;
}

export function AppPage({ page }: Props) {
  const pages = usePages();
  const { canEdit, updatePage } = useWorkspace();
  const editable = canEdit(page.id);
  const app = page.app ?? {};
  const [draft, setDraft] = useState(app.draft ?? "");
  const [dirty, setDirty] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [bindOpen, setBindOpen] = useState(false);
  const [pickId, setPickId] = useState("");
  const [pickWrite, setPickWrite] = useState(false);

  const shown = dirty ? draft : (app.draft ?? "");
  const bindings = app.databases ?? [];
  const appScope = spaceOfPage(pages, page.id);
  const databases = useMemo(
    () => Object.values(pages).filter((entry) => entry.kind === "database" && !entry.archived && spaceOfPage(pages, entry.id) === appScope),
    [pages, appScope],
  );
  const boundIds = useMemo(() => new Set(bindings.map((binding) => binding.id)), [bindings]);
  const sourceBytes = useMemo(() => new TextEncoder().encode(shown).length, [shown]);
  const overBudget = sourceBytes > APP_SOURCE_BUDGET_BYTES;

  const saveDraft = () => {
    updatePage(page.id, { app: { ...(page.app ?? {}), draft: shown } });
    setDirty(false);
  };
  const enable = () => {
    if (!shown.trim()) return;
    updatePage(page.id, { app: { ...(page.app ?? {}), enabled: shown } });
    setDraft("");
    setDirty(false);
    setPreviewing(false);
  };
  const bind = (id: string, write: boolean) => {
    const next = [...bindings.filter((binding) => binding.id !== id), { id, read: true, write }];
    updatePage(page.id, { app: { ...(page.app ?? {}), databases: next } });
  };
  const unbind = (id: string) => {
    updatePage(page.id, { app: { ...(page.app ?? {}), databases: bindings.filter((binding) => binding.id !== id) } });
  };
  const toggleWrite = (id: string) => {
    updatePage(page.id, {
      app: { ...(page.app ?? {}), databases: bindings.map((binding) => binding.id === id ? { ...binding, write: !binding.write } : binding) },
    });
  };

  return (
    <div className="app-page">
      <AppSurface page={page} previewSource={previewing ? shown : null} />

      {editable && (
        <section className="app-editor">
          <header className="app-editor__head">
            <Code2 size={14} aria-hidden="true" />
            <span className="app-editor__title">源码</span>
            <span className="app-editor__spacer" />
            <button type="button" className="app-editor__btn" onClick={() => setPreviewing((open) => !open)} disabled={!shown}>
              <Eye size={13} aria-hidden="true" />{previewing ? "关闭预览" : "预览"}
            </button>
            <button type="button" className="app-editor__btn" onClick={saveDraft} disabled={!dirty || overBudget}>
              保存草稿
            </button>
            <button type="button" className="app-editor__btn app-editor__btn--primary" onClick={enable} disabled={!shown.trim() || overBudget}>
              启用
            </button>
          </header>
          <textarea
            className="app-editor__source"
            value={shown}
            spellCheck={false}
            placeholder="粘贴或编写 HTML 小应用的源码。包含脚本的应用需要成员手动运行。"
            onChange={(event) => { setDraft(event.target.value); setDirty(true); }}
          />
          <p className="app-editor__hint">
            {overBudget ? "超过 2MB 上限。" : `${Math.round(sourceBytes / 1024)} KB / 2048 KB`}{" "}
            预览只读，不会写入数据源；启用后成员看到的是启用版。
          </p>
        </section>
      )}

      <section className="app-editor app-editor--bind">
        <header className="app-editor__head">
          <Database size={14} aria-hidden="true" />
          <span className="app-editor__title">数据源</span>
          <span className="app-editor__spacer" />
          {editable && (
            <button type="button" className="app-editor__btn" onClick={() => setBindOpen((open) => !open)}>绑定</button>
          )}
        </header>
        {bindings.length === 0 && !bindOpen && (
          <p className="app-editor__hint">未绑定数据源。应用仍可运行，但不能读写 Notes 数据。</p>
        )}
        {bindings.map((binding) => (
          <div key={binding.id} className="app-editor__binding">
            <span className="app-editor__binding-name">{pages[binding.id]?.title || binding.id}</span>
            <span className="app-editor__binding-caps">{binding.write ? "读写" : "只读"}</span>
            {editable && (
              <>
                <button type="button" className="app-editor__btn" onClick={() => toggleWrite(binding.id)}>
                  改为{binding.write ? "只读" : "读写"}
                </button>
                <button type="button" className="app-editor__btn app-editor__btn--danger" onClick={() => unbind(binding.id)}>
                  <Trash2 size={12} aria-hidden="true" />
                </button>
              </>
            )}
          </div>
        ))}
        {bindOpen && editable && (
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
            <button type="button" className="app-editor__btn app-editor__btn--primary"
              disabled={!pickId}
              onClick={() => { bind(pickId, pickWrite); setPickId(""); setPickWrite(false); }}>
              添加
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
