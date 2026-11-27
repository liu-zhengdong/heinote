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
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useUi, type MemoQuickFilter } from "../../app/ui-context";
import { useWorkspace } from "../../app/workspace-context";
import { useWorkspaceState } from "../../app/workspace-store";
import { Modal } from "../../components/Modal";
import { pageName } from "../../core/block-tree";
import { imeComposing } from "../../core/keyboard";
import { memoSummaryTitle, normalizeMemoTag, type MemoTagNode } from "../../core/memos";
import { inTrash, isPurging, isShelved } from "../../core/page-tree";
import { pagesInSpace } from "../../core/space-navigation";
import type { NotePage, StoredFile } from "../../core/types";
import {
  createMemo,
  listMemos,
  listMemoTags,
  memoFileUrl,
  promoteMemo,
  restoreMemo,
  trashMemo,
  updateMemo,
  uploadMemoImage,
  type MemoCommentDto,
  type MemoCounts,
  type MemoDto,
} from "./memo-api";
import "./memos.css";

const EMPTY_COUNTS: MemoCounts = { all: 0, pinned: 0, commented: 0, untagged: 0, trashed: 0 };

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 16).replace("T", " ");
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function flattenTagPaths(nodes: MemoTagNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    out.push(node.path);
    if (node.children.length) flattenTagPaths(node.children, out);
  }
  return out;
}

const IMAGE_LINE_RE = /^!\[[^\]]*\]\([^)]*\)\s*$/;

