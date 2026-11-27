import {
  ArrowUpRight,
  AtSign,
  CheckSquare,
  Hash,
  Image as ImageIcon,
  MessageSquare,
  Pencil,
  Pin,
  Search,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useUi, type MemoQuickFilter } from "../../app/ui-context";
import { useWorkspace } from "../../app/workspace-context";
import { useWorkspaceState } from "../../app/workspace-store";
import { Modal } from "../../components/Modal";
import { BLOCK_ORDER_STEP, createBlock, orderedBlocks, pageName } from "../../core/block-tree";
import { createId } from "../../core/ids";
import { MENTION_CHAR } from "../../core/inline-content";
import { imeComposing } from "../../core/keyboard";
import { memoSummaryTitle, type MemoTagNode } from "../../core/memos";
import { inTrash, isPurging, isShelved } from "../../core/page-tree";
import { pagesInSpace } from "../../core/space-navigation";
import type { Block, BlockTree, InlineContent, LoadedNotePage, NotePage, StoredFile } from "../../core/types";
import { DocumentEditor } from "../editor/DocumentEditor";
import { editableWithin, focusAtEnd } from "../editor/selection";
import { MemoBlocksView } from "./MemoBlocksView";
import {
  createMemo,
  listMemos,
  listMemoTags,
  memoFileUrl,
  promoteMemo,
  trashMemo,
  updateMemo,
  uploadMemoImage,
  type MemoCommentDto,
  type MemoCounts,
  type MemoDto,
} from "./memo-api";
import "./memos.css";

const EMPTY_COUNTS: MemoCounts = { all: 0, pinned: 0, commented: 0, untagged: 0, trashed: 0 };

function fullTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 16).replace("T", " ");
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 16).replace("T", " ");
  const pad = (value: number) => String(value).padStart(2, "0");
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfDate) / 86_400_000);
  if (dayDiff === 0) return `今天 ${hm}`;
  if (dayDiff === 1) return `昨天 ${hm}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
}

function flattenTagPaths(nodes: MemoTagNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    out.push(node.path);
    if (node.children.length) flattenTagPaths(node.children, out);
  }
  return out;
}

function freshBlankTree(): BlockTree {
  const id = createId("block");
  return { by_id: { [id]: createBlock(id) } };
}

function makeStandalonePage(id: string, tree: BlockTree): LoadedNotePage {
  const now = new Date().toISOString();
  return {
    id,
    kind: "document",
    icon: "",
    title: "",
    title_content: [],
    parent_id: null,
    created_at: now,
    updated_at: now,
    created_by: "",
    updated_by: "",
    block_tree: tree,
  };
}

function hasTreeContent(tree: BlockTree): boolean {
  return Object.values(tree.by_id).some((block) => (
    block.kind === "divider"
    || (block.kind === "file" && Boolean(block.file))
    || (block.kind === "embed" && Boolean(block.embed))
    || block.kind === "table"
    || block.content.some((run) => Boolean(run.mention) || Boolean(run.text.trim()))
  ));
}

function treeSignature(tree: BlockTree): string {
  return JSON.stringify(orderedBlocks(tree));
}

function appendInlineToLastBlock(tree: BlockTree, runs: InlineContent): { tree: BlockTree; focusId: string } {
  const roots = orderedBlocks(tree, null);
  const last = roots.at(-1);
  if (last && last.kind !== "code" && last.kind !== "divider" && last.kind !== "file" && last.kind !== "table" && last.kind !== "embed") {
    const nextBlock: Block = {
      ...last,
      content: [...last.content, ...runs],
    };
    return {
      tree: { by_id: { ...tree.by_id, [last.id]: nextBlock } },
      focusId: last.id,
    };
  }
  const blockId = createId("block");
  const order = (last?.order ?? 0) + BLOCK_ORDER_STEP;
  return {
    tree: { by_id: { ...tree.by_id, [blockId]: createBlock(blockId, "text", { order, content: runs }) } },
    focusId: blockId,
  };
}

function appendBlockKindToTree(tree: BlockTree, kind: "todo", extra?: Partial<Block>): { tree: BlockTree; focusId: string } {
  const roots = orderedBlocks(tree, null);
  const last = roots.at(-1);
  if (last && last.kind === "text" && last.content.length === 0) {
    const converted: Block = { ...last, kind, checked: false, ...extra };
    return {
      tree: { by_id: { ...tree.by_id, [last.id]: converted } },
      focusId: last.id,
    };
  }
  const blockId = createId("block");
  const order = (last?.order ?? 0) + BLOCK_ORDER_STEP;
  return {
    tree: { by_id: { ...tree.by_id, [blockId]: createBlock(blockId, kind, { order, checked: false, ...extra }) } },
    focusId: blockId,
  };
}

export function MemoStream({ onSurfaceRef }: { onSurfaceRef?: (el: HTMLElement | null) => void }) {
  const { selectPage, setPreference, openLocatedPage, spaces } = useWorkspace();
  const {
    memoQuickFilter,
    setMemoQuickFilter,
    memoTagFilter,
    setMemoTagFilter,
    memoTarget,
    memoRefreshNonce,
    bumpMemoRefresh,
    memoFocusNonce,
    toast,
  } = useUi();

  const allPages = useWorkspaceState((state) => state.pages);
  const personalPages = useMemo(() => {
    const scoped = pagesInSpace(allPages, spaces, "personal");
    return Object.values(scoped)
      .filter((page) => page.kind !== "memo" && !inTrash(allPages, page.id) && !isPurging(allPages, page.id) && !isShelved(allPages, page.id))
      .toSorted((left, right) => (right.updated_at ?? "").localeCompare(left.updated_at ?? ""));
  }, [allPages, spaces]);

  const [memos, setMemos] = useState<MemoDto[]>([]);
  const [counts, setCounts] = useState<MemoCounts>(EMPTY_COUNTS);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [streamQuery, setStreamQuery] = useState("");
  const [allTagPaths, setAllTagPaths] = useState<string[]>([]);

  // Composer state powered by DocumentEditor standalone
  const [composerEpoch, setComposerEpoch] = useState(1);
  const [composerTree, setComposerTree] = useState<BlockTree>(() => freshBlankTree());
  const composerTreeRef = useRef(composerTree);
  composerTreeRef.current = composerTree;
  const [submitting, setSubmitting] = useState(false);
  const [composerShake, setComposerShake] = useState(false);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const composerWrapRef = useRef<HTMLElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const composerPage = useMemo(
    () => makeStandalonePage(`memo-composer-${composerEpoch}`, composerTree),
    [composerEpoch, composerTree],
  );

  // Card & comment inline DocumentEditor states
  const [expandedComments, setExpandedComments] = useState<Record<string, boolean>>({});
  const [expandedLong, setExpandedLong] = useState<Record<string, boolean>>({});
  const [editingMemo, setEditingMemo] = useState<{ memo: MemoDto; tree: BlockTree; baseSig: string } | null>(null);
  const editingMemoRef = useRef(editingMemo);
  editingMemoRef.current = editingMemo;
  const savingMemoIdRef = useRef<string | null>(null);

  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [editingComment, setEditingComment] = useState<{ memoId: string; comment: MemoCommentDto; tree: BlockTree; baseSig: string } | null>(null);
  const editingCommentRef = useRef(editingComment);
  editingCommentRef.current = editingComment;
  const savingCommentIdRef = useRef<string | null>(null);

  const [promoteTarget, setPromoteTarget] = useState<MemoDto | null>(null);
  const [promoteTitle, setPromoteTitle] = useState("");
  const [promoting, setPromoting] = useState(false);
  const [previewFile, setPreviewFile] = useState<StoredFile | null>(null);
  const [flashMemoId, setFlashMemoId] = useState<string | null>(null);
  const [flashCommentId, setFlashCommentId] = useState<string | null>(null);

  const loadedOnceRef = useRef(false);
  const surfaceRef = useRef<HTMLElement | null>(null);
  const attachSurface = useCallback((el: HTMLElement | null) => {
    surfaceRef.current = el;
    onSurfaceRef?.(el);
  }, [onSurfaceRef]);

  const loadStream = useCallback((aroundId?: string) => {
    const controller = new AbortController();
    if (!loadedOnceRef.current) setLoading(true);
    void Promise.all([
      listMemos({
        limit: 30,
        filter: memoQuickFilter,
        tag: memoTagFilter,
        q: streamQuery,
        around: aroundId,
        signal: controller.signal,
      }),
      listMemoTags(controller.signal),
    ])
      .then(([listRes, tagRes]) => {
        if (controller.signal.aborted) return;
        loadedOnceRef.current = true;
        setMemos(listRes.memos);
        setCounts(listRes.counts);
        setNextCursor(listRes.nextCursor);
        setHasMore(listRes.hasMore);
        setAllTagPaths(flattenTagPaths(tagRes.tags));
        setLoading(false);
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        loadedOnceRef.current = true;
        setLoading(false);
        toast(reason instanceof Error ? reason.message : "加载闪念失败。", "error");
      });
    return () => controller.abort();
  }, [memoQuickFilter, memoTagFilter, streamQuery, toast]);

  useEffect(() => loadStream(memoTarget?.memoId), [loadStream, memoRefreshNonce, memoTarget?.memoId]);

  const focusComposerBlock = useCallback((blockId?: string) => {
    window.setTimeout(() => {
      const container = composerWrapRef.current?.querySelector<HTMLElement>(".blocks") ?? null;
      const targetId = blockId ?? orderedBlocks(composerTreeRef.current, null)[0]?.id;
      const editable = (targetId ? editableWithin(container, targetId) : null)
        ?? composerWrapRef.current?.querySelector<HTMLElement>(".block__editable");
      if (editable) focusAtEnd(editable);
    }, 30);
  }, []);

  useEffect(() => {
    if (!memoFocusNonce) return;
    surfaceRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    focusComposerBlock();
  }, [focusComposerBlock, memoFocusNonce]);

  useEffect(() => {
    if (!memoTarget) return;
    const { memoId, commentId } = memoTarget;
    if (commentId) setExpandedComments((prev) => ({ ...prev, [memoId]: true }));
    setFlashMemoId(memoId);
    setFlashCommentId(commentId ?? null);
    const scrollTimer = window.setTimeout(() => {
      const targetEl = document.getElementById(commentId ? `memo-comment-${commentId}` : `memo-card-${memoId}`);
      targetEl?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    const clearTimer = window.setTimeout(() => {
      setFlashMemoId(null);
      setFlashCommentId(null);
    }, 1700);
    return () => {
      window.clearTimeout(scrollTimer);
      window.clearTimeout(clearTimer);
    };
  }, [memoTarget, memos.length]);

  const handleFollowLink = useCallback((pageId: string) => {
    if (!pageId || !allPages[pageId]) return;
    selectPage(pageId);
    setPreference("sidebar_view", "files");
  }, [allPages, selectPage, setPreference]);

  const handleToggleTag = useCallback((tag: string) => {
    setMemoTagFilter(memoTagFilter === tag ? null : tag);
    setMemoQuickFilter("all");
  }, [memoTagFilter, setMemoQuickFilter, setMemoTagFilter]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await listMemos({
        limit: 30,
        cursor: nextCursor,
        filter: memoQuickFilter,
        tag: memoTagFilter,
        q: streamQuery,
      });
      setMemos((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...prev, ...res.memos.filter((m) => !seen.has(m.id))];
      });
      setNextCursor(res.nextCursor);
      setHasMore(res.hasMore);
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "加载更多失败。", "error");
    } finally {
      setLoadingMore(false);
    }
  };

  const handleUploadFiles = async (files: FileList | File[]) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      try {
        const stored = await uploadMemoImage(file);
        const roots = orderedBlocks(composerTreeRef.current, null);
        const last = roots.at(-1);
        const blockId = createId("block");
        const order = (last?.order ?? 0) + BLOCK_ORDER_STEP;
        const imgBlock = createBlock(blockId, "text", {
          order,
          content: [{ text: MENTION_CHAR, mention: { kind: "image", file: stored } }],
        });
        setComposerTree((prev) => ({ by_id: { ...prev.by_id, [blockId]: imgBlock } }));
      } catch (reason) {
        toast(reason instanceof Error ? reason.message : "图片上传失败。", "error");
      }
    }
  };

  const submitComposer = useCallback(async () => {
    if (submitting) return;
    const latest = composerTreeRef.current;
    if (!hasTreeContent(latest)) {
      setComposerShake(false);
      requestAnimationFrame(() => setComposerShake(true));
      toast("请输入闪念内容或附加图片", "info");
      return;
    }
    setSubmitting(true);
    try {
      const created = await createMemo({ blockTree: latest }) as MemoDto;
      setComposerTree(freshBlankTree());
      setComposerEpoch((epoch) => epoch + 1);
      setTagPickerOpen(false);
      setMentionPickerOpen(false);
      setFlashMemoId(created.id);
      window.setTimeout(() => setFlashMemoId(null), 1400);
      bumpMemoRefresh();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "发送闪念失败。", "error");
    } finally {
      setSubmitting(false);
    }
  }, [bumpMemoRefresh, submitting, toast]);

  const handleComposerShortcut = useCallback((event: ReactKeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      void submitComposer();
      return true;
    }
    return false;
  }, [submitComposer]);

  const togglePinMemo = async (memo: MemoDto) => {
    try {
      const updated = await updateMemo(memo.id, { pinned: !memo.pinned }) as MemoDto;
      setMemos((prev) => prev.map((item) => (item.id === memo.id ? updated : item)));
      bumpMemoRefresh();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "更新置顶状态失败。", "error");
    }
  };

  const startEditMemo = useCallback((memo: MemoDto) => {
    setExpandedLong((prev) => (prev[memo.id] ? prev : { ...prev, [memo.id]: true }));
    const cloned = structuredClone(memo.blockTree);
    setEditingMemo({ memo, tree: cloned, baseSig: treeSignature(cloned) });
  }, []);

  const commitEditMemo = useCallback(async () => {
    const current = editingMemoRef.current;
    if (!current || savingMemoIdRef.current === current.memo.id) return;
    const nextSig = treeSignature(current.tree);
    if (nextSig === current.baseSig) {
      setEditingMemo((curr) => (curr?.memo.id === current.memo.id ? null : curr));
      return;
    }
    if (!hasTreeContent(current.tree)) {
      setEditingMemo((curr) => (curr?.memo.id === current.memo.id ? null : curr));
      toast("闪念内容不能为空。", "error");
      return;
    }
    savingMemoIdRef.current = current.memo.id;
    setEditingMemo((curr) => (curr?.memo.id === current.memo.id ? null : curr));
    try {
      const updated = await updateMemo(current.memo.id, { blockTree: current.tree }) as MemoDto;
      setMemos((prev) => prev.map((item) => (item.id === current.memo.id ? updated : item)));
      bumpMemoRefresh();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "保存修改失败。", "error");
    } finally {
      if (savingMemoIdRef.current === current.memo.id) savingMemoIdRef.current = null;
    }
  }, [bumpMemoRefresh, toast]);

  const handleEditMemoShortcut = useCallback((event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      setEditingMemo(null);
      return true;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      void commitEditMemo();
      return true;
    }
    return false;
  }, [commitEditMemo]);

  const editingMemoPage = useMemo(
    () => (editingMemo ? makeStandalonePage(`memo-edit-${editingMemo.memo.id}`, editingMemo.tree) : null),
    [editingMemo],
  );

  const toggleTodoBlock = async (memo: MemoDto, blockId: string, nextChecked: boolean) => {
    const existingBlock = memo.blockTree.by_id[blockId];
    if (!existingBlock || existingBlock.kind !== "todo") return;
    const nextTree: BlockTree = {
      by_id: {
        ...memo.blockTree.by_id,
        [blockId]: { ...existingBlock, checked: nextChecked },
      },
    };
    try {
      const updated = await updateMemo(memo.id, { blockTree: nextTree }) as MemoDto;
      setMemos((prev) => prev.map((item) => (item.id === memo.id ? updated : item)));
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "更新待办状态失败。", "error");
    }
  };

  const handleTrashMemo = async (memo: MemoDto) => {
    try {
      await trashMemo(memo.id);
      setMemos((prev) => prev.filter((item) => item.id !== memo.id));
      bumpMemoRefresh();
      toast("已移入回收站", "info");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "移入回收站失败。", "error");
    }
  };

  const submitComment = async (memoId: string) => {
    const draft = (commentDrafts[memoId] ?? "").trim();
    if (!draft) return;
    try {
      const created = await createMemo({ markdown: draft, parentId: memoId }) as MemoCommentDto;
      setCommentDrafts((prev) => ({ ...prev, [memoId]: "" }));
      setExpandedComments((prev) => ({ ...prev, [memoId]: true }));
      setMemos((prev) => prev.map((item) => (item.id === memoId ? {
        ...item,
        comments: [...item.comments, created],
        commentCount: item.commentCount + 1,
      } : item)));
      bumpMemoRefresh();
      toast("批注已添加，原卡片位置不变", "success");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "发送批注失败。", "error");
    }
  };

  const startEditComment = useCallback((memoId: string, comment: MemoCommentDto) => {
    const cloned = structuredClone(comment.blockTree);
    setEditingComment({ memoId, comment, tree: cloned, baseSig: treeSignature(cloned) });
  }, []);

  const commitEditComment = useCallback(async () => {
    const current = editingCommentRef.current;
    if (!current || savingCommentIdRef.current === current.comment.id) return;
    const nextSig = treeSignature(current.tree);
    if (nextSig === current.baseSig) {
      setEditingComment((curr) => (curr?.comment.id === current.comment.id ? null : curr));
      return;
    }
    if (!hasTreeContent(current.tree)) {
      setEditingComment((curr) => (curr?.comment.id === current.comment.id ? null : curr));
      toast("批注内容不能为空。", "error");
      return;
    }
    savingCommentIdRef.current = current.comment.id;
    setEditingComment((curr) => (curr?.comment.id === current.comment.id ? null : curr));
    try {
      const updated = await updateMemo(current.comment.id, { blockTree: current.tree }) as MemoCommentDto;
      setMemos((prev) => prev.map((item) => (item.id === current.memoId ? {
        ...item,
        comments: item.comments.map((c) => (c.id === current.comment.id ? updated : c)),
      } : item)));
      bumpMemoRefresh();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "更新批注失败。", "error");
    } finally {
      if (savingCommentIdRef.current === current.comment.id) savingCommentIdRef.current = null;
    }
  }, [bumpMemoRefresh, toast]);

  const handleEditCommentShortcut = useCallback((event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      setEditingComment(null);
      return true;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      void commitEditComment();
      return true;
    }
    return false;
  }, [commitEditComment]);

  const editingCommentPage = useMemo(
    () => (editingComment ? makeStandalonePage(`memo-comment-edit-${editingComment.comment.id}`, editingComment.tree) : null),
    [editingComment],
  );

  const removeComment = async (memoId: string, commentId: string) => {
    try {
      await trashMemo(commentId);
      setMemos((prev) => prev.map((item) => (item.id === memoId ? {
        ...item,
        comments: item.comments.filter((c) => c.id !== commentId),
        commentCount: Math.max(0, item.commentCount - 1),
      } : item)));
      bumpMemoRefresh();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "删除批注失败。", "error");
    }
  };

  const confirmPromote = async () => {
    if (!promoteTarget || promoting) return;
    setPromoting(true);
    try {
      const res = await promoteMemo(promoteTarget.id, promoteTitle.trim() || undefined);
      setPromoteTarget(null);
      bumpMemoRefresh();
      await openLocatedPage(res.page.id);
      setPreference("sidebar_view", "files");
      toast(`已转为正式页面「${res.page.title}」`, "success");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "转为正式页面失败。", "error");
    } finally {
      setPromoting(false);
    }
  };

  const filterTabs: Array<{ id: MemoQuickFilter; label: string; count: number }> = [
    { id: "all", label: "全部", count: counts.all },
    { id: "pinned", label: "已置顶", count: counts.pinned },
    { id: "commented", label: "有批注", count: counts.commented },
    { id: "untagged", label: "无标签", count: counts.untagged },
  ];

  const composerHasContent = hasTreeContent(composerTree);

  return (
    <div className="memo-stream-shell">
      <header className="topbar">
        <div className="topbar__crumbs">
          <button
            type="button"
            className={`crumb ${!memoTagFilter ? "is-current" : ""}`}
            onClick={() => { setMemoTagFilter(null); setMemoQuickFilter("all"); }}
          >
            <span className="crumb__icon" aria-hidden="true"><Zap size={14} /></span>
            <span className="crumb__label">闪念</span>
          </button>
          {memoTagFilter ? (
            <>
              <span className="crumb__sep">/</span>
              <button
                type="button"
                className="crumb is-current"
                title="清除标签筛选"
                onClick={() => setMemoTagFilter(null)}
              >
                <span className="crumb__label">#{memoTagFilter}</span>
                <X size={13} />
              </button>
            </>
          ) : null}
        </div>
        <div className="topbar__actions" />
      </header>

      <main ref={attachSurface} className="page-surface scroller memo-page-surface" aria-label="闪念卡片流">
        <div className="memo-col">
          <div className="memo-head">
            <h1 className="memo-head__title">{memoTagFilter ? `#${memoTagFilter}` : "闪念"}</h1>
            {memoTagFilter || memoQuickFilter !== "all" || streamQuery.trim() ? (
              <span className="memo-head__count">共 {memos.length} 条</span>
            ) : counts.all > 0 ? (
              <span className="memo-head__count">{counts.all} 条</span>
            ) : null}
          </div>

          <section
            ref={composerWrapRef}
            className={`memo-composer ${composerShake ? "is-shake" : ""}`}
            aria-label="闪念速记框"
          >
            <DocumentEditor
              key={`composer-${composerEpoch}`}
              page={composerPage}
              standalone={{
                compact: true,
                onTreeChange: setComposerTree,
                onShortcut: handleComposerShortcut,
                onFollowLink: handleFollowLink,
              }}
            />

            {tagPickerOpen ? (
              <div className="memo-suggest-pop" role="listbox" aria-label="已有标签补全">
                <div className="menu__section-title">插入标签</div>
                {allTagPaths.length ? allTagPaths.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="menu__item"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      const res = appendInlineToLastBlock(composerTreeRef.current, [{ text: ` #${tag} ` }]);
                      setComposerTree(res.tree);
                      setTagPickerOpen(false);
                      focusComposerBlock(res.focusId);
                    }}
                  >
                    #{tag}
                  </button>
                )) : (
                  <button
                    type="button"
                    className="menu__item"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      const res = appendInlineToLastBlock(composerTreeRef.current, [{ text: " #" }]);
                      setComposerTree(res.tree);
                      setTagPickerOpen(false);
                      focusComposerBlock(res.focusId);
                    }}
                  >
                    输入 #新标签
                  </button>
                )}
              </div>
            ) : null}

            {mentionPickerOpen ? (
              <div className="memo-suggest-pop" role="listbox" aria-label="引用页面">
                <div className="menu__section-title">选择要引用的页面</div>
                {personalPages.length ? personalPages.slice(0, 12).map((page: NotePage) => {
                  const title = pageName(page) || "Untitled";
                  return (
                    <button
                      key={page.id}
                      type="button"
                      className="menu__item"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        const res = appendInlineToLastBlock(composerTreeRef.current, [
                          { text: MENTION_CHAR, mention: { kind: "page", page_id: page.id } },
                          { text: " " },
                        ]);
                        setComposerTree(res.tree);
                        setMentionPickerOpen(false);
                        focusComposerBlock(res.focusId);
                      }}
                    >
                      <span className="menu__label">{title}</span>
                    </button>
                  );
                }) : <p className="menu__note">个人空间还没有其他页面</p>}
              </div>
            ) : null}

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files?.length) void handleUploadFiles(event.target.files);
                event.target.value = "";
              }}
            />

            <div className="memo-composer__foot">
              <div className="memo-composer__tools">
                <button
                  type="button"
                  className="btn"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setMentionPickerOpen(false);
                    setTagPickerOpen((open) => !open);
                  }}
                >
                  <Hash size={13} /><span>标签</span>
                </button>
                <button
                  type="button"
                  className="btn"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    const res = appendBlockKindToTree(composerTreeRef.current, "todo");
                    setComposerTree(res.tree);
                    focusComposerBlock(res.focusId);
                  }}
                >
                  <CheckSquare size={13} /><span>待办</span>
                </button>
                <button
                  type="button"
                  className="btn"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setTagPickerOpen(false);
                    setMentionPickerOpen((open) => !open);
                  }}
                >
                  <AtSign size={13} /><span>引用</span>
                </button>
                <button
                  type="button"
                  className="btn"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImageIcon size={13} /><span>图片</span>
                </button>
              </div>
              <div className="memo-composer__submit">
                <kbd className="memo-kbd" aria-hidden="true">⌘↵</kbd>
                <button
                  type="button"
                  className={`btn btn--primary ${composerHasContent ? "" : "is-idle"}`}
                  disabled={submitting}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void submitComposer()}
                >
                  发送
                </button>
              </div>
            </div>
          </section>

          <div className="memo-toolbar" role="toolbar" aria-label="闪念筛选">
            <div className="memo-toolbar__tabs" role="tablist">
              {filterTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={memoQuickFilter === tab.id}
                  className={`memo-tab ${memoQuickFilter === tab.id ? "is-active" : ""}`}
                  onClick={() => setMemoQuickFilter(tab.id)}
                >
                  <span>{tab.label}</span>
                  {(tab.id === "all" || tab.count > 0) ? (
                    <span className="memo-tab__num">{tab.count}</span>
                  ) : null}
                </button>
              ))}
            </div>
            <div className="memo-search">
              <Search size={13} aria-hidden="true" />
              <input
                type="text"
                value={streamQuery}
                placeholder="搜索闪念…"
                aria-label="过滤闪念"
                onChange={(event) => setStreamQuery(event.target.value)}
              />
              {streamQuery ? (
                <button type="button" className="icon-btn icon-btn--sm" aria-label="清除搜索" onClick={() => setStreamQuery("")}>
                  <X size={12} />
                </button>
              ) : null}
            </div>
          </div>

          {allTagPaths.length ? (
            <div className="memo-mobile-tags" aria-label="移动端标签筛选">
              <button
                type="button"
                className={`memo-mobile-tag-pill ${!memoTagFilter ? "is-active" : ""}`}
                onClick={() => setMemoTagFilter(null)}
              >
                全部标签
              </button>
              {allTagPaths.map((path) => (
                <button
                  key={path}
                  type="button"
                  className={`memo-mobile-tag-pill ${memoTagFilter === path ? "is-active" : ""}`}
                  onClick={() => setMemoTagFilter(memoTagFilter === path ? null : path)}
                >
                  #{path}
                </button>
              ))}
            </div>
          ) : null}

          {loading ? (
            <div className="page-loading" aria-busy="true">
              <span className="page-loading__line" />
              <span className="page-loading__line" />
              <span className="page-loading__line" />
            </div>
          ) : memos.length ? (
            <div className="memo-feed">
              {memos.map((memo) => {
                const isEditing = editingMemo?.memo.id === memo.id;
                const blockCount = orderedBlocks(memo.blockTree).length;
                const isLong = blockCount > 6 || memo.text.length > 260;
                const isLongExpanded = Boolean(expandedLong[memo.id]);
                const isCommentsOpen = Boolean(expandedComments[memo.id]);

                return (
                  <article
                    key={memo.id}
                    id={`memo-card-${memo.id}`}
                    className={`memo-entry ${memo.pinned ? "is-pinned" : ""} ${isEditing ? "is-editing" : ""} ${flashMemoId === memo.id ? "history-flash" : ""}`}
                  >
                    <div className="memo-entry__head">
                      <div className="memo-entry__meta">
                        <time dateTime={memo.createdAt} title={fullTimestamp(memo.createdAt)}>{formatTimestamp(memo.createdAt)}</time>
                        {memo.pinned ? (
                          <span className="memo-pin-mark">
                            <Pin size={11} /> 置顶
                          </span>
                        ) : null}
                      </div>
                      <div className="memo-entry__actions">
                        <button
                          type="button"
                          className="icon-btn icon-btn--sm"
                          aria-label="批注"
                          title="批注"
                          onClick={() => {
                            setExpandedComments((prev) => ({ ...prev, [memo.id]: true }));
                            requestAnimationFrame(() => document.getElementById(`memo-comment-input-${memo.id}`)?.focus());
                          }}
                        >
                          <MessageSquare size={14} />
                        </button>
                        <button
                          type="button"
                          className={`icon-btn icon-btn--sm ${memo.pinned ? "is-on" : ""}`}
                          aria-label={memo.pinned ? "已置顶" : "置顶"}
                          title={memo.pinned ? "取消置顶" : "置顶"}
                          onClick={() => void togglePinMemo(memo)}
                        >
                          <Pin size={14} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn icon-btn--sm"
                          aria-label="编辑"
                          title="编辑"
                          onClick={() => startEditMemo(memo)}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn icon-btn--sm"
                          aria-label="转为正式页面"
                          title="转为正式页面"
                          onClick={() => {
                            setPromoteTarget(memo);
                            setPromoteTitle(memo.summary || memoSummaryTitle(memo.text));
                          }}
                        >
                          <ArrowUpRight size={14} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn icon-btn--sm is-danger"
                          aria-label="删除"
                          title="移入回收站"
                          onClick={() => void handleTrashMemo(memo)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>

                    {isEditing && editingMemoPage ? (
                      <div className="memo-inline-edit" aria-label="编辑闪念">
                        <DocumentEditor
                          page={editingMemoPage}
                          standalone={{
                            compact: true,
                            autoFocus: true,
                            onTreeChange: (nextTree) => {
                              setEditingMemo((prev) => (prev && prev.memo.id === memo.id ? { ...prev, tree: nextTree } : prev));
                            },
                            onBlurOutside: () => { void commitEditMemo(); },
                            onShortcut: handleEditMemoShortcut,
                            onFollowLink: handleFollowLink,
                          }}
                        />
                        <div className="memo-inline-edit__foot">
                          <span className="memo-inline-edit__hint">Esc 取消 · 支持 / 命令与 Markdown · 失焦自动保存</span>
                          <div className="memo-inline-edit__actions">
                            <button
                              type="button"
                              className="btn"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => setEditingMemo(null)}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              className="btn btn--primary"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => void commitEditMemo()}
                            >
                              完成
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div
                          className={`memo-body ${isLong && !isLongExpanded ? "is-collapsed" : ""}`}
                          onClick={(event) => {
                            if (window.getSelection()?.toString()) return;
                            if ((event.target as HTMLElement).closest("button, a, input")) return;
                            startEditMemo(memo);
                          }}
                        >
                          <MemoBlocksView
                            tree={memo.blockTree}
                            pages={allPages}
                            onToggleTag={handleToggleTag}
                            onFollowLink={handleFollowLink}
                            onPreviewImage={setPreviewFile}
                            onToggleTodo={(blockId, checked) => void toggleTodoBlock(memo, blockId, checked)}
                          />
                        </div>
                        {isLong ? (
                          <button
                            type="button"
                            className="memo-expand-toggle"
                            onClick={() => setExpandedLong((prev) => ({ ...prev, [memo.id]: !prev[memo.id] }))}
                          >
                            {isLongExpanded ? "收起内容" : "展开全文"}
                          </button>
                        ) : null}
                      </>
                    )}

                    {memo.comments.length > 0 && !isCommentsOpen ? (
                      <button
                        type="button"
                        className="memo-comment-summary"
                        onClick={() => setExpandedComments((prev) => ({ ...prev, [memo.id]: true }))}
                      >
                        <MessageSquare size={12} />
                        <span>
                          {memo.comments.length} 条批注 · {formatTimestamp(memo.comments[memo.comments.length - 1].createdAt)}
                        </span>
                      </button>
                    ) : isCommentsOpen ? (
                      <div className="memo-comment-thread">
                        <div className="memo-comment-thread__head">
                          <span>批注（{memo.comments.length} · 原卡片排序不变）</span>
                          <button
                            type="button"
                            className="btn"
                            style={{ minHeight: 22, padding: "0 6px", fontSize: 12 }}
                            onClick={() => setExpandedComments((prev) => ({ ...prev, [memo.id]: false }))}
                          >
                            收起
                          </button>
                        </div>
                        {memo.comments.map((comment) => {
                          const isEditingC = editingComment?.comment.id === comment.id;
                          return (
                            <div
                              key={comment.id}
                              id={`memo-comment-${comment.id}`}
                              className={`memo-comment-item ${isEditingC ? "is-editing" : ""} ${flashCommentId === comment.id ? "history-flash" : ""}`}
                            >
                              <div className="memo-comment-item__top">
                                <time dateTime={comment.createdAt} title={fullTimestamp(comment.createdAt)}>{formatTimestamp(comment.createdAt)}</time>
                                <span className="memo-comment-item__actions">
                                  <button
                                    type="button"
                                    className="icon-btn icon-btn--sm"
                                    aria-label="编辑批注"
                                    onClick={() => startEditComment(memo.id, comment)}
                                  >
                                    <Pencil size={12} />
                                  </button>
                                  <button
                                    type="button"
                                    className="icon-btn icon-btn--sm"
                                    aria-label="删除批注"
                                    onClick={() => void removeComment(memo.id, comment.id)}
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                </span>
                              </div>
                              {isEditingC && editingCommentPage ? (
                                <div className="memo-inline-edit memo-inline-edit--comment" aria-label="编辑批注内容">
                                  <DocumentEditor
                                    page={editingCommentPage}
                                    standalone={{
                                      compact: true,
                                      autoFocus: true,
                                      onTreeChange: (nextTree) => {
                                        setEditingComment((prev) => (prev && prev.comment.id === comment.id ? { ...prev, tree: nextTree } : prev));
                                      },
                                      onBlurOutside: () => { void commitEditComment(); },
                                      onShortcut: handleEditCommentShortcut,
                                      onFollowLink: handleFollowLink,
                                    }}
                                  />
                                  <div className="memo-inline-edit__foot">
                                    <span className="memo-inline-edit__hint">Esc 取消 · 失焦保存</span>
                                    <div className="memo-inline-edit__actions">
                                      <button
                                        type="button"
                                        className="btn"
                                        onMouseDown={(event) => event.preventDefault()}
                                        onClick={() => setEditingComment(null)}
                                      >
                                        取消
                                      </button>
                                      <button
                                        type="button"
                                        className="btn btn--primary"
                                        onMouseDown={(event) => event.preventDefault()}
                                        onClick={() => void commitEditComment()}
                                      >
                                        完成
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              ) : (
                                <div
                                  className="memo-comment-item__body"
                                  onClick={(event) => {
                                    if (window.getSelection()?.toString()) return;
                                    if ((event.target as HTMLElement).closest("button, a, input")) return;
                                    startEditComment(memo.id, comment);
                                  }}
                                >
                                  <MemoBlocksView
                                    tree={comment.blockTree}
                                    pages={allPages}
                                    compact
                                    interactiveTodo={false}
                                    onToggleTag={handleToggleTag}
                                    onFollowLink={handleFollowLink}
                                    onPreviewImage={setPreviewFile}
                                  />
                                </div>
                              )}
                            </div>
                          );
                        })}

                        <div className="memo-comment-composer">
                          <textarea
                            id={`memo-comment-input-${memo.id}`}
                            rows={1}
                            placeholder="添加批注… (⌘+Enter 发送)"
                            aria-label="添加批注"
                            value={commentDrafts[memo.id] ?? ""}
                            onChange={(event) => setCommentDrafts((prev) => ({ ...prev, [memo.id]: event.target.value }))}
                            onKeyDown={(event) => {
                              if (!imeComposing(event) && (event.metaKey || event.ctrlKey) && event.key === "Enter") {
                                event.preventDefault();
                                void submitComment(memo.id);
                              }
                            }}
                          />
                          <button type="button" className="btn btn--primary" onClick={() => void submitComment(memo.id)}>
                            发送
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </article>
                );
              })}

              {hasMore ? (
                <div className="memo-load-more">
                  <button type="button" className="btn btn--outline" disabled={loadingMore} onClick={() => void loadMore()}>
                    {loadingMore ? "正在加载…" : "加载更早的闪念"}
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="memo-empty">
              <p>当前筛选下还没有闪念</p>
              <p style={{ fontSize: 12.5 }}>在上方直接写下想法发出，或清除标签筛选</p>
            </div>
          )}
        </div>
      </main>

      <Modal open={Boolean(promoteTarget)} label="转为正式页面" onClose={() => setPromoteTarget(null)} className="memo-modal">
        <h2>转为正式页面</h2>
        <input
          className="memo-modal__input"
          autoFocus
          aria-label="正式页面标题"
          value={promoteTitle}
          onChange={(event) => setPromoteTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void confirmPromote();
            }
          }}
        />
        <div className="memo-modal__note">
          <div>• 原记录 ID 保持不变，既有页面引用不断链。</div>
          <div>• 转正后将移入「全部页面」并参与关系图谱连线。</div>
          {promoteTarget?.commentCount ? (
            <div>• 卡片下 {promoteTarget.commentCount} 条批注将按时间线附入新页面正文末尾。</div>
          ) : null}
        </div>
        <div className="memo-modal__actions">
          <button type="button" className="btn" onClick={() => setPromoteTarget(null)}>取消</button>
          <button type="button" className="btn btn--primary" disabled={promoting} onClick={() => void confirmPromote()}>
            确认转正
          </button>
        </div>
      </Modal>

      <Modal open={Boolean(previewFile)} label="图片预览" onClose={() => setPreviewFile(null)} className="memo-lightbox">
        {previewFile ? <img src={memoFileUrl(previewFile)} alt={previewFile.name} /> : null}
      </Modal>
    </div>
  );
}
