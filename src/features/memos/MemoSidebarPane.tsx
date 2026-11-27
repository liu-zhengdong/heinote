import { ChevronDown, ChevronRight, Hash, Pencil, Pin, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useUi } from "../../app/ui-context";
import { Modal } from "../../components/Modal";
import type { MemoTagNode } from "../../core/memos";
import { deleteMemoTag, listMemoTags, renameMemoTag, setPinnedMemoTags } from "./memo-api";

export function MemoSidebarPane() {
  const {
    memoTagFilter,
    setMemoTagFilter,
    setMemoQuickFilter,
    memoRefreshNonce,
    bumpMemoRefresh,
    setDrawerOpen,
    toast,
  } = useUi();

  const [tags, setTags] = useState<MemoTagNode[]>([]);
  const [pinnedTags, setPinnedTags] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);

  const loadTags = useCallback((signal?: AbortSignal) => {
    void listMemoTags(signal)
      .then((res) => {
        setTags(res.tags);
        setPinnedTags(res.pinnedTags);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadTags(controller.signal);
    return () => controller.abort();
  }, [loadTags, memoRefreshNonce]);

  const selectTag = (path: string) => {
    setMemoTagFilter(memoTagFilter === path ? null : path);
    setMemoQuickFilter("all");
    setDrawerOpen(false);
  };

  const togglePinTag = async (path: string) => {
    const next = pinnedTags.includes(path)
      ? pinnedTags.filter((item) => item !== path)
      : [...pinnedTags, path];
    setPinnedTags(next);
    try {
      const res = await setPinnedMemoTags(next);
      setPinnedTags(res.pinnedTags);
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "置顶标签失败。", "error");
      loadTags();
    }
  };

  const confirmRename = async () => {
    if (!renaming || busy) return;
    const next = renameValue.trim().replace(/^#+/, "").replace(/^\/+|\/+$/g, "");
    if (!next || next === renaming) {
      setRenaming(null);
      return;
    }
    setBusy(true);
    try {
      const res = await renameMemoTag(renaming, next);
      setTags(res.tags);
      setPinnedTags(res.pinnedTags);
      if (memoTagFilter && (memoTagFilter === renaming || memoTagFilter.startsWith(`${renaming}/`))) {
        setMemoTagFilter(memoTagFilter === renaming ? next : `${next}${memoTagFilter.slice(renaming.length)}`);
      }
      setRenaming(null);
      bumpMemoRefresh();
      toast(`已将 #${renaming} 重命名为 #${next}`, "success");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "重命名标签失败。", "error");
    } finally {
      setBusy(false);
    }
  };

  const removeTag = async (path: string) => {
    try {
      const res = await deleteMemoTag(path);
      setTags(res.tags);
      setPinnedTags(res.pinnedTags);
      if (memoTagFilter && (memoTagFilter === path || memoTagFilter.startsWith(`${path}/`))) {
        setMemoTagFilter(null);
      }
      bumpMemoRefresh();
      toast(`已移除标签 #${path}（原闪念正文保留）`, "info");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "移除标签失败。", "error");
    }
  };

  const countByPath = (nodes: MemoTagNode[], map = new Map<string, number>()): Map<string, number> => {
    for (const node of nodes) {
      map.set(node.path, node.count);
      if (node.children.length) countByPath(node.children, map);
    }
    return map;
  };
  const countsMap = countByPath(tags);
  const activePinned = pinnedTags.filter((path) => countsMap.has(path));

  const renderNode = (node: MemoTagNode, depth = 0) => {
    const hasChildren = node.children.length > 0;
    const isCollapsed = Boolean(collapsed[node.path]);
    const isActive = memoTagFilter === node.path;
    const isPinned = pinnedTags.includes(node.path);

    return (
      <div key={node.path}>
        <div
          className={`tree-row memo-tag-row ${isActive ? "is-selected" : ""}`}
          style={{ ["--tree-depth" as string]: depth }}
        >
          <span
            className="tree-row__main"
            role="button"
            tabIndex={0}
            onClick={() => selectTag(node.path)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                selectTag(node.path);
              }
            }}
          >
            {hasChildren ? (
              <button
                type="button"
                className="tree-row__toggle"
                aria-label={isCollapsed ? "展开子标签" : "收起子标签"}
                onClick={(event) => {
                  event.stopPropagation();
                  setCollapsed((prev) => ({ ...prev, [node.path]: !prev[node.path] }));
                }}
              >
                {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              </button>
            ) : (
              <span className="tree-row__toggle tree-row__toggle--leaf" aria-hidden="true" />
            )}
            <span className="tree-row__glyph" aria-hidden="true"><Hash size={13} /></span>
            <span className="tree-row__title">{node.name}</span>
            <span className="sidebar__view-count">{node.count}</span>
          </span>
          <span className="tree-row__actions">
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label={isPinned ? `取消置顶标签 ${node.path}` : `置顶标签 ${node.path}`}
              title={isPinned ? "取消置顶" : "置顶标签"}
              onClick={(event) => { event.stopPropagation(); void togglePinTag(node.path); }}
            >
              <Pin size={12} />
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label={`重命名标签 ${node.path}`}
              title="重命名标签"
              onClick={(event) => {
                event.stopPropagation();
                setRenaming(node.path);
                setRenameValue(node.path);
              }}
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label={`移除标签 ${node.path}`}
              title="移除标签（保留闪念正文）"
              onClick={(event) => { event.stopPropagation(); void removeTag(node.path); }}
            >
              <Trash2 size={12} />
            </button>
          </span>
        </div>
        {hasChildren && !isCollapsed ? (
          <div className="tree-children" style={{ ["--tree-depth" as string]: depth }}>
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <>
      {activePinned.length ? (
        <section className="sidebar__group" aria-label="置顶标签">
          <h3 className="sidebar__group-title"><span>置顶标签</span></h3>
          {activePinned.map((path) => (
            <div key={path} className={`tree-row memo-tag-row ${memoTagFilter === path ? "is-selected" : ""}`}>
              <span
                className="tree-row__main"
                role="button"
                tabIndex={0}
                onClick={() => selectTag(path)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectTag(path);
                  }
                }}
              >
                <span className="tree-row__toggle tree-row__toggle--leaf" aria-hidden="true" />
                <span className="tree-row__glyph" aria-hidden="true"><Hash size={13} /></span>
                <span className="tree-row__title">{path}</span>
                <span className="sidebar__view-count">{countsMap.get(path) ?? 0}</span>
              </span>
              <span className="tree-row__actions">
                <button
                  type="button"
                  className="icon-btn icon-btn--sm"
                  aria-label={`取消置顶标签 ${path}`}
                  title="取消置顶"
                  onClick={(event) => { event.stopPropagation(); void togglePinTag(path); }}
                >
                  <Pin size={12} />
                </button>
              </span>
            </div>
          ))}
        </section>
      ) : null}

      <section className="sidebar__group" aria-label="全部标签">
        <h3 className="sidebar__group-title"><span>标签</span></h3>
        {tags.length ? tags.map((node) => renderNode(node, 0)) : (
          <div className="sidebar__empty">
            <p>正文输入 <code>#标签</code> 自动归类</p>
          </div>
        )}
      </section>

      <Modal open={Boolean(renaming)} label="重命名标签" onClose={() => setRenaming(null)} className="memo-modal">
        <h2>重命名标签 #{renaming}</h2>
        <input
          className="memo-modal__input"
          autoFocus
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void confirmRename();
            }
          }}
        />
        <div className="memo-modal__note">
          将同步改写所有匹配卡片及子标签前缀正文里的 <code>#标签</code>。
        </div>
        <div className="memo-modal__actions">
          <button type="button" className="btn" onClick={() => setRenaming(null)}>取消</button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void confirmRename()}>
            保存
          </button>
        </div>
      </Modal>
    </>
  );
}