function stripAttachmentLines(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => !IMAGE_LINE_RE.test(line.trim()))
    .join("\n")
    .trim();
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

  // Composer state
  const [composerText, setComposerText] = useState("");
  const [composerFiles, setComposerFiles] = useState<StoredFile[]>([]);
  const [composerMentions, setComposerMentions] = useState<Map<string, string>>(() => new Map());
  const [submitting, setSubmitting] = useState(false);
  const [composerShake, setComposerShake] = useState(false);
  const [tagSuggest, setTagSuggest] = useState<{ start: number; items: string[]; index: number } | null>(null);
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Card states
  const [expandedComments, setExpandedComments] = useState<Record<string, boolean>>({});
  const [expandedLong, setExpandedLong] = useState<Record<string, boolean>>({});
  const [editingMemoId, setEditingMemoId] = useState<string | null>(null);
  const [editingMemoText, setEditingMemoText] = useState("");
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [editingComment, setEditingComment] = useState<{ memoId: string; commentId: string; text: string } | null>(null);
  const [promoteTarget, setPromoteTarget] = useState<MemoDto | null>(null);
  const [promoteTitle, setPromoteTitle] = useState("");
  const [promoting, setPromoting] = useState(false);
  const [previewFile, setPreviewFile] = useState<StoredFile | null>(null);
  const [flashMemoId, setFlashMemoId] = useState<string | null>(null);
  const [flashCommentId, setFlashCommentId] = useState<string | null>(null);

  const surfaceRef = useRef<HTMLElement | null>(null);
  const attachSurface = useCallback((el: HTMLElement | null) => {
    surfaceRef.current = el;
    onSurfaceRef?.(el);
  }, [onSurfaceRef]);

  const loadStream = useCallback((aroundId?: string) => {
    const controller = new AbortController();
    setLoading(true);
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
        setMemos(listRes.memos);
        setCounts(listRes.counts);
        setNextCursor(listRes.nextCursor);
        setHasMore(listRes.hasMore);
        setAllTagPaths(flattenTagPaths(tagRes.tags));
        setLoading(false);
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setLoading(false);
        toast(reason instanceof Error ? reason.message : "加载闪念失败。", "error");
      });
    return () => controller.abort();
  }, [memoQuickFilter, memoTagFilter, streamQuery, toast]);

  useEffect(() => loadStream(memoTarget?.memoId), [loadStream, memoRefreshNonce, memoTarget?.memoId]);

  useEffect(() => {
    if (!memoFocusNonce) return;
    surfaceRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    window.setTimeout(() => composerRef.current?.focus(), 60);
  }, [memoFocusNonce]);

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

  // Resolve `@PageTitle` placeholders back into `[[page:<id>]]` tokens on save.
  const prepareMarkdownForSave = (raw: string, mentionMap: ReadonlyMap<string, string>): { markdown: string; mentionPageIds: string[] } => {
    let out = raw;
    const ids: string[] = [];
    const entries = [...mentionMap.entries()].sort((left, right) => right[0].length - left[0].length);
    for (const [title, pageId] of entries) {
      const token = `@${title}`;
      if (!out.includes(token)) continue;
      out = out.split(token).join(`[[page:${pageId}]]`);
      ids.push(pageId);
    }
    return { markdown: out, mentionPageIds: ids };
  };

  const updateTagSuggest = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const match = before.match(/(?:^|[\s(（])#([^\s#]*)$/);
    if (!match) { setTagSuggest(null); return; }
    const needle = match[1].toLowerCase();
    const start = before.length - match[1].length - 1;
    const items = allTagPaths.filter((path) => path.toLowerCase().includes(needle));
    if (!items.length) { setTagSuggest(null); return; }
    setTagSuggest({ start, items, index: 0 });
  };

  const applyTagSuggest = (tag: string) => {
    const textarea = composerRef.current;
    if (!textarea || !tagSuggest) return;
    const caret = textarea.selectionStart;
    const next = composerText.slice(0, tagSuggest.start) + `#${tag} ` + composerText.slice(caret);
    setComposerText(next);
    setTagSuggest(null);
    const nextPos = tagSuggest.start + tag.length + 2;
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextPos, nextPos);
    });
  };

  const insertSnippet = (snippet: string) => {
    const textarea = composerRef.current;
    if (!textarea) {
      setComposerText((prev) => prev + snippet);
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const next = composerText.slice(0, start) + snippet + composerText.slice(end);
    setComposerText(next);
    const nextPos = start + snippet.length;
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextPos, nextPos);
      updateTagSuggest(next, nextPos);
    });
  };

  const handleUploadFiles = async (files: FileList | File[]) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      try {
        const stored = await uploadMemoImage(file);
        setComposerFiles((prev) => [...prev, stored]);
      } catch (reason) {
        toast(reason instanceof Error ? reason.message : "图片上传失败。", "error");
      }
    }
  };

  const handleComposerPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = event.clipboardData?.files;
    if (files?.length) {
      const images = [...files].filter((file) => file.type.startsWith("image/"));
      if (images.length) {
        event.preventDefault();
        void handleUploadFiles(images);
      }
    }
  };

  const submitComposer = async () => {
    if (submitting) return;
    const trimmed = composerText.trim();
    if (!trimmed && !composerFiles.length) {
      setComposerShake(false);
      requestAnimationFrame(() => setComposerShake(true));
      toast("请输入闪念内容或附加图片", "info");
      return;
    }
    setSubmitting(true);
    try {
      const { markdown, mentionPageIds } = prepareMarkdownForSave(composerText, composerMentions);
      const created = await createMemo({
        markdown,
        ...(composerFiles.length ? { attachments: composerFiles } : {}),
        ...(mentionPageIds.length ? { mentionPageIds } : {}),
      }) as MemoDto;
      setComposerText("");
      setComposerFiles([]);
      setComposerMentions(new Map());
      setTagSuggest(null);
      setFlashMemoId(created.id);
      window.setTimeout(() => setFlashMemoId(null), 1400);
      bumpMemoRefresh();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "发送闪念失败。", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (imeComposing(event)) return;
    if (tagSuggest) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setTagSuggest((prev) => (prev ? { ...prev, index: (prev.index + 1) % prev.items.length } : null));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setTagSuggest((prev) => (prev ? { ...prev, index: (prev.index - 1 + prev.items.length) % prev.items.length } : null));
        return;
      }
      if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        applyTagSuggest(tagSuggest.items[tagSuggest.index]);
        return;
      }
      if (event.key === "Escape") {
        setTagSuggest(null);
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void submitComposer();
    }
  };

  const togglePinMemo = async (memo: MemoDto) => {
    try {
      await updateMemo(memo.id, { pinned: !memo.pinned });
      bumpMemoRefresh();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "更新置顶状态失败。", "error");
    }
  };

  const saveEditMemo = async (memo: MemoDto) => {
    const clean = editingMemoText.trim();
    if (!clean && !memo.attachments.length) {
      toast("闪念内容不能为空。", "error");
      return;
    }
    try {
      await updateMemo(memo.id, { markdown: editingMemoText, attachments: memo.attachments });
      setEditingMemoId(null);
      bumpMemoRefresh();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "保存修改失败。", "error");
    }
  };

  const toggleTodoLine = async (memo: MemoDto, lineIndex: number, nextChecked: boolean) => {
    const lines = stripAttachmentLines(memo.markdown).split("\n");
    const line = lines[lineIndex];
    if (!line) return;
    lines[lineIndex] = nextChecked
      ? line.replace(/^(\s*[-*+]\s+)\[[ xX]\]/, "$1[x]")
      : line.replace(/^(\s*[-*+]\s+)\[[ xX]\]/, "$1[ ]");
    const nextMarkdown = lines.join("\n");
    try {
      const updated = await updateMemo(memo.id, { markdown: nextMarkdown, attachments: memo.attachments }) as MemoDto;
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

  const saveEditComment = async () => {
    if (!editingComment) return;
    const trimmed = editingComment.text.trim();
    if (!trimmed) return;
    try {
      const updated = await updateMemo(editingComment.commentId, { markdown: trimmed }) as MemoCommentDto;
      setMemos((prev) => prev.map((item) => (item.id === editingComment.memoId ? {
        ...item,
        comments: item.comments.map((c) => (c.id === editingComment.commentId ? updated : c)),
      } : item)));
      setEditingComment(null);
      bumpMemoRefresh();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "更新批注失败。", "error");
    }
  };

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

  const renderInlineSegment = (segment: string, mentions: ReadonlyArray<{ pageId: string; title: string }>): ReactNode[] => {
    const out: ReactNode[] = [];
    const tagRe = /(^|[\s(（\[【])#([^\s#.,，。!?！？:：;；)）\]】`'"\\]{1,40})/g;
    let cursor = 0;
    let match: RegExpExecArray | null;
    let keyIndex = 0;

    const pushWithMentions = (plain: string) => {
      if (!mentions.length || !plain) {
        if (plain) out.push(plain);
        return;
      }
      // Match page titles inserted via @mention.
      const matchedMention = mentions.find((m) => plain.includes(m.title));
      if (!matchedMention) {
        out.push(plain);
        return;
      }
      const idx = plain.indexOf(matchedMention.title);
      if (idx > 0) pushWithMentions(plain.slice(0, idx));
      out.push(
        <button
          key={`mention-${keyIndex++}`}
          type="button"
          className="memo-mention-chip"
          onClick={() => {
            selectPage(matchedMention.pageId);
            setPreference("sidebar_view", "files");
          }}
        >
          {matchedMention.title}
        </button>,
      );
      if (idx + matchedMention.title.length < plain.length) {
        pushWithMentions(plain.slice(idx + matchedMention.title.length));
      }
    };

    while ((match = tagRe.exec(segment)) !== null) {
      const prefix = match[1];
      const tag = normalizeMemoTag(match[2]);
      if (!tag) continue;
      if (match.index > cursor) pushWithMentions(segment.slice(cursor, match.index));
      if (prefix) pushWithMentions(prefix);
      out.push(
        <button
          key={`tag-${keyIndex++}`}
          type="button"
          className="memo-tag-chip"
          onClick={() => {
            setMemoTagFilter(tag);
            setMemoQuickFilter("all");
          }}
        >
          #{tag}
        </button>,
      );
      cursor = match.index + match[0].length;
    }
    if (cursor < segment.length) pushWithMentions(segment.slice(cursor));
    return out;
  };

  const renderBody = (memo: MemoDto, markdown: string, isComment = false) => {
    const bodyText = stripAttachmentLines(markdown);
    const lines = bodyText.split("\n");
    return lines.map((line, lineIdx) => {
      const todoMatch = !isComment ? line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/) : null;
      if (todoMatch) {
        const checked = todoMatch[1].toLowerCase() === "x";
        return (
          <div key={lineIdx} className={`memo-todo ${checked ? "is-done" : ""}`}>
            <input
              type="checkbox"
              checked={checked}
              aria-label={todoMatch[2]}
              onChange={(event) => void toggleTodoLine(memo, lineIdx, event.target.checked)}
            />
            <span>{renderInlineSegment(todoMatch[2], memo.mentions)}</span>
          </div>
        );
      }
      if (!line.trim()) return <div key={lineIdx} className="memo-line" />;
      return <div key={lineIdx} className="memo-line">{renderInlineSegment(line, memo.mentions)}</div>;
    });
  };

  const filterTabs: Array<{ id: MemoQuickFilter; label: string; count: number }> = [
    { id: "all", label: "全部", count: counts.all },
    { id: "pinned", label: "已置顶", count: counts.pinned },
    { id: "commented", label: "有批注", count: counts.commented },
    { id: "untagged", label: "无标签", count: counts.untagged },
  ];

  // Ensure restore helper stays reachable if needed from other modules; reference to avoid unused warning.
  void restoreMemo;

  return (
    <div className="memo-stream-shell">
      <header className="topbar">
        <div className="topbar__crumbs">
          <button
            type="button"
            className="crumb is-current"
            onClick={() => { setMemoTagFilter(null); setMemoQuickFilter("all"); }}
          >
            <span className="crumb__label">闪念</span>
          </button>
          {memoTagFilter ? (
            <>
              <span className="crumb__sep">/</span>
              <button
                type="button"
                className="crumb"
                title="清除标签筛选"
                onClick={() => setMemoTagFilter(null)}
              >
                <span className="crumb__label">#{memoTagFilter}</span>
                <X size={13} />
              </button>
            </>
          ) : null}
        </div>
        <div className="topbar__actions">
          <span style={{ fontSize: 12, color: "var(--ink-3)", paddingRight: 4 }}>⌘+Enter 发送</span>
        </div>
      </header>

      <main ref={attachSurface} className="page-surface scroller memo-page-surface" aria-label="闪念卡片流">
        <div className="memo-col">
          <div className="memo-head">
            <h1 className="memo-head__title">{memoTagFilter ? `#${memoTagFilter}` : "闪念"}</h1>
          </div>

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
                  <span className="memo-tab__num">{tab.count}</span>
                </button>
              ))}
            </div>
            <div className="memo-search">
              <Search size={13} aria-hidden="true" />
              <input
                type="text"
                value={streamQuery}
                placeholder="过滤闪念…"
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

          <section className={`memo-composer ${composerShake ? "is-shake" : ""}`} aria-label="闪念速记框">
            <textarea
              ref={composerRef}
              className="memo-composer__textarea"
              placeholder="现在的想法是…（支持 #多级标签、- [ ] 待办、直接粘贴图片，⌘+Enter 发送）"
              aria-label="闪念输入框"
              value={composerText}
              onChange={(event) => {
                setComposerText(event.target.value);
                updateTagSuggest(event.target.value, event.target.selectionStart);
              }}
              onKeyDown={handleComposerKeyDown}
              onPaste={handleComposerPaste}
            />
            {composerFiles.length ? (
              <div className="memo-composer__attachments">
                {composerFiles.map((file) => (
                  <div key={file.path} className="memo-attach-chip">
                    <img src={memoFileUrl(file)} alt={file.name} />
                    <button
                      type="button"
                      className="memo-attach-chip__rm"
                      aria-label={`移除 ${file.name}`}
                      onClick={() => setComposerFiles((prev) => prev.filter((item) => item.path !== file.path))}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            {tagSuggest ? (
              <div className="memo-suggest-pop" role="listbox" aria-label="已有标签补全">
                <div className="menu__section-title">已有标签</div>
                {tagSuggest.items.map((tag, idx) => (
                  <button
                    key={tag}
                    type="button"
                    role="option"
                    aria-selected={idx === tagSuggest.index}
                    className={`menu__item ${idx === tagSuggest.index ? "is-active" : ""}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      applyTagSuggest(tag);
                    }}
                  >
                    #{tag}
                  </button>
                ))}
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
                        setComposerMentions((prev) => new Map(prev).set(title, page.id));
                        insertSnippet(`@${title} `);
                        setMentionPickerOpen(false);
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
                <button type="button" className="btn" onClick={() => insertSnippet("#")}>
                  <Hash size={13} /> 标签
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => insertSnippet(`${composerText && !composerText.endsWith("\n") ? "\n" : ""}- [ ] `)}
                >
                  <CheckSquare size={13} /> 待办
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setMentionPickerOpen((open) => !open)}
                >
                  <AtSign size={13} /> 引用
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImageIcon size={13} /> 图片
                </button>
              </div>
              <button
                type="button"
                className="btn btn--primary"
                disabled={submitting}
                onClick={() => void submitComposer()}
              >
                发送
              </button>
            </div>
          </section>

          {loading ? (
            <div className="page-loading" aria-busy="true">
              <span className="page-loading__line" />
              <span className="page-loading__line" />
              <span className="page-loading__line" />
            </div>
          ) : memos.length ? (
            <div className="memo-feed">
              {memos.map((memo) => {
                const bodyText = stripAttachmentLines(memo.markdown);
                const isEditing = editingMemoId === memo.id;
                const isLong = bodyText.split("\n").length > 6 || bodyText.length > 260;
                const isLongExpanded = Boolean(expandedLong[memo.id]);
                const isCommentsOpen = Boolean(expandedComments[memo.id]);

                return (
                  <article
                    key={memo.id}
                    id={`memo-card-${memo.id}`}
                    className={`memo-entry ${flashMemoId === memo.id ? "history-flash" : ""}`}
                  >
                    <div className="memo-entry__head">
                      <div className="memo-entry__meta">
                        <time dateTime={memo.createdAt}>{formatTimestamp(memo.createdAt)}</time>
                        {memo.pinned ? (
                          <span className="memo-pin-mark">
                            <Pin size={12} /> 置顶
                          </span>
                        ) : null}
                      </div>
                      <div className="memo-entry__actions">
                        <button
                          type="button"
                          className="btn"
                          title="批注"
                          onClick={() => {
                            setExpandedComments((prev) => ({ ...prev, [memo.id]: true }));
                            requestAnimationFrame(() => document.getElementById(`memo-comment-input-${memo.id}`)?.focus());
                          }}
                        >
                          <MessageSquare size={13} /><span>批注</span>
                        </button>
                        <button
                          type="button"
                          className={`btn ${memo.pinned ? "is-on" : ""}`}
                          title={memo.pinned ? "取消置顶" : "置顶"}
                          onClick={() => void togglePinMemo(memo)}
                        >
                          <Pin size={13} /><span>{memo.pinned ? "已置顶" : "置顶"}</span>
                        </button>
                        <button
                          type="button"
                          className="btn"
                          title="编辑"
                          onClick={() => {
                            setEditingMemoId(memo.id);
                            setEditingMemoText(bodyText);
                          }}
                        >
                          <Pencil size={13} /><span>编辑</span>
                        </button>
                        <button
                          type="button"
                          className="btn"
                          title="转为正式页面"
                          onClick={() => {
                            setPromoteTarget(memo);
                            setPromoteTitle(memo.summary || memoSummaryTitle(bodyText));
                          }}
                        >
                          <ArrowUpRight size={13} /><span>转为正式页面</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn--danger"
                          title="移入回收站"
                          onClick={() => void handleTrashMemo(memo)}
                        >
                          <Trash2 size={13} /><span>删除</span>
                        </button>
                      </div>
                    </div>

                    {isEditing ? (
                      <div className="memo-inline-edit">
                        <textarea
                          autoFocus
                          aria-label="编辑闪念"
                          value={editingMemoText}
                          onChange={(event) => setEditingMemoText(event.target.value)}
                          onKeyDown={(event) => {
                            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                              event.preventDefault();
                              void saveEditMemo(memo);
                            } else if (event.key === "Escape") {
                              setEditingMemoId(null);
                            }
                          }}
                        />
                        <div className="memo-inline-edit__bar">
                          <button type="button" className="btn" onClick={() => setEditingMemoId(null)}>取消</button>
                          <button type="button" className="btn btn--primary" onClick={() => void saveEditMemo(memo)}>保存</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className={`memo-body ${isLong && !isLongExpanded ? "is-collapsed" : ""}`}>
                          {renderBody(memo, memo.markdown)}
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

                    {memo.attachments.length ? (
                      <div className="memo-media">
                        {memo.attachments.map((file) => (
                          <button
                            key={file.path}
                            type="button"
                            className="memo-thumb"
                            title="查看大图"
                            onClick={() => setPreviewFile(file)}
                          >
                            <img src={memoFileUrl(file)} alt={file.name} />
                          </button>
                        ))}
                      </div>
                    ) : null}

                    {memo.comments.length > 0 && !isCommentsOpen ? (
                      <button
                        type="button"
                        className="memo-comment-summary"
                        onClick={() => setExpandedComments((prev) => ({ ...prev, [memo.id]: true }))}
                      >
                        <MessageSquare size={12} />
                        <span>
                          {memo.comments.length} 条批注 · 最近 {formatTimestamp(memo.comments[memo.comments.length - 1].createdAt).slice(5)}
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
                          const isEditingC = editingComment?.commentId === comment.id;
                          return (
                            <div
                              key={comment.id}
                              id={`memo-comment-${comment.id}`}
                              className={`memo-comment-item ${flashCommentId === comment.id ? "history-flash" : ""}`}
                            >
                              <div className="memo-comment-item__top">
                                <time dateTime={comment.createdAt}>{formatTimestamp(comment.createdAt)}</time>
                                <span className="memo-comment-item__actions">
                                  <button
                                    type="button"
                                    className="icon-btn icon-btn--sm"
                                    aria-label="编辑批注"
                                    onClick={() => setEditingComment({ memoId: memo.id, commentId: comment.id, text: comment.markdown })}
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
                              {isEditingC ? (
                                <div className="memo-inline-edit" style={{ marginTop: 4 }}>
                                  <textarea
                                    autoFocus
                                    style={{ minHeight: 52 }}
                                    value={editingComment.text}
                                    onChange={(event) => setEditingComment((prev) => (prev ? { ...prev, text: event.target.value } : null))}
                                  />
                                  <div className="memo-inline-edit__bar">
                                    <button type="button" className="btn" onClick={() => setEditingComment(null)}>取消</button>
                                    <button type="button" className="btn btn--primary" onClick={() => void saveEditComment()}>保存</button>
                                  </div>
                                </div>
                              ) : (
                                <div className="memo-comment-item__body">{renderBody(memo, comment.markdown, true)}</div>
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
